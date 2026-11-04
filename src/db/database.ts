import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import schemaSql from "../../db/schema.sql?raw";
import type { Chain } from "../model/chain";
import type { DataRequirement, Legislation, Provision } from "../model/legislation";
import type { Ontology, OntologyTerm, RequirementTerm } from "../model/ontologies";
import type { Project } from "../model/project";
import type { Citation, Standard, StandardLink, StandardTarget } from "../model/standards";
import type { Mapping, Side, SourceDoc, TreeData, TreeNode } from "../model/types";
import { idbGet, idbSet } from "./idb";

// Seed files run in name order: product sample, ESPR Annex I, sample mappings, regulatory chain, ontology terms.
const seedFiles = Object.entries(
  import.meta.glob<string>("../../db/seed/*.sql", { query: "?raw", import: "default", eager: true }),
).sort(([a], [b]) => a.localeCompare(b));
const seeds = seedFiles.map(([, sql]) => sql);
const seedNamed = (name: string) => seedFiles.find(([path]) => path.endsWith(name))![1];
const chainSeed = seedNamed("04-regulatory-chain.sql");
const ontologySeed = seedNamed("05-ontology-terms.sql");

const STORE_KEY = "dpp-trace.sqlite";
const FALLBACK_TREE_ID: Record<Side, string> = { left: "left", right: "right" };

let sqlPromise: Promise<SqlJsStatic> | null = null;
const sqlJs = () => (sqlPromise ??= initSqlJs({ locateFile: () => wasmUrl }));

function seeded(SQL: SqlJsStatic): Database {
  const db = new SQL.Database();
  db.exec(schemaSql);
  for (const sql of seeds) db.exec(sql);
  return db;
}

/** A database saved before the regulatory chain or the ontology terms existed gets their tables and rows here. */
function ensureChain(db: Database) {
  db.exec(schemaSql);
  if (rows(db, "SELECT count(*) AS n FROM legislation")[0].n === 0) db.exec(chainSeed);

  const columns = new Set(rows(db, "PRAGMA table_info(ontology)").map((r) => r.name));
  for (const column of ["license", "license_url", "retrieved"]) {
    if (!columns.has(column)) db.exec(`ALTER TABLE ontology ADD COLUMN ${column} TEXT`);
  }
  if (rows(db, "SELECT count(*) AS n FROM ontology_term")[0].n === 0) db.exec(ontologySeed);
}

/** Opens the database saved in this browser, or creates one from the seed files. */
export async function openDatabase(): Promise<Database> {
  const SQL = await sqlJs();
  try {
    const bytes = await idbGet(STORE_KEY);
    if (bytes) {
      const db = new SQL.Database(bytes);
      db.exec("PRAGMA foreign_keys = ON;");
      ensureChain(db);
      return db;
    }
  } catch {
    // Unreadable or blocked storage: start from the seed.
  }
  return seeded(SQL);
}

export async function resetDatabase(): Promise<Database> {
  return seeded(await sqlJs());
}

/** Opens an uploaded .sqlite file; throws if it doesn't have this app's tables. */
export async function databaseFromFile(bytes: Uint8Array): Promise<Database> {
  const SQL = await sqlJs();
  const db = new SQL.Database(bytes);
  let tables: Set<string | number | null>;
  try {
    tables = new Set(rows(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name));
  } catch {
    db.close();
    throw new Error("This file is not a SQLite database.");
  }
  for (const t of ["tree", "node", "mapping", "source"]) {
    if (!tables.has(t)) {
      db.close();
      throw new Error(`Not a DPP traceability database (missing table "${t}").`);
    }
  }
  return db;
}

export async function persist(db: Database) {
  await idbSet(STORE_KEY, db.export());
}

type Row = Record<string, string | number | null>;

function rows(db: Database, sql: string, params: (string | number | null)[] = []): Row[] {
  const stmt = db.prepare(sql, params);
  const out: Row[] = [];
  while (stmt.step()) out.push(stmt.getAsObject() as Row);
  stmt.free();
  return out;
}

const opt = (v: string | number | null) => (v === null ? undefined : String(v));

export function readProject(db: Database): Project {
  const readTree = (side: Side): TreeData => {
    const [tree] = rows(db, "SELECT id, title, subtitle, root_id FROM tree WHERE side = ?", [side]);
    if (!tree) throw new Error(`The database has no ${side} tree.`);
    const nodes: Record<string, TreeNode> = {};
    const list = rows(
      db,
      `SELECT id, parent_id, name, meta, description, source_id, source_ref
         FROM node WHERE tree_id = ? ORDER BY parent_id, position`,
      [String(tree.id)],
    );
    for (const r of list) {
      nodes[String(r.id)] = {
        id: String(r.id),
        name: String(r.name),
        meta: opt(r.meta),
        description: opt(r.description),
        sourceId: opt(r.source_id),
        sourceRef: opt(r.source_ref),
      };
    }
    for (const r of list) {
      if (r.parent_id === null) continue;
      const parent = nodes[String(r.parent_id)];
      if (parent) (parent.children ??= []).push(String(r.id));
    }
    return {
      id: String(tree.id),
      title: String(tree.title),
      subtitle: String(tree.subtitle),
      rootId: String(tree.root_id),
      nodes,
    };
  };

  const left = readTree("left");
  const right = readTree("right");
  const mappings: Mapping[] = rows(
    db,
    "SELECT id, from_id, to_id FROM mapping WHERE from_tree = ? AND to_tree = ? ORDER BY created_at, id",
    [left.id!, right.id!],
  ).map((r) => ({ id: String(r.id), from: String(r.from_id), to: String(r.to_id) }));
  const sources: Record<string, SourceDoc> = {};
  for (const r of rows(db, "SELECT id, title, url FROM source")) {
    sources[String(r.id)] = { title: String(r.title), url: opt(r.url) };
  }
  return { left, right, mappings, sources };
}

/** The regulatory chain the Requirements and Validation views show. */
export async function loadChain(): Promise<Chain> {
  const db = await openDatabase();
  try {
    return readChain(db);
  } finally {
    db.close();
  }
}

export function readChain(db: Database): Chain {
  const text = (v: string | number | null) => String(v);

  const scope = rows(db, "SELECT legislation_id, product_group_id, note FROM legislation_scope");
  const legislations = rows(db, "SELECT * FROM legislation ORDER BY position").map(
    (r): Legislation => ({
      id: text(r.id),
      short: text(r.short),
      title: text(r.title),
      ref: text(r.ref),
      celex: text(r.celex),
      category: text(r.category) as Legislation["category"],
      standardsNote: opt(r.standards_note),
      scope: Object.fromEntries(
        scope.filter((s) => s.legislation_id === r.id).map((s) => [text(s.product_group_id), text(s.note)]),
      ),
    }),
  );

  const standards: Record<string, Standard> = {};
  for (const r of rows(db, "SELECT * FROM standard ORDER BY position")) {
    standards[text(r.id)] = {
      id: text(r.id),
      ref: text(r.ref),
      title: opt(r.title),
      body: text(r.body),
      kind: text(r.kind) as Standard["kind"],
    };
  }

  const citations = rows(db, "SELECT * FROM standard_citation ORDER BY position").map(
    (r): Citation => ({
      legislation: text(r.legislation_id),
      standard: text(r.standard_id),
      provision: text(r.provision),
      force: text(r.force) as Citation["force"],
      excerpt: text(r.excerpt),
      citedAs: opt(r.cited_as),
      source: opt(r.source_celex),
    }),
  );

  const links = rows(
    db,
    `SELECT l.* FROM standard_requirement l JOIN standard s ON s.id = l.standard_id ORDER BY s.position`,
  ).map(
    (r): StandardLink => ({
      legislation: text(r.legislation_id),
      standard: text(r.standard_id),
      dataRequirement: text(r.data_requirement_id),
      basis: text(r.basis) as StandardLink["basis"],
      note: text(r.note),
      provisions: r.provisions === null ? undefined : (JSON.parse(text(r.provisions)) as string[]),
    }),
  );
  const targetRows = new Map<string, StandardTarget>();
  for (const r of rows(db, "SELECT t.* FROM standard_target t JOIN standard s ON s.id = t.standard_id ORDER BY s.position")) {
    const key = `${r.standard_id}|${r.data_requirement_id}`;
    const seen = targetRows.get(key);
    const group = text(r.product_group_id) as StandardTarget["groups"][number];
    if (seen) seen.groups.push(group);
    else {
      targetRows.set(key, {
        standard: text(r.standard_id),
        dataRequirement: text(r.data_requirement_id),
        groups: [group],
        note: text(r.note),
        source: text(r.source_url),
      });
    }
  }

  const linksBehind = new Map<string, StandardLink[]>();
  for (const l of links) {
    const key = `${l.legislation}|${l.dataRequirement}`;
    linksBehind.set(key, [...(linksBehind.get(key) ?? []), l]);
  }

  const groupsOf = new Map<number, Provision["groups"]>();
  for (const r of rows(db, "SELECT provision_id, product_group_id FROM provision_group")) {
    const id = Number(r.provision_id);
    groupsOf.set(id, [...(groupsOf.get(id) ?? []), text(r.product_group_id) as Provision["groups"][number]]);
  }

  return {
    productGroups: rows(db, "SELECT id, name, description FROM product_group ORDER BY position").map((r) => ({
      id: text(r.id) as Chain["productGroups"][number]["id"],
      name: text(r.name),
      description: text(r.description),
    })),
    legislations,
    legislationById: Object.fromEntries(legislations.map((l) => [l.id, l])),
    standards,
    citations,
    links,
    targets: [...targetRows.values()],
    linksBehind,
    dataRequirements: rows(db, "SELECT id, name, theme FROM data_requirement ORDER BY position").map(
      (r): DataRequirement => ({ id: text(r.id), name: text(r.name), theme: text(r.theme) as DataRequirement["theme"] }),
    ),
    provisions: rows(db, "SELECT * FROM requirement_provision ORDER BY id").map(
      (r): Provision => ({
        dataRequirement: text(r.data_requirement_id),
        legislation: text(r.legislation_id),
        groups: groupsOf.get(Number(r.id)) ?? [],
        ref: text(r.ref),
        text: text(r.text),
        quotes: r.quotes === null ? undefined : (JSON.parse(text(r.quotes)) as string[]),
        source: opt(r.source_celex),
      }),
    ),
    ontologies: rows(db, "SELECT * FROM ontology ORDER BY position").map(
      (r): Ontology => ({
        id: text(r.id),
        name: text(r.name),
        uri: text(r.uri),
        description: text(r.description),
        license: text(r.license),
        licenseUrl: text(r.license_url),
        retrieved: text(r.retrieved),
      }),
    ),
    ontologyTerms: rows(db, "SELECT * FROM ontology_term ORDER BY position").map(
      (r): OntologyTerm => ({
        id: text(r.id),
        ontology: text(r.ontology_id),
        label: text(r.label),
        uri: text(r.uri),
        definition: text(r.definition),
      }),
    ),
    requirementTerms: rows(db, "SELECT * FROM data_requirement_term").map(
      (r): RequirementTerm => ({
        dataRequirement: text(r.data_requirement_id),
        term: text(r.term_id),
        match: text(r.match) as RequirementTerm["match"],
        note: opt(r.note),
      }),
    ),
    dataPoints: rows(db, "SELECT id, name, description FROM data_point ORDER BY position").map((r) => ({
      id: text(r.id),
      name: text(r.name),
      description: opt(r.description),
    })),
    ontologyDataPoints: rows(db, "SELECT ontology_id, data_point_id FROM ontology_data_point").map((r) => ({
      ontology: text(r.ontology_id),
      dataPoint: text(r.data_point_id),
    })),
  };
}

/** Replaces the trees and mappings in the database with the project's. Sources are upserted. */
export function writeProject(db: Database, project: Project) {
  const ids = {
    left: project.left.id ?? FALLBACK_TREE_ID.left,
    right: project.right.id ?? FALLBACK_TREE_ID.right,
  };
  db.exec("BEGIN; PRAGMA defer_foreign_keys = ON;");
  try {
    db.exec("DELETE FROM mapping; DELETE FROM node; DELETE FROM tree;");
    const source = db.prepare("INSERT OR REPLACE INTO source (id, title, url) VALUES (?, ?, ?)");
    for (const [id, s] of Object.entries(project.sources)) source.run([id, s.title, s.url ?? null]);
    source.free();

    const tree = db.prepare("INSERT INTO tree (id, side, title, subtitle, root_id) VALUES (?, ?, ?, ?, ?)");
    const node = db.prepare(
      `INSERT INTO node (tree_id, id, parent_id, position, name, meta, description, source_id, source_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const side of ["left", "right"] as const) {
      const data = project[side];
      tree.run([ids[side], side, data.title, data.subtitle, data.rootId]);
      const parents: Record<string, { parent: string; position: number }> = {};
      for (const n of Object.values(data.nodes)) {
        n.children?.forEach((child, position) => (parents[child] = { parent: n.id, position }));
      }
      for (const n of Object.values(data.nodes)) {
        const p = parents[n.id];
        const sourceId = n.sourceId && project.sources[n.sourceId] ? n.sourceId : null;
        node.run([
          ids[side],
          n.id,
          p?.parent ?? null,
          p?.position ?? 0,
          n.name,
          n.meta ?? null,
          n.description ?? null,
          sourceId,
          n.sourceRef ?? null,
        ]);
      }
    }
    tree.free();
    node.free();

    const mapping = db.prepare(
      "INSERT OR IGNORE INTO mapping (id, from_tree, from_id, to_tree, to_id) VALUES (?, ?, ?, ?, ?)",
    );
    for (const m of project.mappings) mapping.run([m.id, ids.left, m.from, ids.right, m.to]);
    mapping.free();
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}
