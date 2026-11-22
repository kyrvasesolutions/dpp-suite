/**
 * The acceptance cases (Cycle 5): every failure class of the contract pack, and the two limit classes that are built in the
 * tests, each run end to end through the UI against each of the three routes, plus one positive case per route and the
 * cases that look at the whole run. This file is the single list: the specs run it, `coverage.json` is its matrix, and
 * `tests/unit/acceptanceCoverage.test.ts` checks that the two agree and that no pack failure class is missing.
 *
 * Each class-and-route case has one expected outcome:
 *   rejected-at-ingress        the file is refused with a typed error and nothing reaches the route
 *   route-hold-output-refused  the route is on hold with these rules and no file is made
 *   registry-draft-only        the registry route makes only its HOLD draft, with these holds
 *   field-withheld             a field the recipient may not see is absent from the output and the views
 *   output-made                the output is made and is the golden one
 *   reproducible               the same inputs give the same output bytes
 *   NA                         the class cannot affect the route; the case still asserts the route is unchanged
 */
export const ROUTES = ["customer-pdf", "erp-staging-csv", "registry-prep-json"] as const;
export type RouteId = (typeof ROUTES)[number];
export const ROUTE_CODE: Record<RouteId, string> = { "customer-pdf": "PDF", "erp-staging-csv": "CSV", "registry-prep-json": "REG" };

export type Outcome = "rejected-at-ingress" | "route-hold-output-refused" | "registry-draft-only" | "field-withheld" | "output-made" | "reproducible" | "scan-clean" | "NA";

export interface Case {
  id: string;
  title: string;
  /** The failure class (the pack's failure-case file name without its extension), or the kind of case. */
  class: string;
  route: RouteId | "all";
  funcs: string[];
  criteria: string[];
  gates: string[];
  outcome: Outcome;
  expected: string;
  /** Why a class cannot affect this route (outcome NA). The case still asserts that the route is unchanged. */
  na?: string;
  /** Where the case is built or run differently from the others. */
  note?: string;
}

export interface Pair {
  erp: string;
  lab: string;
}
export const CLEAN: Pair = { erp: "d03a-erp-extract.csv", lab: "d03a-lab-assessment.json" };

/** A class whose file is refused at ingress. `file` is a fixture, or built in the test (`built`). */
export interface IngressClass {
  kind: "ingress";
  role: "erp" | "lab";
  file?: string;
  built?: "too-large" | "deadline";
  stage: string;
  code: string;
  funcs: string[];
  criteria: string[];
  gates: string[];
  note?: string;
}

/** A class whose files are accepted and change what the routes can do. */
export interface EffectClass {
  kind: "effect";
  pair: Pair;
  routes: Record<RouteId, { outcome: Outcome; rules: string[]; na?: string }>;
  funcs: string[];
  criteria: string[];
  gates: string[];
  note?: string;
}

const NA_NO_FOOTPRINT = "The registry route carries only the product model identifier, the manufacturer identifier and the commodity code; this class does not touch them.";

export const CLASSES: Record<string, IngressClass | EffectClass> = {
  "wrong-encoding": { kind: "ingress", role: "erp", file: "erp-latin1.csv", stage: "bytes", code: "wrong-encoding", funcs: ["FUNC-039", "FUNC-133"], criteria: ["C2-02", "C5-04"], gates: ["G05"] },
  "missing-column": { kind: "ingress", role: "erp", file: "erp-missing-alloy-column.csv", stage: "structure", code: "missing-column", funcs: ["FUNC-039"], criteria: ["C2-02", "C5-04"], gates: ["G05", "G07"] },
  "decimal-comma": { kind: "ingress", role: "erp", file: "erp-decimal-comma.csv", stage: "semantics", code: "decimal-comma", funcs: ["FUNC-039", "FUNC-017"], criteria: ["C2-02", "C2-04", "C5-04"], gates: ["G05", "G06"] },
  "duplicate-json-key": { kind: "ingress", role: "lab", file: "lab-duplicate-key.json", stage: "parse", code: "duplicate-key", funcs: ["FUNC-039", "FUNC-133"], criteria: ["C2-02", "C5-04"], gates: ["G05"] },
  "non-finite-number": { kind: "ingress", role: "lab", file: "lab-non-finite.json", stage: "parse", code: "non-finite-number", funcs: ["FUNC-039", "FUNC-133"], criteria: ["C2-02", "C5-04"], gates: ["G05", "G06"] },
  "missing-unit": { kind: "ingress", role: "lab", file: "lab-missing-unit.json", stage: "semantics", code: "missing-unit", funcs: ["FUNC-039", "FUNC-030"], criteria: ["C2-04", "C5-04"], gates: ["G06"] },
  "wrong-unit": { kind: "ingress", role: "lab", file: "lab-wrong-unit.json", stage: "semantics", code: "wrong-unit", funcs: ["FUNC-039", "FUNC-030"], criteria: ["C2-04", "C5-04"], gates: ["G06"] },
  "unit-alias": { kind: "ingress", role: "lab", file: "lab-unit-alias.json", stage: "semantics", code: "wrong-unit", funcs: ["FUNC-039", "FUNC-030"], criteria: ["C2-04", "C5-04"], gates: ["G06"] },
  "multiple-records": { kind: "ingress", role: "erp", file: "erp-two-rows.csv", stage: "structure", code: "multiple-records", funcs: ["FUNC-133"], criteria: ["C5-04"], gates: ["G14"] },
  "too-deep": { kind: "ingress", role: "lab", file: "lab-too-deep.json", stage: "parse", code: "too-deep", funcs: ["FUNC-133"], criteria: ["C5-04"], gates: ["G14"] },
  "too-large": { kind: "ingress", role: "erp", built: "too-large", stage: "bytes", code: "too-large", funcs: ["FUNC-133"], criteria: ["C5-04"], gates: ["G14"], note: "No pack fixture: a file one byte over the declared limit is built in the test." },
  deadline: { kind: "ingress", role: "erp", built: "deadline", file: "d03a-erp-extract.csv", stage: "bytes", code: "deadline", funcs: ["FUNC-133"], criteria: ["C5-04"], gates: ["G14"], note: "No pack fixture: the clean extract is imported while the page's clock jumps past the 30-second deadline." },

  "ambiguous-footprint": {
    kind: "effect",
    pair: { erp: CLEAN.erp, lab: "lab-two-footprints.json" },
    routes: {
      "customer-pdf": { outcome: "route-hold-output-refused", rules: ["RR-SEVERAL-RESULTS"] },
      "erp-staging-csv": { outcome: "route-hold-output-refused", rules: ["RR-SEVERAL-RESULTS"] },
      "registry-prep-json": { outcome: "NA", rules: ["RR-STANDING-HOLD"], na: NA_NO_FOOTPRINT },
    },
    funcs: ["FUNC-126", "FUNC-012"],
    criteria: ["C3-04", "C5-04"],
    gates: ["G03", "G04"],
  },
  "blocked-export": {
    kind: "effect",
    pair: { erp: "erp-missing-recycled-content.csv", lab: CLEAN.lab },
    routes: {
      "customer-pdf": { outcome: "route-hold-output-refused", rules: ["RR-MISSING"] },
      "erp-staging-csv": { outcome: "route-hold-output-refused", rules: ["RR-MISSING"] },
      "registry-prep-json": { outcome: "NA", rules: ["RR-STANDING-HOLD"], na: NA_NO_FOOTPRINT },
    },
    funcs: ["FUNC-012", "FUNC-041", "FUNC-042"],
    criteria: ["C3-02", "C4-01", "C5-04"],
    gates: ["G03", "G10"],
  },
  "conflicting-assertions": {
    kind: "effect",
    pair: { erp: CLEAN.erp, lab: "lab-conflicting-alloy.json" },
    routes: {
      "customer-pdf": { outcome: "route-hold-output-refused", rules: ["RR-CHALLENGED", "RR-DERIVED-UNDETERMINABLE"] },
      "erp-staging-csv": { outcome: "route-hold-output-refused", rules: ["RR-CHALLENGED"] },
      "registry-prep-json": { outcome: "NA", rules: ["RR-STANDING-HOLD"], na: NA_NO_FOOTPRINT },
    },
    funcs: ["FUNC-065", "FUNC-012"],
    criteria: ["C2-05", "C3-03", "C5-04"],
    gates: ["G03", "G04"],
  },
  "evidence-digest-missing": {
    kind: "effect",
    pair: { erp: CLEAN.erp, lab: "lab-evidence-digest-missing.json" },
    routes: {
      "customer-pdf": { outcome: "route-hold-output-refused", rules: ["RR-EVIDENCE-DIGEST"] },
      "erp-staging-csv": { outcome: "route-hold-output-refused", rules: ["RR-EVIDENCE-DIGEST"] },
      "registry-prep-json": { outcome: "NA", rules: ["RR-STANDING-HOLD"], na: NA_NO_FOOTPRINT },
    },
    funcs: ["FUNC-012", "FUNC-023"],
    criteria: ["C3-03", "C5-04"],
    gates: ["G03", "G08"],
  },
  "unknown-code": {
    kind: "effect",
    pair: { erp: "erp-unknown-company-code.csv", lab: CLEAN.lab },
    routes: {
      "customer-pdf": { outcome: "route-hold-output-refused", rules: ["RR-UNKNOWN-CODE"] },
      "erp-staging-csv": { outcome: "route-hold-output-refused", rules: ["RR-UNKNOWN-CODE"] },
      "registry-prep-json": { outcome: "registry-draft-only", rules: ["RR-STANDING-HOLD", "RR-UNKNOWN-CODE"] },
    },
    funcs: ["FUNC-012", "FUNC-039"],
    criteria: ["C2-03", "C3-03", "C5-04"],
    gates: ["G03", "G12"],
  },
  leakage: {
    kind: "effect",
    pair: CLEAN,
    routes: {
      "customer-pdf": { outcome: "field-withheld", rules: [] },
      "erp-staging-csv": { outcome: "field-withheld", rules: [] },
      "registry-prep-json": { outcome: "field-withheld", rules: ["RR-STANDING-HOLD"] },
    },
    funcs: ["FUNC-019", "FUNC-046"],
    criteria: ["C3-01", "C5-04"],
    gates: ["G05"],
  },
  "prohibited-disclosure": {
    kind: "effect",
    pair: CLEAN,
    routes: {
      "customer-pdf": { outcome: "field-withheld", rules: [] },
      "erp-staging-csv": { outcome: "field-withheld", rules: [] },
      "registry-prep-json": { outcome: "field-withheld", rules: ["RR-STANDING-HOLD"] },
    },
    funcs: ["FUNC-019", "FUNC-046"],
    criteria: ["C3-01", "C5-04"],
    gates: ["G05"],
    note: "The pack's fixture is a route variant that requires denied properties; it cannot be imported, so the unit tests run that variant. Here the recipient views show every denied property as withheld and no output holds one.",
  },
  reproducibility: {
    kind: "effect",
    pair: CLEAN,
    routes: {
      "customer-pdf": { outcome: "reproducible", rules: [] },
      "erp-staging-csv": { outcome: "reproducible", rules: [] },
      "registry-prep-json": { outcome: "reproducible", rules: ["RR-STANDING-HOLD"] },
    },
    funcs: ["FUNC-041", "FUNC-042", "FUNC-043", "FUNC-023"],
    criteria: ["C4-04", "C5-04"],
    gates: ["G08"],
  },
};

const EXPECT_TEXT: Record<Outcome, string> = {
  "rejected-at-ingress": "the file is refused with its typed error, no record is made, and the route has no output",
  "route-hold-output-refused": "the route is on hold with the named rules and no file is made",
  "registry-draft-only": "only the HOLD draft is made, with the named holds, and it is never submitted",
  "field-withheld": "no field the recipient may not see is in the output or the recipient views",
  "output-made": "the output is made and is the golden one",
  reproducible: "two separate runs give the same output bytes, the golden ones",
  "scan-clean": "the scan finds no source value",
  NA: "the class cannot affect this route; the route is unchanged",
};

export const SHORT: Record<string, string> = Object.fromEntries(
  Object.keys(CLASSES).map((k) => [k, k.toUpperCase().replace(/[^A-Z0-9]+/g, "-")]),
);

const classCases = (): Case[] =>
  Object.entries(CLASSES).flatMap(([name, c]) =>
    ROUTES.map((route): Case => {
      const base = { id: `AC-${SHORT[name]}-${ROUTE_CODE[route]}`, class: name, route, funcs: c.funcs, criteria: c.criteria, gates: c.gates, ...(c.note ? { note: c.note } : {}) };
      if (c.kind === "ingress") {
        return { ...base, title: `${name} is refused at ingress and nothing reaches ${route}`, outcome: "rejected-at-ingress", expected: `${c.stage} stage, error ${c.code}: ${EXPECT_TEXT["rejected-at-ingress"]}` };
      }
      const r = c.routes[route];
      return {
        ...base,
        title: `${name} on ${route}: ${r.outcome}`,
        outcome: r.outcome,
        expected: `${EXPECT_TEXT[r.outcome]}${r.rules.length ? ` (${r.rules.join(", ")})` : ""}`,
        ...(r.na ? { na: r.na } : {}),
      };
    }),
  );

const other: Case[] = [
  ...ROUTES.map((route): Case => ({
    id: `AC-POSITIVE-${ROUTE_CODE[route]}`,
    title: `the clean pair makes the ${route} output`,
    class: "positive",
    route,
    funcs: ["FUNC-041", "FUNC-042", "FUNC-043", "FUNC-125"],
    criteria: ["C4-01", "C4-02", "C4-03", "C5-04"],
    gates: ["G01", "G07", "G10"],
    outcome: route === "registry-prep-json" ? "registry-draft-only" : "output-made",
    expected: route === "registry-prep-json" ? "the HOLD draft is made, equals the golden file and is never submitted" : "the output is made and equals the golden file",
  })),
  {
    id: "AC-REPRODUCIBLE-ALL",
    title: "two separate browsers give byte-identical outputs on all three routes",
    class: "reproducibility",
    route: "all",
    funcs: ["FUNC-041", "FUNC-042", "FUNC-043", "FUNC-023"],
    criteria: ["C4-04", "C5-04"],
    gates: ["G08"],
    outcome: "reproducible",
    expected: "the same record digest and the same bytes for the PDF, the CSV and the registry draft, and importing again stores nothing new",
  },
  {
    id: "AC-G14-NO-PARTIAL",
    title: "a two-row extract imported after a good record changes nothing: no partial success",
    class: "multiple-records",
    route: "all",
    funcs: ["FUNC-133"],
    criteria: ["C5-04"],
    gates: ["G14"],
    outcome: "rejected-at-ingress",
    expected: "the extract is refused, the central record stays at version 1 and all three outputs are still the golden ones",
    note: "Run after a clean import in the same browser.",
  },
  {
    id: "AC-CONFLICT-BOTH-KEPT",
    title: "conflicting sources keep both values, challenged, and a correction resolves it without hiding either",
    class: "conflicting-assertions",
    route: "all",
    funcs: ["FUNC-065", "FUNC-005", "FUNC-006"],
    criteria: ["C2-05", "C5-01", "C5-04"],
    gates: ["G03", "G09"],
    outcome: "route-hold-output-refused",
    expected: "both values are shown as challenged and the routes hold; a corrected value counts as present, is never silent, and both earlier values stay visible",
  },
  {
    id: "AC-RECORD-CHAIN",
    title: "the Record screen shows the chain source, record, route, output with status, flags and access indications",
    class: "record-chain",
    route: "all",
    funcs: ["FUNC-076", "FUNC-005", "FUNC-006"],
    criteria: ["C5-01", "C5-04"],
    gates: ["G03", "G16"],
    outcome: "output-made",
    expected: "two accepted sources with sha256, every value with status, flags and kind, per route the access to each property, readiness, holds and the output made or the draft, and links into Readiness and Outputs",
  },
  {
    id: "AC-REIMPORT-CORRECTION",
    title: "a re-import after a correction carries it forward, or challenges the value; every screen reads the latest version",
    class: "correction",
    route: "all",
    funcs: ["FUNC-005", "FUNC-006", "FUNC-065"],
    criteria: ["C5-01", "C5-04"],
    gates: ["G03", "G09"],
    outcome: "route-hold-output-refused",
    expected: "the same files again store nothing and the correction stays; a changed source value is kept beside the correction, the value is challenged and Record, Readiness and Outputs all hold the routes at the latest version",
  },
  {
    id: "AC-PAIR-ONE-VERSION",
    title: "a version is stored only when the file pair is complete, the pick survives leaving the screen, and the version is labelled honestly",
    class: "pair-import",
    route: "all",
    funcs: ["FUNC-039", "FUNC-133"],
    criteria: ["C5-04"],
    gates: ["G14"],
    outcome: "output-made",
    expected: "a lone file stores nothing and waits; after both files the record is version 1, labelled First import; an ERP-only record is stored only when the operator asks",
  },
  {
    id: "AC-INSTALL-SMOKE",
    title: "the served build answers, carries its content security policy, passes the bundle check and is pinned to one Node version",
    class: "install-smoke",
    route: "all",
    funcs: ["FUNC-131"],
    criteria: ["C5-02", "C5-04"],
    gates: ["G05"],
    outcome: "output-made",
    expected: "the index page is served, the bundle check passes, .nvmrc, the engines field, the serve script and the configuration example agree",
    note: "The full clean-clone install is scripts/rehearse-install.sh; this case checks what a running build can show.",
  },
  {
    id: "AC-ACCEPTANCE-GATE",
    title: "the acceptance suite is complete: its matrix equals its case list and covers every function of the scope and every failure class on every route",
    class: "acceptance-gate",
    route: "all",
    funcs: ["FUNC-134"],
    criteria: ["C5-04", "C5-05"],
    gates: ["G10"],
    outcome: "scan-clean",
    expected: "coverage.json equals the case list, each of FUNC-005, 006, 076, 131, 132, 133 and 134 has a case, and every pack failure class has a case on each route",
  },
  {
    id: "AC-LOG-SCAN",
    title: "after every failure fixture has been run through the UI, the log holds codes and digests and no source value",
    class: "log-scan",
    route: "all",
    funcs: ["FUNC-132"],
    criteria: ["C5-03", "C5-04"],
    gates: ["G05"],
    outcome: "scan-clean",
    expected: "no cell, JSON value, file name or error message of any fixture is in the downloaded log, and every entry has only the public fields",
  },
  {
    id: "AC-MESSAGE-SCAN",
    title: "error and hold messages on the screens carry no value the recipient may not see",
    class: "error-message-scan",
    route: "all",
    funcs: ["FUNC-132", "FUNC-019"],
    criteria: ["C5-03", "C5-04"],
    gates: ["G05"],
    outcome: "scan-clean",
    expected: "the refusal and hold messages of every accepted failure class, for each route, contain no value that route's recipient may not see",
  },
];

export const CASES: Case[] = [...classCases(), ...other];
