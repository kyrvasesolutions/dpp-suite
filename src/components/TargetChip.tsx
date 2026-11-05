import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-aria-components";
import { CATEGORIES, TARGET_TYPES, eurLex, type TargetType } from "../model/legislation";

const typeOf = (id: TargetType) => TARGET_TYPES.find((t) => t.id === id)!;

/** Gives an element and everything in it its compliance target type's colours. */
export const targetStyle = (id: TargetType) => {
  const { color, onColor, ink } = typeOf(id);
  return { "--target-color": color, "--target-on": onColor, "--target-ink": ink } as CSSProperties;
};

/** A compliance target's name, in its type's colour. A specification saved before types existed has none. */
export function TargetChip({ type, title, children }: { type?: TargetType; title?: string; children: ReactNode }) {
  return (
    <span className={type ? "law-chip target" : "law-chip"} style={type ? targetStyle(type) : undefined} title={title}>
      {children}
    </span>
  );
}

function TargetBand({ type }: { type: TargetType }) {
  const { audience, name } = typeOf(type);
  return (
    <span className="target-band" style={targetStyle(type)}>
      <strong>{audience}</strong> {name}
    </span>
  );
}

/** The categories in list order, marking where each type begins. */
export const TARGET_SECTIONS = CATEGORIES.map((category, i) => ({
  category,
  first: CATEGORIES[i - 1]?.type !== category.type,
}));

/** A category's heading, led by its type's band when it is the first of that type. */
export function TargetSectionHead({ type, first, name }: { type: TargetType; first: boolean; name: string }) {
  return (
    <>
      {first && <TargetBand type={type} />}
      {name}
    </>
  );
}

/** Below the list: types with no targets yet, so the choice of three stays visible, and the rule on labels. */
export function TargetTypesAfterList() {
  const empty = TARGET_TYPES.filter((t) => !CATEGORIES.some((c) => c.type === t.id));
  return (
    <>
      {empty.map((t) => (
        <div key={t.id} className="section-head">
          <TargetBand type={t.id} />
          <p className="target-band-empty">None added yet.</p>
        </div>
      ))}
      <p className="std-note">
        In the EU, since 27 September 2026 a sustainability label must rest on a certification scheme or a public
        authority (
        <Link href={eurLex("32024L0825")} target="_blank" rel="noreferrer" className="req-ref">
          Directive (EU) 2024/825
        </Link>
        ). Being listed here does not confirm that a label meets that test.
      </p>
    </>
  );
}
