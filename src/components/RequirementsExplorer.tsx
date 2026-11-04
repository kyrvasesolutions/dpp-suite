import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  Button,
  Dialog,
  DialogTrigger,
  Disclosure,
  DisclosureGroup,
  DisclosurePanel,
  Header,
  Heading,
  Link,
  ListBox,
  ListBoxItem,
  ListBoxSection,
  Popover,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  TooltipTrigger,
  type Key,
} from "react-aria-components";
import {
  appliesTo,
  citationGroups,
  citedOnlyGroups,
  dataPointsFor,
  legislationCount,
  provisionsByRequirement,
  requirementsFor,
  targetedStandards,
  termsByOntology,
  type Chain,
  type CitationGroup,
  type TargetedStandard,
  type TermInView,
} from "../model/chain";
import {
  CATEGORIES,
  SOURCE_ACTS,
  THEMES,
  eurLex,
  type Legislation,
  type ProductGroup,
  type Provision,
} from "../model/legislation";
import type { Ontology, TermMatch } from "../model/ontologies";
import { download } from "../model/project";
import { buildSpec, saveSpec, specFilename, toYaml } from "../model/spec";
import type { Citation } from "../model/standards";
import { useMediaQuery } from "../useMediaQuery";
import { ChainArrows, type ChainRelation } from "./ChainArrows";

const NO_PROVISIONS: Provision[] = [];

/** What arrows attach to: a citation group is one element of the Standards column. */
const groupAnchor = (group: CitationGroup) => `std:${group.legislation}|${group.standards.map((st) => st.id).join()}`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Where the act names the standard, led by the implementing act's name when it is not the legislation's own text. */
const whereCited = (citations: Citation[], ownCelex: string) => {
  const provisions = [...new Set(citations.map((c) => c.provision))].join("; ");
  const source = citations[0]?.source;
  const act = source && source !== ownCelex ? SOURCE_ACTS[source]?.ref : undefined;
  return act ? `${act}, ${provisions}` : provisions;
};

/** The leading part of the titles standards in a series share, e.g. everything before "Part 1". */
const sharedTitle = (titles: string[]) => {
  let shared = "";
  if (titles.length < 2) return shared;
  for (const separator of titles[0].matchAll(/ [—–] /g)) {
    const head = titles[0].slice(0, separator.index);
    if (titles.every((t) => t.startsWith(head + separator[0]))) shared = head;
  }
  return shared;
};

function GroupContext({ group, law }: { group: CitationGroup; law: Legislation }) {
  const shared = sharedTitle(group.standards.map((st) => st.title ?? ""));
  return (
    <div className="std-context-body">
      <div className="std-context-standards">
        {shared && <span className="leg-ref">{shared}</span>}
        {group.standards.map((st) => (
          <span key={st.id} className="std-context-standard">
            <strong>{st.ref}</strong>
            {st.title && <span className="leg-ref">{st.title.slice(shared.length).replace(/^ [—–] /, "")}</span>}
          </span>
        ))}
      </div>
      {group.citations.map((c) => (
        <div key={c.provision} className="std-context-passage">
          <span className="std-context-where">
            <span className="law-chip strong">{law.short}</span>
            <span className="leg-ref">{whereCited([c], law.celex)}</span>
          </span>
          <blockquote className="req-quote">
            <p>{c.excerpt}</p>
          </blockquote>
        </div>
      ))}
      {group.reasons.length > 0 && (
        <ul className="std-context-why">
          {group.reasons.map((r) => (
            <li key={r.note}>
              <strong>{r.requirements.map((d) => d.name).join(", ")}:</strong> {r.basis === "inferred" && "Our reading: "}
              {r.note}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One element of the Standards column, by reference only. Descriptions wait in the
 * context, so no two rows repeat each other's wording. A mouse hover shows the
 * context as a tooltip; a click or tap opens the same context as a popover, which
 * is how it reaches touch screens, where nothing hovers, and lets it be copied.
 */
function ReferenceRow({
  anchor,
  names,
  definition,
  where,
  requirements,
  label,
  context,
}: {
  anchor: string;
  names: string[];
  definition?: string;
  where?: string;
  requirements: Array<{ id: string; name: string }>;
  label: string;
  /** `pinned` is true in the popover, where links can be reached. */
  context: (pinned: boolean) => ReactNode;
}) {
  // An element can fill a phone screen, so the popover hangs off its icon rather than squeezing around all of it.
  const icon = useRef<SVGSVGElement>(null);
  return (
    <DialogTrigger>
      <TooltipTrigger delay={200} closeDelay={80}>
        <Button className="std-ref" data-chain={anchor}>
          <svg ref={icon} className="std-ref-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <path d="M8 7.2v3.6M8 5v.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          {names.map((name) => (
            <strong key={name} className="std-ref-name">
              {name}
            </strong>
          ))}
          {definition && <span className="std-ref-definition">{definition}</span>}
          {where && <span className="std-ref-where">{where}</span>}
          {requirements.length > 0 && (
            <span className="std-ref-reqs">
              {requirements.map((d) => (
                <span key={d.id} className="law-chip">
                  {d.name}
                </span>
              ))}
            </span>
          )}
        </Button>
        <Tooltip className="std-context" placement="right top" offset={8}>
          {context(false)}
        </Tooltip>
      </TooltipTrigger>
      <Popover className="std-context" triggerRef={icon} placement="bottom end" offset={4}>
        <Dialog aria-label={label}>{context(true)}</Dialog>
      </Popover>
    </DialogTrigger>
  );
}

function CitationGroupRow({ group, law, showWhere = true }: { group: CitationGroup; law: Legislation; showWhere?: boolean }) {
  return (
    <ReferenceRow
      anchor={groupAnchor(group)}
      names={group.standards.map((st) => st.ref)}
      where={showWhere ? whereCited(group.citations, law.celex) : undefined}
      requirements={group.requirements}
      label={`Where ${law.short} names ${group.standards.map((st) => st.ref).join(", ")}`}
      context={() => <GroupContext group={group} law={law} />}
    />
  );
}

function TargetedRow({ target }: { target: TargetedStandard }) {
  const { standard, reasons, requirements, source } = target;
  return (
    <ReferenceRow
      anchor={`target:${standard.id}`}
      names={[standard.ref]}
      where={standard.body}
      requirements={requirements}
      label={`Why ${standard.ref} targets these data requirements`}
      context={(pinned) => (
        <div className="std-context-body">
          <span className="std-context-standard">
            <strong>{standard.ref}</strong>
            {standard.title && <span className="leg-ref">{standard.title}</span>}
          </span>
          <span className="std-tag">Named by no act; our reading of its scope</span>
          <ul className="std-context-why">
            {reasons.map((r) => (
              <li key={r.note}>
                <strong>{r.requirements.map((d) => d.name).join(", ")}:</strong> {r.note}
              </li>
            ))}
          </ul>
          <span className="leg-ref">
            Source:{" "}
            {pinned ? (
              <Link href={source} target="_blank" rel="noreferrer" className="req-ref">
                {new URL(source).hostname}
              </Link>
            ) : (
              new URL(source).hostname
            )}
          </span>
        </div>
      )}
    />
  );
}

const MATCH_LABEL: Record<TermMatch, string> = {
  exact: "Exact match",
  close: "Close match",
  broad: "Broader term",
  narrow: "Narrower term",
};

/** A term and its definition, which is what the row is for. The context says how it fits and where it comes from. */
function TermRow({ term, requirements, ontology }: TermInView & { ontology: Ontology }) {
  const external = (href: string, text: string, pinned: boolean) =>
    pinned ? (
      <Link href={href} target="_blank" rel="noreferrer" className="req-ref">
        {text}
      </Link>
    ) : (
      text
    );
  return (
    <ReferenceRow
      anchor={`term:${term.id}`}
      names={[term.label]}
      definition={term.definition}
      where={[...new Set(requirements.map((r) => MATCH_LABEL[r.match]))].join(", ")}
      requirements={requirements}
      label={`How ${term.label} in ${ontology.name} defines these data requirements`}
      context={(pinned) => (
        <div className="std-context-body">
          <span className="std-context-standard">
            <strong>{term.label}</strong>
            <span className="leg-ref">{ontology.name}</span>
          </span>
          <ul className="std-context-why">
            {requirements.map((r) => (
              <li key={r.id}>
                <strong>{r.name}:</strong> {MATCH_LABEL[r.match]}.{r.note && ` Our reading: ${r.note}`}
              </li>
            ))}
          </ul>
          <span className="leg-ref">{ontology.description}</span>
          <span className="leg-ref">
            Term: {external(term.uri, term.uri, pinned)}
            <br />
            Licence: {external(ontology.licenseUrl, ontology.license, pinned)}. Copied {ontology.retrieved}.
          </span>
        </div>
      )}
    />
  );
}

function ChainColumn({
  id,
  anchor,
  title,
  subtitle,
  items,
  empty,
}: {
  id: string;
  /** Prefix of the items' `data-chain` attributes. */
  anchor: string;
  title: string;
  subtitle: string;
  items: Array<{ id: string; name: string; description?: string }>;
  empty: string;
}) {
  return (
    <section className="panel" aria-labelledby={`${id}-title`}>
      <header className="panel-head">
        <div>
          <h2 id={`${id}-title`}>{title}</h2>
          <p>{subtitle}</p>
        </div>
      </header>
      <div className="list">
        {items.length ? (
          <ul className="chain-items">
            {items.map((item) => (
              <li key={item.id} data-chain={`${anchor}:${item.id}`}>
                <span className="schema-name">{item.name}</span>
                {item.description && <span className="leg-ref">{item.description}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">{empty}</p>
        )}
      </div>
    </section>
  );
}

/**
 * One column per step, scrolling sideways: product group, then legislation, the
 * data requirements it sets, the standards behind those, and the ontologies and
 * data points. Opening data requirements narrows what follows to them; with none
 * open, it follows every data requirement of the selected legislations.
 */
export function RequirementsExplorer({ chain }: { chain: Chain }) {
  const { legislations, legislationById, productGroups, dataRequirements } = chain;
  const wide = useMediaQuery("(min-width: 768px)");
  const boardRef = useRef<HTMLElement>(null);
  const [group, setGroup] = useState<ProductGroup | null>(null);
  const [selected, setSelected] = useState<Set<Key>>(new Set());
  const [expanded, setExpanded] = useState<Set<Key>>(new Set());
  const [onlyRequired, setOnlyRequired] = useState(false);
  const [savedKey, setSavedKey] = useState<string | null>(null);

  const selectedIds = useMemo(() => new Set([...selected].map(String)), [selected]);
  const disabled = useMemo(
    () => legislations.filter((l) => !group || !appliesTo(l, group)).map((l) => l.id),
    [group, legislations],
  );
  const inScope = useMemo(() => requirementsFor(chain, group), [chain, group]);
  const required = useMemo(
    () => (group ? provisionsByRequirement(chain, group, selectedIds) : new Map<string, Provision[]>()),
    [chain, group, selectedIds],
  );

  // Open rows that are still required; a row closes by itself when its legislation is deselected.
  const opened = useMemo(() => [...expanded].map(String).filter((id) => required.has(id)), [expanded, required]);
  const inView = useMemo(() => new Set(opened.length ? opened : required.keys()), [opened, required]);

  const inViewRows = useMemo(
    () =>
      dataRequirements
        .filter((d) => inView.has(d.id))
        .map((d) => ({ id: d.id, name: d.name, provisions: required.get(d.id) ?? NO_PROVISIONS })),
    [dataRequirements, inView, required],
  );
  const groups = useMemo(() => citationGroups(chain, inViewRows), [chain, inViewRows]);
  const groupsByLaw = legislations
    .map((law) => ({ law, groups: groups.filter((g) => g.legislation === law.id) }))
    .filter((entry) => entry.groups.length > 0);

  const targeted = useMemo(() => (group ? targetedStandards(chain, group, inViewRows) : []), [chain, group, inViewRows]);
  const standardCount = new Set([
    ...groups.flatMap((g) => g.standards.map((st) => st.id)),
    ...targeted.map((t) => t.standard.id),
  ]).size;

  const withoutStandard = useMemo(() => {
    const covered = new Set([
      ...groups.flatMap((g) => g.requirements.map((d) => d.id)),
      ...targeted.flatMap((t) => t.requirements.map((d) => d.id)),
    ]);
    return inViewRows
      .filter((r) => !covered.has(r.id))
      .map((r) => ({ ...r, laws: [...new Set(r.provisions.map((p) => p.legislation))] }));
  }, [groups, inViewRows, targeted]);
  const notes = legislations.filter((l) => selectedIds.has(l.id) && l.standardsNote);

  const citedOnlyByLaw = useMemo(
    () =>
      group
        ? legislations
            .filter((l) => selectedIds.has(l.id))
            .map((law) => ({ law, groups: citedOnlyGroups(chain, group, law.id) }))
            .filter((entry) => entry.groups.length > 0)
        : [],
    [chain, group, legislations, selectedIds],
  );
  const citedOnlyCount = citedOnlyByLaw.reduce((n, g) => n + g.groups.reduce((m, x) => m + x.standards.length, 0), 0);

  const termGroups = useMemo(() => termsByOntology(chain, inView), [chain, inView]);
  const termCount = termGroups.reduce((n, g) => n + g.terms.length, 0);
  const ontologies = useMemo(() => termGroups.map((g) => g.ontology), [termGroups]);
  const dataPoints = useMemo(() => dataPointsFor(chain, ontologies), [chain, ontologies]);

  const shared = [...required.values()].filter((ps) => legislationCount(ps) > 1).length;

  const relations = useMemo<ChainRelation[]>(() => {
    if (!group) return [];
    const shownOntologies = new Set(ontologies.map((o) => o.id));
    return [
      ...legislations
        .filter((l) => appliesTo(l, group))
        .map((l) => ({ from: `group:${group}`, to: `law:${l.id}`, faint: selectedIds.size > 0 && !selectedIds.has(l.id) })),
      ...[...required].flatMap(([id, provisions]) =>
        [...new Set(provisions.map((p) => p.legislation))].map((law) => ({ from: `law:${law}`, to: `req:${id}` })),
      ),
      ...groups.flatMap((g) => g.requirements.map((d) => ({ from: `req:${d.id}`, to: groupAnchor(g) }))),
      ...targeted.flatMap((t) => t.requirements.map((d) => ({ from: `req:${d.id}`, to: `target:${t.standard.id}` }))),
      ...withoutStandard.map((r) => ({ from: `req:${r.id}`, to: `none:${r.id}` })),
      // These skip the Data requirements column and cross its text, so they stay faint.
      ...citedOnlyByLaw.flatMap(({ law, groups: lawGroups }) =>
        lawGroups.map((g) => ({ from: `law:${law.id}`, to: groupAnchor(g), faint: true })),
      ),
      // These skip the Standards column in the same way.
      ...termGroups.flatMap((g) =>
        g.terms.flatMap(({ term, requirements }) =>
          requirements.map((r) => ({ from: `req:${r.id}`, to: `term:${term.id}`, faint: true })),
        ),
      ),
      ...chain.ontologyDataPoints
        .filter((l) => shownOntologies.has(l.ontology))
        .map((l) => ({ from: `ontology:${l.ontology}`, to: `point:${l.dataPoint}` })),
    ];
  }, [chain, citedOnlyByLaw, group, groups, legislations, ontologies, required, selectedIds, targeted, termGroups, withoutStandard]);

  const chooseGroup = (next: ProductGroup | null) => {
    setGroup(next);
    // Keep legislations that still apply; their requirements follow the new group.
    setSelected((s) => new Set([...s].filter((id) => next && appliesTo(legislationById[String(id)], next))));
    setExpanded(new Set());
  };

  const groupName = productGroups.find((g) => g.id === group)?.name;

  const specKey = `${group}|${[...selectedIds].sort().join()}`;
  const saved = savedKey === specKey;

  /** Writes the data requirements and their sources to a YAML file, and keeps the specification for the Mapping tab. */
  const exportSpec = () => {
    if (!group) return;
    const spec = buildSpec(chain, group, selectedIds, required);
    saveSpec(spec);
    download(new Blob([toYaml(spec)], { type: "application/yaml" }), specFilename(spec));
    setSavedKey(specKey);
  };

  return (
    <div className={wide ? "app wide" : "app narrow"}>
      <header className="topbar">
        <div className="brand">
          <h1>DPP requirements</h1>
        </div>
        <div className="brand">
          <span className="stat">
            <strong>{selectedIds.size}</strong> legislation{selectedIds.size === 1 ? "" : "s"}
          </span>
          <span className="stat">
            <strong>{required.size}</strong> data requirement{required.size === 1 ? "" : "s"}
          </span>
          <span className="stat" title="Data requirements set by more than one selected legislation">
            <strong>{shared}</strong> shared
          </span>
          <span className="stat">
            <strong>{standardCount}</strong> standard{standardCount === 1 ? "" : "s"}
          </span>
          <Button
            className="ghost"
            isDisabled={!group || required.size === 0}
            onPress={exportSpec}
            aria-describedby="export-note"
          >
            Export
          </Button>
          {saved && (
            <span id="export-note" className="stat" role="status">
              Saved for Mapping
            </span>
          )}
        </div>
      </header>

      <p className="hint">
        {!group
          ? "Choose a product group to see which legislations apply to it."
          : selectedIds.size === 0
            ? `Select one or more legislations for ${groupName} to see the data they require.`
            : "Open a data requirement to see its legal basis and narrow the standards and definitions to it. Hover or tap a standard or ontology term for its context."}
      </p>

      <main ref={boardRef} className="chain-board" tabIndex={0} aria-label="Legislation to data points, scrolls sideways">
        <section className="panel" aria-labelledby="group-title">
          <header className="panel-head">
            <div>
              <h2 id="group-title">Product Group</h2>
              <p>Industry to check</p>
            </div>
          </header>
          <div className="list">
            <ToggleButtonGroup
              aria-labelledby="group-title"
              className="group-options"
              orientation="vertical"
              selectionMode="single"
              selectedKeys={group ? [group] : []}
              onSelectionChange={(keys) => chooseGroup(([...keys][0] as ProductGroup | undefined) ?? null)}
            >
              {productGroups.map((g) => (
                <ToggleButton key={g.id} id={g.id} className="group-option" data-chain={`group:${g.id}`}>
                  <span className="group-name">{g.name}</span>
                  <span className="group-desc">{g.description}</span>
                  <span className="group-count">
                    {legislations.filter((l) => appliesTo(l, g.id)).length} legislations
                  </span>
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </div>
        </section>

        <section className="panel" aria-labelledby="legislation-title">
          <header className="panel-head">
            <div>
              <h2 id="legislation-title">Legislation</h2>
              <p>
                {group
                  ? `${legislations.length - disabled.length} of ${legislations.length} apply to ${groupName}`
                  : "Pick a product group first"}
              </p>
            </div>
            {selectedIds.size > 0 && (
              <div className="panel-tools">
                <Button className="ghost" onPress={() => setSelected(new Set())}>
                  Clear
                </Button>
              </div>
            )}
          </header>
          <div className="list">
            <ListBox
              aria-labelledby="legislation-title"
              className="leg-list"
              selectionMode="multiple"
              selectedKeys={selected}
              onSelectionChange={(keys) =>
                setSelected(keys === "all" ? new Set(legislations.map((l) => l.id).filter((id) => !disabled.includes(id))) : keys)
              }
              disabledKeys={disabled}
              dependencies={[group]}
            >
              {CATEGORIES.map((c) => (
                <ListBoxSection key={c.id} id={c.id} className="leg-section">
                  <Header className="section-head">{c.name}</Header>
                  {legislations
                    .filter((l) => l.category === c.id)
                    .map((l) => {
                      const relevant = !!group && appliesTo(l, group);
                      return (
                        <ListBoxItem
                          key={l.id}
                          id={l.id}
                          textValue={`${l.short} ${l.title}`}
                          className={relevant ? "leg-item relevant" : "leg-item"}
                          data-chain={`law:${l.id}`}
                        >
                          {({ isSelected }) => (
                            <>
                              <span className="leg-check" aria-hidden="true">
                                {isSelected && (
                                  <svg viewBox="0 0 16 16" width="12" height="12">
                                    <path
                                      d="M3.5 8.5l3 3 6-7"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    />
                                  </svg>
                                )}
                              </span>
                              <span className="leg-text">
                                <span className="leg-name">
                                  <strong>{l.short}</strong> {l.title}
                                </span>
                                <span className="leg-ref">{l.ref}</span>
                                {relevant && group && <span className="leg-scope">{l.scope[group]}</span>}
                              </span>
                            </>
                          )}
                        </ListBoxItem>
                      );
                    })}
                </ListBoxSection>
              ))}
            </ListBox>
          </div>
        </section>

        <section className="panel" aria-labelledby="data-title">
          <header className="panel-head">
            <div>
              <h2 id="data-title">Data requirements</h2>
              <p>
                {required.size
                  ? `${required.size} of ${inScope.size} data requirements required`
                  : group
                    ? `${inScope.size} data requirements across ${groupName} legislation`
                    : `${inScope.size} data requirements across all legislation`}
              </p>
            </div>
            <div className="panel-tools">
              <ToggleButton className="ghost toggle" isSelected={onlyRequired} onChange={setOnlyRequired}>
                Required only
              </ToggleButton>
            </div>
          </header>
          <div className="list">
            <DisclosureGroup allowsMultipleExpanded expandedKeys={opened} onExpandedChange={setExpanded}>
              {THEMES.map((theme) => {
                const rows = dataRequirements
                  .filter((d) => d.theme === theme.id && inScope.has(d.id))
                  .map((d) => ({ requirement: d, provisions: required.get(d.id) ?? NO_PROVISIONS }))
                  .filter((row) => !onlyRequired || row.provisions.length > 0)
                  // Required first, most-motivated first; the rest keep catalogue order.
                  .sort((a, b) => legislationCount(b.provisions) - legislationCount(a.provisions));
                if (rows.length === 0) return null;
                return (
                  <div key={theme.id} className="dp-section" role="group" aria-label={theme.name}>
                    <div className="section-head">{theme.name}</div>
                    {rows.map(({ requirement, provisions }) => {
                      const count = legislationCount(provisions);
                      const laws = [...new Set(provisions.map((p) => p.legislation))];
                      return (
                        <Disclosure
                          key={requirement.id}
                          id={requirement.id}
                          isDisabled={count === 0}
                          className={count ? `dp-item active level-${Math.min(count, 3)}` : "dp-item"}
                        >
                          <Heading className="dp-heading">
                            <Button slot="trigger" className="dp-trigger" data-chain={`req:${requirement.id}`}>
                              <span
                                className="dp-count"
                                aria-label={count ? `Required by ${plural(count, "legislation")}` : "Not required"}
                              >
                                {count || "–"}
                              </span>
                              <span className="dp-name">{requirement.name}</span>
                              <span className="dp-laws" aria-hidden="true">
                                {laws.map((id) => (
                                  <span key={id} className="law-chip">
                                    {legislationById[id].short}
                                  </span>
                                ))}
                              </span>
                              {count > 0 && (
                                <svg className="dp-chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                                  <path
                                    d="M6 4l4 4-4 4"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.8"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  />
                                </svg>
                              )}
                            </Button>
                          </Heading>
                          <DisclosurePanel className="dp-panel">
                            <ul className="dp-reqs">
                              {provisions.map((p) => {
                                const law = legislationById[p.legislation];
                                const act = p.source ? SOURCE_ACTS[p.source] : undefined;
                                return (
                                  <li key={`${p.legislation}-${p.ref}`}>
                                    <div className="req-head">
                                      <span className="law-chip strong">{law.short}</span>
                                      <Link
                                        className="req-ref"
                                        href={eurLex(p.source ?? law.celex)}
                                        target="_blank"
                                        rel="noreferrer"
                                        aria-label={`${act?.ref ?? law.ref}, ${p.ref} (opens EUR-Lex)`}
                                      >
                                        {act?.ref ?? law.ref} · {p.ref}
                                      </Link>
                                    </div>
                                    {p.quotes && (
                                      <blockquote className="req-quote" cite={eurLex(p.source ?? law.celex)}>
                                        {p.quotes.map((q, j) => (
                                          <p key={j}>
                                            {j > 0 && <span aria-hidden="true">… </span>}
                                            {q}
                                          </p>
                                        ))}
                                      </blockquote>
                                    )}
                                    <p className={p.quotes ? "req-note" : undefined}>{p.text}</p>
                                  </li>
                                );
                              })}
                            </ul>
                          </DisclosurePanel>
                        </Disclosure>
                      );
                    })}
                  </div>
                );
              })}
            </DisclosureGroup>
          </div>
        </section>

        <section className="panel" aria-labelledby="standards-title">
          <header className="panel-head">
            <div>
              <h2 id="standards-title">Standards</h2>
              <p>
                {inView.size
                  ? `${plural(standardCount, "standard")} behind ${plural(inView.size, "data requirement")}${opened.length ? " opened" : ""}`
                  : "Behind the data requirements"}
              </p>
            </div>
          </header>
          <div className="list">
            {inView.size === 0 && <p className="empty">Select a legislation to see the standards behind its data requirements.</p>}
            {groupsByLaw.map(({ law, groups: lawGroups }) => (
              <div key={law.id} className="dp-section" role="group" aria-label={law.short}>
                <div className="section-head">{law.short}</div>
                <ul className="std-refs">
                  {lawGroups.map((group) => (
                    <li key={group.standards.map((st) => st.id).join()}>
                      <CitationGroupRow group={group} law={law} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {notes.map((law) => (
              <p key={law.id} className="std-note">
                <span className="law-chip">{law.short}</span> {law.standardsNote}
              </p>
            ))}
            {targeted.length > 0 && (
              <div className="dp-section" role="group" aria-label="Named by no act">
                <div className="section-head">Named by no act</div>
                <p className="std-note">These target the data requirement by their own scope, without legal weight from the acts.</p>
                <ul className="std-refs">
                  {targeted.map((target) => (
                    <li key={target.standard.id}>
                      <TargetedRow target={target} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {withoutStandard.length > 0 && (
              <div className="dp-section" role="group" aria-label="No standard found">
                <div className="section-head">No standard found</div>
                <ul className="std-none">
                  {withoutStandard.map(({ id, name, laws }) => (
                    <li key={id} data-chain={`none:${id}`}>
                      <span>{name}</span>
                      <span className="dp-laws">
                        {laws.map((lawId) => (
                          <span key={lawId} className="law-chip">
                            {legislationById[lawId].short}
                          </span>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {citedOnlyCount > 0 && (
              <Disclosure className="std-more">
                <Heading className="dp-heading">
                  <Button slot="trigger" className="std-more-trigger">
                    <svg className="dp-chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                      <path
                        d="M6 4l4 4-4 4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    {plural(citedOnlyCount, "more standard")} named, behind no data requirement for {groupName}
                  </Button>
                </Heading>
                <DisclosurePanel>
                  {citedOnlyByLaw.map(({ law, groups: lawGroups }) => (
                    <div key={law.id} role="group" aria-label={law.short}>
                      <div className="section-head">{law.short}</div>
                      {[...new Set(lawGroups.map((g) => whereCited(g.citations, law.celex)))].map((where) => (
                        <div key={where}>
                          <p className="std-note">{where}</p>
                          <ul className="std-refs">
                            {lawGroups
                              .filter((g) => whereCited(g.citations, law.celex) === where)
                              .map((g) => (
                                <li key={g.standards.map((st) => st.id).join()}>
                                  <CitationGroupRow group={g} law={law} showWhere={false} />
                                </li>
                              ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  ))}
                </DisclosurePanel>
              </Disclosure>
            )}
          </div>
        </section>

        <section className="panel" aria-labelledby="ontologies-title">
          <header className="panel-head">
            <div>
              <h2 id="ontologies-title">Ontologies</h2>
              <p>
                {inView.size
                  ? `${plural(termCount, "open definition")} of ${plural(inView.size, "data requirement")}${opened.length ? " opened" : ""}`
                  : "Open definitions of the data requirements"}
              </p>
            </div>
          </header>
          <div className="list">
            {inView.size === 0 && <p className="empty">Select a legislation to see what defines its data requirements.</p>}
            {termGroups.map(({ ontology, terms }) => (
              <div key={ontology.id} className="dp-section" role="group" aria-label={ontology.name} data-chain={`ontology:${ontology.id}`}>
                <div className="section-head term-head">
                  {ontology.name}
                  <span className="law-chip">{ontology.license}</span>
                </div>
                <ul className="std-refs">
                  {terms.map((entry) => (
                    <li key={entry.term.id}>
                      <TermRow {...entry} ontology={ontology} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
        <ChainColumn
          id="data-points"
          anchor="point"
          title="Data points"
          subtitle={dataPoints.length ? `${dataPoints.length} linked` : "Behind the ontologies"}
          items={dataPoints}
          empty={chain.dataPoints.length ? "None linked to the ontologies in view." : "No data points yet."}
        />
        <ChainArrows boardRef={boardRef} relations={relations} />
      </main>

      <p className="hint small">
        Quoted passages are taken word for word from the Official Journal; the notes beside them are plain-language
        readings, not legal advice.
      </p>
    </div>
  );
}
