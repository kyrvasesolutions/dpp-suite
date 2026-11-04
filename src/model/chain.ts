/**
 * The regulatory chain, as read from SQLite:
 *
 *   legislation → data requirement → standard → ontology → data point
 *
 * A legislation sets data requirements through its provisions. Behind a data
 * requirement are the standards that legislation names for it, and standards no
 * act names whose own scope targets it. Some have neither. Ontologies link to the
 * data requirement rather than the standard, so those without a standard reach them too.
 */
import type { DataRequirement, Legislation, ProductGroup, Provision } from "./legislation";
import type { Citation, Standard, StandardLink, StandardTarget } from "./standards";

export interface ProductGroupInfo {
  id: ProductGroup;
  name: string;
  description: string;
}

export interface Ontology {
  id: string;
  name: string;
  uri?: string;
  description?: string;
}

export interface DataPoint {
  id: string;
  name: string;
  description?: string;
}

export interface Chain {
  productGroups: ProductGroupInfo[];
  legislations: Legislation[];
  legislationById: Record<string, Legislation>;
  standards: Record<string, Standard>;
  citations: Citation[];
  links: StandardLink[];
  /** Standards no act names, whose own scope targets a data requirement. */
  targets: StandardTarget[];
  /** Links by `legislation|dataRequirement`. */
  linksBehind: Map<string, StandardLink[]>;
  dataRequirements: DataRequirement[];
  provisions: Provision[];
  ontologies: Ontology[];
  requirementOntologies: Array<{ dataRequirement: string; ontology: string }>;
  dataPoints: DataPoint[];
  ontologyDataPoints: Array<{ ontology: string; dataPoint: string }>;
}

export const appliesTo = (legislation: Legislation, group: ProductGroup) => !!legislation.scope[group];

/** Distinct legislations motivating a data requirement. */
export const legislationCount = (provisions: Provision[]) => new Set(provisions.map((p) => p.legislation)).size;

/** Data requirements any legislation sets for this product group (or every group when none is chosen). */
export function requirementsFor(chain: Chain, group: ProductGroup | null): Set<string> {
  return new Set(chain.provisions.filter((p) => !group || p.groups.includes(group)).map((p) => p.dataRequirement));
}

export const linksBehind = (chain: Chain, legislation: string, dataRequirement: string): StandardLink[] =>
  chain.linksBehind.get(`${legislation}|${dataRequirement}`) ?? [];

/**
 * One element of the Standards column: the standards and the act's passages that
 * belong together. Standards named in one passage share an element, and so do the
 * passages naming one standard, so each passage and each standard shows only once
 * per legislation however many data requirements it stands behind.
 */
export interface CitationGroup {
  legislation: string;
  standards: Standard[];
  citations: Citation[];
  requirements: DataRequirement[];
  /** Why these standards bear on those data requirements. */
  reasons: Array<{ note: string; basis: StandardLink["basis"]; requirements: DataRequirement[] }>;
}

const citationsOf = (chain: Chain, link: StandardLink) =>
  chain.citations.filter(
    (c) =>
      c.legislation === link.legislation &&
      c.standard === link.standard &&
      (!link.provisions || link.provisions.includes(c.provision)),
  );

interface GroupEntry {
  standard: string;
  excerpts: string[];
  link?: StandardLink;
}

/** Merges entries sharing a standard or a passage into one legislation's citation groups. */
function groupsFrom(chain: Chain, legislation: string, entries: GroupEntry[]): CitationGroup[] {
  let parts: Array<{ standards: Set<string>; excerpts: Set<string>; links: StandardLink[] }> = [];
  for (const { standard, excerpts, link } of entries) {
    const touching = parts.filter((p) => p.standards.has(standard) || excerpts.some((e) => p.excerpts.has(e)));
    const at = touching.length ? parts.indexOf(touching[0]) : parts.length;
    parts = parts.filter((p) => !touching.includes(p));
    parts.splice(at, 0, {
      standards: new Set([...touching.flatMap((p) => [...p.standards]), standard]),
      excerpts: new Set([...touching.flatMap((p) => [...p.excerpts]), ...excerpts]),
      links: [...touching.flatMap((p) => p.links), ...(link ? [link] : [])],
    });
  }

  return parts.map(({ standards, excerpts, links }): CitationGroup => {
    const requirementsOf = (ids: string[]) => chain.dataRequirements.filter((d) => ids.includes(d.id));
    const reasons = [...new Set(links.map((l) => l.note))].map((note) => {
      const same = links.filter((l) => l.note === note);
      return { note, basis: same[0].basis, requirements: requirementsOf(same.map((l) => l.dataRequirement)) };
    });
    const seen = new Set<string>();
    return {
      legislation,
      standards: Object.values(chain.standards).filter((st) => standards.has(st.id)),
      citations: chain.citations.filter((c) => {
        const first = c.legislation === legislation && excerpts.has(c.excerpt) && !seen.has(c.excerpt);
        if (first) seen.add(c.excerpt);
        return first;
      }),
      requirements: requirementsOf(links.map((l) => l.dataRequirement)),
      reasons,
    };
  });
}

/** The citation groups behind these data requirements, by legislation. */
export function citationGroups(chain: Chain, inView: Array<{ id: string; provisions: Provision[] }>): CitationGroup[] {
  return chain.legislations.flatMap((law) =>
    groupsFrom(
      chain,
      law.id,
      inView
        .filter((r) => r.provisions.some((p) => p.legislation === law.id))
        .flatMap((r) => linksBehind(chain, law.id, r.id))
        .map((link) => ({ standard: link.standard, excerpts: citationsOf(chain, link).map((c) => c.excerpt), link })),
    ),
  );
}

/** Groups of the standards a legislation names that stand behind none of its data requirements for this product group. */
export function citedOnlyGroups(chain: Chain, group: ProductGroup, legislation: string): CitationGroup[] {
  return groupsFrom(
    chain,
    legislation,
    standardsNamedBy(chain, group, legislation).citedOnly.map(({ standard, citations }) => ({
      standard: standard.id,
      excerpts: citations.map((c) => c.excerpt),
    })),
  );
}

/** A standard no act names, with the data requirements in view it targets. */
export interface TargetedStandard {
  standard: Standard;
  requirements: DataRequirement[];
  reasons: Array<{ note: string; requirements: DataRequirement[] }>;
  source: string;
}

/** The standards no act names that target these data requirements, in the order the requirements come. */
export function targetedStandards(chain: Chain, group: ProductGroup, inView: Array<{ id: string }>): TargetedStandard[] {
  const ids = inView.map((r) => r.id);
  const relevant = chain.targets.filter((t) => t.groups.includes(group) && ids.includes(t.dataRequirement));
  const ordered = [...new Set(ids.flatMap((id) => relevant.filter((t) => t.dataRequirement === id).map((t) => t.standard)))];
  return ordered.map((id) => {
    const own = relevant.filter((t) => t.standard === id);
    const requirementsOf = (wanted: string[]) => chain.dataRequirements.filter((d) => wanted.includes(d.id));
    return {
      standard: chain.standards[id],
      requirements: requirementsOf(own.map((t) => t.dataRequirement)),
      reasons: [...new Set(own.map((t) => t.note))].map((note) => ({
        note,
        requirements: requirementsOf(own.filter((t) => t.note === note).map((t) => t.dataRequirement)),
      })),
      source: own[0].source,
    };
  });
}

export interface NamedStandard {
  standard: Standard;
  citations: Citation[];
}

/** The standards a legislation names, split by whether they stand behind one of its data requirements for this group. */
export function standardsNamedBy(
  chain: Chain,
  group: ProductGroup,
  legislation: string,
): { linked: NamedStandard[]; citedOnly: NamedStandard[] } {
  const own = new Set(
    chain.provisions.filter((p) => p.legislation === legislation && p.groups.includes(group)).map((p) => p.dataRequirement),
  );
  const cited = new Map<string, Citation[]>();
  for (const c of chain.citations) {
    if (c.legislation === legislation) cited.set(c.standard, [...(cited.get(c.standard) ?? []), c]);
  }
  const linked: NamedStandard[] = [];
  const citedOnly: NamedStandard[] = [];
  for (const [id, citations] of cited) {
    const bearing = chain.links.some((l) => l.legislation === legislation && l.standard === id && own.has(l.dataRequirement));
    (bearing ? linked : citedOnly).push({ standard: chain.standards[id], citations });
  }
  return { linked, citedOnly };
}

/** Provisions behind each data requirement for the chosen group and legislations. */
export function provisionsByRequirement(chain: Chain, group: ProductGroup, legislations: Set<string>): Map<string, Provision[]> {
  const out = new Map<string, Provision[]>();
  for (const p of chain.provisions) {
    if (!p.groups.includes(group) || !legislations.has(p.legislation)) continue;
    const list = out.get(p.dataRequirement) ?? [];
    list.push(p);
    out.set(p.dataRequirement, list);
  }
  return out;
}

export const ontologiesFor = (chain: Chain, requirements: Set<string>): Ontology[] => {
  const ids = new Set(chain.requirementOntologies.filter((l) => requirements.has(l.dataRequirement)).map((l) => l.ontology));
  return chain.ontologies.filter((o) => ids.has(o.id));
};

export const dataPointsFor = (chain: Chain, ontologies: Ontology[]): DataPoint[] => {
  const from = new Set(ontologies.map((o) => o.id));
  const ids = new Set(chain.ontologyDataPoints.filter((l) => from.has(l.ontology)).map((l) => l.dataPoint));
  return chain.dataPoints.filter((d) => ids.has(d.id));
};
