// Turns IDTA submodel templates, as published in JSON, into db/source/idta-submodels.json.
//
//   npm run fetch-idta                 reads the commit recorded in that file
//   npm run fetch-idta -- --latest     moves to the repository's current commit
//   npm run check-idta                 fails if that file no longer matches its source
//
// A template's latest version is read from the folders it is published in. Names and
// definitions are the publisher's: the only change is collapsing runs of whitespace.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { IDTA_REPOSITORY, IDTA_TEMPLATES } from "../src/model/idta.ts";

const OUT = new URL("../db/source/idta-submodels.json", import.meta.url);
const USER_AGENT = "dpp-validator-fetch-idta/0.1";

const args = new Set(process.argv.slice(2));
const check = args.has("--check");
const recorded = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : undefined;

const fetchOk = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
};

const api = (path) => fetchOk(`https://api.github.com/repos/${IDTA_REPOSITORY}/${path}`).then((r) => r.json());

const commitsAtHead = async () => (await api("commits/main")).sha;

const publishedFiles = async (commit) => {
  const { tree, truncated } = await api(`git/trees/${commit}?recursive=1`);
  if (truncated) throw new Error("The repository listing came back truncated.");
  return tree.map((x) => x.path).filter((p) => p.startsWith("published/") && p.endsWith(".json"));
};

/** Variants that repeat a template: for the older metamodel, without example values, or filled in as an example. */
const VARIANT = /forAASMetamodel|without_examplevalues|_Sample_|_Example_/i;

/** The newest version of the template in this folder, read from the numeric folders after it. */
function latestFile(files, folder) {
  const prefix = `published/${folder}/`;
  const found = files.flatMap((path) => {
    if (!path.startsWith(prefix) || VARIANT.test(path)) return [];
    const parts = path.slice(prefix.length).split("/");
    const version = parts.slice(0, -1);
    return version.length && version.every((v) => /^\d+$/.test(v)) ? [{ path, version: version.map(Number) }] : [];
  });
  if (!found.length) throw new Error(`No published template in ${folder}`);
  const newerFirst = (a, b) => {
    for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
      const d = (b.version[i] ?? -1) - (a.version[i] ?? -1);
      if (d) return d;
    }
    return 0;
  };
  found.sort(newerFirst);
  if (found[1] && newerFirst(found[0], found[1]) === 0) {
    throw new Error(`Two files for one version in ${folder}: ${found[0].path}, ${found[1].path}`);
  }
  return found[0];
}

const clean = (s) => s?.replace(/\s+/g, " ").trim() || undefined;

const english = (strings) => {
  const list = strings ?? [];
  const entry = list.find((x) => /^en\b/i.test(x.language ?? ""));
  return clean(entry?.text);
};

const semanticIdOf = (x) => x?.semanticId?.keys?.at(-1)?.value;

const CARDINALITY = { One: "1", ZeroToOne: "0..1", ZeroToMany: "0..*", OneToMany: "1..*" };

const cardinalityOf = (element) => {
  const q = (element.qualifiers ?? []).find((x) => /cardinality/i.test(x.type ?? ""));
  return q ? CARDINALITY[q.value] ?? clean(q.value) : undefined;
};

/** Element kinds that hold other elements, with where they hold them. */
const childrenOf = (element) => {
  if (element.modelType === "Entity") return element.statements ?? [];
  if (element.modelType === "SubmodelElementCollection" || element.modelType === "SubmodelElementList") {
    return Array.isArray(element.value) ? element.value : [];
  }
  return [];
};

function transform(document, file) {
  const concepts = new Map((document.conceptDescriptions ?? []).map((c) => [c.id, c]));
  const contentOf = (id) => concepts.get(id)?.embeddedDataSpecifications?.[0]?.dataSpecificationContent;

  /** A concept's own name and definition, and failing that the element's description. */
  const element = (raw, parentPath, index) => {
    const semanticId = semanticIdOf(raw);
    const concept = contentOf(semanticId);
    // Items of a list have no idShort, so they take their concept's or their position.
    // A trailing __00__ only marks that a template's element can repeat.
    const idShort = (raw.idShort ?? concepts.get(semanticId)?.idShort ?? `item${index + 1}`).replace(/__\d+__$/, "");
    const path = parentPath ? `${parentPath}/${idShort}` : idShort;
    const children = childrenOf(raw).map((child, i) => element(child, path, i));
    return {
      path,
      idShort,
      kind: raw.modelType,
      ...(raw.valueType && { valueType: raw.valueType }),
      ...(semanticId && { semanticId }),
      ...(cardinalityOf(raw) && { cardinality: cardinalityOf(raw) }),
      name: english(concept?.preferredName) ?? english(raw.displayName) ?? idShort,
      ...((english(concept?.definition) ?? english(raw.description)) && {
        definition: english(concept?.definition) ?? english(raw.description),
      }),
      ...(clean(concept?.unit) && { unit: clean(concept.unit) }),
      ...(children.length && { children }),
    };
  };

  const templates = (document.submodels ?? []).filter((s) => s.kind === "Template");
  if (templates.length !== 1) throw new Error(`Expected one submodel template in ${file}, found ${templates.length}`);
  const [submodel] = templates;
  const semanticId = semanticIdOf(submodel);
  const definition = english(contentOf(semanticId)?.definition) ?? english(submodel.description);
  return {
    idShort: submodel.idShort,
    submodelId: submodel.id,
    ...(semanticId && { semanticId }),
    name: english(contentOf(semanticId)?.preferredName) ?? english(submodel.displayName) ?? submodel.idShort,
    ...(definition && { definition }),
    elements: (submodel.submodelElements ?? []).map((e, i) => element(e, "", i)),
  };
}

const commit = args.has("--latest") || !recorded ? await commitsAtHead() : recorded.commit;
const files = await publishedFiles(commit);

const templates = [];
for (const template of IDTA_TEMPLATES) {
  const { path, version } = latestFile(files, template.folder);
  const url = `https://raw.githubusercontent.com/${IDTA_REPOSITORY}/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`;
  const submodel = transform(await (await fetchOk(url)).json(), path);
  templates.push({ id: template.id, version: version.join("."), path, ...submodel });
}

const output = {
  repository: IDTA_REPOSITORY,
  commit,
  retrieved: check ? recorded.retrieved : new Date().toISOString().slice(0, 10),
  license: "CC BY 4.0",
  templates,
};
const text = `${JSON.stringify(output, null, 1)}\n`;

if (check) {
  if (!recorded) throw new Error("Run npm run fetch-idta first.");
  const failures = [];
  if (`${JSON.stringify(recorded, null, 1)}\n` !== text) {
    failures.push(`db/source/idta-submodels.json differs from commit ${commit}: run npm run fetch-idta.`);
  }
  // A newer version is news rather than a mismatch, so it is reported apart.
  const head = await commitsAtHead();
  const newer = [];
  if (head !== commit) {
    const current = await publishedFiles(head);
    for (const template of IDTA_TEMPLATES) {
      const { path } = latestFile(current, template.folder);
      if (path !== templates.find((t) => t.id === template.id).path) newer.push(path);
    }
  }
  if (newer.length) console.log(`Newer than the recorded commit, for npm run fetch-idta -- --latest:\n  ${newer.join("\n  ")}`);
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log(`All ${templates.length} IDTA templates match commit ${commit.slice(0, 7)}.`);
} else {
  writeFileSync(OUT, text);
  console.log(`Wrote db/source/idta-submodels.json: ${templates.length} templates at ${commit.slice(0, 7)}.`);
}
