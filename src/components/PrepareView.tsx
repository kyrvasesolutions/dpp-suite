import { useMemo, useState } from "react";
import { Checkbox, Link, ToggleButton, ToggleButtonGroup } from "react-aria-components";
import { linksBehind, provisionsByRequirement, type Chain } from "../model/chain";
import { THEMES, targetUrl, type ProductGroup } from "../model/legislation";
import { useMediaQuery } from "../useMediaQuery";
import { TargetChip, targetStyle } from "./TargetChip";

const PROGRESS_KEY = "dpp-trace.join-progress";

/** Steps done, per data space and product group. */
type Progress = Record<string, string[]>;

function readProgress(): Progress {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? "{}") as Progress;
  } catch {
    return {};
  }
}

function writeProgress(progress: Progress) {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    // Storage blocked or full: the ticks last until the page closes.
  }
}

/**
 * What a company does to join a data space, for its product group, and the data to
 * have ready. Data that legislation already asks for is marked, since the work for
 * one target counts towards the other.
 */
export function PrepareView({ chain }: { chain: Chain }) {
  const { legislations, legislationById, productGroups, dataRequirements, standards } = chain;
  const wide = useMediaQuery("(min-width: 768px)");
  const spaces = useMemo(() => legislations.filter((l) => l.type === "b2b"), [legislations]);
  const [group, setGroup] = useState<ProductGroup | null>(null);
  const [spaceId, setSpaceId] = useState<string | null>(spaces[0]?.id ?? null);
  const [progress, setProgress] = useState<Progress>(readProgress);

  const space = spaceId ? legislationById[spaceId] : undefined;
  const groupName = productGroups.find((g) => g.id === group)?.name;
  const key = `${spaceId}|${group}`;
  const done = useMemo(() => new Set(progress[key] ?? []), [progress, key]);

  const steps = useMemo(
    () => chain.joinSteps.filter((s) => s.legislation === spaceId && (s.group === null || s.group === group)),
    [chain.joinSteps, group, spaceId],
  );
  const doneCount = steps.filter((s) => done.has(s.id)).length;

  const required = useMemo(
    () => (group && spaceId ? provisionsByRequirement(chain, group, new Set([spaceId])) : new Map()),
    [chain, group, spaceId],
  );

  const rows = useMemo(() => {
    if (!group || !spaceId) return [];
    return THEMES.map((theme) => ({
      theme,
      items: dataRequirements
        .filter((d) => d.theme === theme.id && required.has(d.id))
        .map((d) => ({
          requirement: d,
          reading: chain.provisions.filter(
            (p) => p.legislation === spaceId && p.dataRequirement === d.id && p.groups.includes(group),
          ),
          standards: [...new Set(linksBehind(chain, spaceId, d.id, group).map((l) => standards[l.standard]?.ref))],
          alsoBy: [
            ...new Set(
              chain.provisions
                .filter(
                  (p) =>
                    p.dataRequirement === d.id &&
                    p.groups.includes(group) &&
                    legislationById[p.legislation].type === "b2g",
                )
                .map((p) => p.legislation),
            ),
          ].map((id) => legislationById[id]),
        })),
    })).filter((section) => section.items.length > 0);
  }, [chain, dataRequirements, group, legislationById, required, spaceId, standards]);

  const dataCount = rows.reduce((n, r) => n + r.items.length, 0);
  const reused = rows.reduce((n, r) => n + r.items.filter((i) => i.alsoBy.length > 0).length, 0);

  const toggle = (id: string, isDone: boolean) => {
    const next = { ...progress, [key]: isDone ? [...done, id] : [...done].filter((x) => x !== id) };
    setProgress(next);
    writeProgress(next);
  };

  return (
    <div className={wide ? "app wide" : "app narrow"}>
      <header className="topbar">
        <div className="brand">
          <h1>Prepare to join a data space</h1>
        </div>
        {group && space && (
          <div className="brand">
            <span className="stat">
              <strong>
                {doneCount}/{steps.length}
              </strong>{" "}
              steps done
            </span>
            <span className="stat">
              <strong>{dataCount}</strong> data requirements
            </span>
            <span className="stat" title="Data requirements legislation also asks for, for this product group">
              <strong>{reused}</strong> shared with legislation
            </span>
          </div>
        )}
      </header>

      <p className="hint">
        {group
          ? "Tick steps as you finish them; they are kept in this browser. This is our reading of the published standards, not advice from the data space."
          : "Choose your product group to see the steps and data for joining."}
      </p>

      <main className="req-board prep-board">
        <section className="panel" aria-labelledby="p-start-title">
          <header className="panel-head">
            <div>
              <h2 id="p-start-title">Product Group</h2>
              <p>What you make</p>
            </div>
          </header>
          <div className="list">
            <ToggleButtonGroup
              aria-labelledby="p-start-title"
              className="group-options"
              orientation="vertical"
              selectionMode="single"
              selectedKeys={group ? [group] : []}
              onSelectionChange={(keys) => setGroup(([...keys][0] as ProductGroup | undefined) ?? null)}
            >
              {productGroups.map((g) => (
                <ToggleButton key={g.id} id={g.id} className="group-option">
                  <span className="group-name">{g.name}</span>
                  <span className="group-desc">{g.description}</span>
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
            <div className="section-head" id="p-space-title">
              Data space
            </div>
            <ToggleButtonGroup
              aria-labelledby="p-space-title"
              className="group-options"
              orientation="vertical"
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={spaceId ? [spaceId] : []}
              onSelectionChange={(keys) => setSpaceId(String([...keys][0]))}
            >
              {spaces.map((s) => (
                <ToggleButton key={s.id} id={s.id} className="group-option">
                  <span className="group-name">
                    <TargetChip type={s.type}>{s.short}</TargetChip>
                  </span>
                  <span className="group-desc">{s.title}</span>
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </div>
        </section>

        <section className="panel" aria-labelledby="p-steps-title" style={space ? targetStyle(space.type) : undefined}>
          <header className="panel-head">
            <div>
              <h2 id="p-steps-title">Steps to join</h2>
              <p>{group && space ? `${space.short} for ${groupName}` : "Pick a product group first"}</p>
            </div>
          </header>
          <div className="list">
            {group && space ? (
              <>
                <p className="prep-scope">
                  {space.scope[group]}{" "}
                  <Link href={targetUrl(space)} target="_blank" rel="noreferrer" className="req-ref">
                    {space.ref}
                  </Link>
                </p>
                <div
                  className="prep-progress"
                  role="progressbar"
                  aria-label="Steps done"
                  aria-valuemin={0}
                  aria-valuemax={steps.length}
                  aria-valuenow={doneCount}
                >
                  <span style={{ width: `${steps.length ? (doneCount / steps.length) * 100 : 0}%` }} />
                </div>
                <ol className="prep-steps">
                  {steps.map((s) => (
                    <li key={s.id}>
                      <div className="prep-step">
                        <Checkbox className="prep-check" isSelected={done.has(s.id)} onChange={(isDone) => toggle(s.id, isDone)}>
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
                              <span>
                                <span className="prep-step-title">{s.title}</span>
                                <span className="prep-step-detail">{s.detail}</span>
                              </span>
                            </>
                          )}
                        </Checkbox>
                        <Link
                          href={s.url}
                          target="_blank"
                          rel="noreferrer"
                          className="req-ref prep-step-source"
                          aria-label={`${s.source}, source for ${s.title}`}
                        >
                          {s.source}
                        </Link>
                      </div>
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <p className="empty">Choose a product group to see your steps.</p>
            )}
          </div>
        </section>

        <section className="panel" aria-labelledby="p-data-title">
          <header className="panel-head">
            <div>
              <h2 id="p-data-title">Data to have ready</h2>
              <p>{group ? `${dataCount} data requirements, ${reused} also asked for by legislation` : "Pick a product group first"}</p>
            </div>
          </header>
          <div className="list">
            {rows.length === 0 && <p className="empty">Choose a product group to see the data its use cases ask for.</p>}
            {rows.map(({ theme, items }) => (
              <div key={theme.id} className="dp-section" role="group" aria-label={theme.name}>
                <div className="section-head">{theme.name}</div>
                <ul className="prep-data">
                  {items.map(({ requirement, reading, standards: refs, alsoBy }) => (
                    <li key={requirement.id} className="prep-item">
                      <span className="schema-name">{requirement.name}</span>
                      {reading.map((p) => (
                        <span key={p.ref} className="prep-item-reading">
                          {p.text}
                        </span>
                      ))}
                      <span className="leg-ref">{refs.join(", ")}</span>
                      {alsoBy.length > 0 && (
                        <span className="prep-item-also">
                          Also for
                          {alsoBy.map((l) => (
                            <TargetChip key={l.id} type={l.type} title={l.ref}>
                              {l.short}
                            </TargetChip>
                          ))}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
