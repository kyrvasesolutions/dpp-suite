import { useMemo, useState, type ReactNode } from "react";
import {
  Button,
  Disclosure,
  DisclosureGroup,
  DisclosurePanel,
  Header,
  Heading,
  Link,
  ListBox,
  ListBoxItem,
  ListBoxSection,
  ToggleButton,
  ToggleButtonGroup,
  type Key,
} from "react-aria-components";
import {
  CATEGORIES,
  DATA_POINTS,
  LEGISLATIONS,
  PRODUCT_GROUPS,
  SOURCE_ACTS,
  THEMES,
  appliesTo,
  dataPointsFor,
  eurLex,
  legislationById,
  legislationCount,
  requirementsByDataPoint,
  type ProductGroup,
  type Requirement,
} from "../model/legislation";
import { useMediaQuery } from "../useMediaQuery";

interface RequirementsExplorerProps {
  /** View switcher shown next to the title. */
  nav: ReactNode;
}

const NO_REQUIREMENTS: Requirement[] = [];

/**
 * Three columns: pick a product group, then the legislations to check; the
 * data points they require are the union of all selected legislations, with
 * one row per generic data point and a count of the legislations behind it.
 */
export function RequirementsExplorer({ nav }: RequirementsExplorerProps) {
  const wide = useMediaQuery("(min-width: 768px)");
  const [group, setGroup] = useState<ProductGroup | null>(null);
  const [selected, setSelected] = useState<Set<Key>>(new Set());
  const [expanded, setExpanded] = useState<Set<Key>>(new Set());
  const [onlyRequired, setOnlyRequired] = useState(false);

  const selectedIds = useMemo(() => new Set([...selected].map(String)), [selected]);
  const disabled = useMemo(
    () => LEGISLATIONS.filter((l) => !group || !appliesTo(l, group)).map((l) => l.id),
    [group],
  );
  const inScope = useMemo(() => dataPointsFor(group), [group]);
  const required = useMemo(
    () => (group ? requirementsByDataPoint(group, selectedIds) : new Map<string, Requirement[]>()),
    [group, selectedIds],
  );

  const shared = [...required.values()].filter((rs) => legislationCount(rs) > 1).length;

  const chooseGroup = (next: ProductGroup | null) => {
    setGroup(next);
    // Keep legislations that still apply; their requirements follow the new group.
    setSelected((s) => new Set([...s].filter((id) => next && appliesTo(legislationById[String(id)], next))));
    setExpanded(new Set());
  };

  const groupName = PRODUCT_GROUPS.find((g) => g.id === group)?.name;

  return (
    <div className={wide ? "app wide" : "app narrow"}>
      <header className="topbar">
        <div className="brand">
          <h1>DPP requirements</h1>
          {nav}
        </div>
        <div className="brand">
          <span className="stat">
            <strong>{selectedIds.size}</strong> legislation{selectedIds.size === 1 ? "" : "s"}
          </span>
          <span className="stat">
            <strong>{required.size}</strong> data points
          </span>
          <span className="stat" title="Data points required by more than one selected legislation">
            <strong>{shared}</strong> shared
          </span>
        </div>
      </header>

      <p className="hint">
        {!group
          ? "Choose a product group to see which legislations apply to it."
          : selectedIds.size === 0
            ? `Select one or more legislations for ${groupName} to see the data they require.`
            : "Open a data point to see each legislation's requirement behind it."}
      </p>

      <main className="req-board">
        <section className="panel req-groups" aria-labelledby="group-title">
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
              {PRODUCT_GROUPS.map((g) => (
                <ToggleButton key={g.id} id={g.id} className="group-option">
                  <span className="group-name">{g.name}</span>
                  <span className="group-desc">{g.description}</span>
                  <span className="group-count">
                    {LEGISLATIONS.filter((l) => appliesTo(l, g.id)).length} legislations
                  </span>
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </div>
        </section>

        <section className="panel req-legislation" aria-labelledby="legislation-title">
          <header className="panel-head">
            <div>
              <h2 id="legislation-title">Legislation</h2>
              <p>
                {group
                  ? `${LEGISLATIONS.length - disabled.length} of ${LEGISLATIONS.length} apply to ${groupName}`
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
                setSelected(keys === "all" ? new Set(LEGISLATIONS.map((l) => l.id).filter((id) => !disabled.includes(id))) : keys)
              }
              disabledKeys={disabled}
              dependencies={[group]}
            >
              {CATEGORIES.map((c) => (
                <ListBoxSection key={c.id} id={c.id} className="leg-section">
                  <Header className="section-head">{c.name}</Header>
                  {LEGISLATIONS.filter((l) => l.category === c.id).map((l) => {
                    const relevant = !!group && appliesTo(l, group);
                    return (
                      <ListBoxItem
                        key={l.id}
                        id={l.id}
                        textValue={`${l.short} ${l.title}`}
                        className={relevant ? "leg-item relevant" : "leg-item"}
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

        <section className="panel req-data" aria-labelledby="data-title">
          <header className="panel-head">
            <div>
              <h2 id="data-title">Data requirements</h2>
              <p>
                {required.size
                  ? `${required.size} of ${inScope.size} data points required`
                  : group
                    ? `${inScope.size} data points across ${groupName} legislation`
                    : `${inScope.size} data points across all legislation`}
              </p>
            </div>
            <div className="panel-tools">
              <ToggleButton className="ghost toggle" isSelected={onlyRequired} onChange={setOnlyRequired}>
                Required only
              </ToggleButton>
            </div>
          </header>
          <div className="list">
            <DisclosureGroup
              allowsMultipleExpanded
              expandedKeys={[...expanded].filter((k) => required.has(String(k)))}
              onExpandedChange={setExpanded}
            >
              {THEMES.map((theme) => {
                const rows = DATA_POINTS.filter((d) => d.theme === theme.id && inScope.has(d.id))
                  .map((d) => ({ point: d, reqs: required.get(d.id) ?? NO_REQUIREMENTS }))
                  .filter((row) => !onlyRequired || row.reqs.length > 0)
                  // Required first, most-motivated first; the rest keep catalogue order.
                  .sort((a, b) => legislationCount(b.reqs) - legislationCount(a.reqs));
                if (rows.length === 0) return null;
                return (
                  <div key={theme.id} className="dp-section" role="group" aria-label={theme.name}>
                    <div className="section-head">{theme.name}</div>
                    {rows.map(({ point, reqs }) => {
                      const count = legislationCount(reqs);
                      const laws = [...new Set(reqs.map((r) => r.legislation))];
                      return (
                        <Disclosure
                          key={point.id}
                          id={point.id}
                          isDisabled={count === 0}
                          className={count ? `dp-item active level-${Math.min(count, 3)}` : "dp-item"}
                        >
                          <Heading className="dp-heading">
                            <Button slot="trigger" className="dp-trigger">
                              <span
                                className="dp-count"
                                aria-label={count ? `Required by ${count} legislation${count > 1 ? "s" : ""}` : "Not required"}
                              >
                                {count || "–"}
                              </span>
                              <span className="dp-name">{point.name}</span>
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
                              {reqs.map((r) => {
                                const law = legislationById[r.legislation];
                                const act = r.source ? SOURCE_ACTS[r.source] : undefined;
                                return (
                                  <li key={`${r.legislation}-${r.ref}`}>
                                    <div className="req-head">
                                      <span className="law-chip strong">{law.short}</span>
                                      <Link
                                        className="req-ref"
                                        href={eurLex(r.source ?? law.celex)}
                                        target="_blank"
                                        rel="noreferrer"
                                        aria-label={`${act?.ref ?? law.ref}, ${r.ref} (opens EUR-Lex)`}
                                      >
                                        {act?.ref ?? law.ref} · {r.ref}
                                      </Link>
                                    </div>
                                    {r.quotes && (
                                      <blockquote className="req-quote" cite={eurLex(r.source ?? law.celex)}>
                                        {r.quotes.map((q, i) => (
                                          <p key={i}>
                                            {i > 0 && <span aria-hidden="true">… </span>}
                                            {q}
                                          </p>
                                        ))}
                                      </blockquote>
                                    )}
                                    <p className={r.quotes ? "req-note" : undefined}>{r.text}</p>
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
      </main>

      <p className="hint small">
        Quoted passages are taken word for word from the Official Journal; the notes beside them are plain-language
        readings, not legal advice.
      </p>
    </div>
  );
}
