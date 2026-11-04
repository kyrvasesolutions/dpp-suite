# Database

The app keeps its data in a SQLite database. In the browser it runs through
[sql.js](https://sql.js.org) and the file is saved in the browser's IndexedDB;
**Export → Database (SQLite)** downloads it and **Upload** accepts it back.

| File | What it is |
|---|---|
| `schema.sql` | Traceability tables (`source`, `tree`, `node`, `mapping`) and the regulatory chain below |
| `source/espr-annex-i.json` | ESPR (EU) 2024/1781 Annex I, copied verbatim from EUR-Lex |
| `seed/01-product-sample.sql` | Sample product structure (left column) |
| `seed/02-espr-annex-i.sql` | Annex I product parameters as the "Data category" tree (right column) |
| `seed/03-mappings-sample.sql` | Sample mappings |
| `seed/04-regulatory-chain.sql` | Legislation, its data requirements, and the standards behind them |
| `seed/05-ontology-terms.sql` | Open vocabulary terms that define the data requirements |

The seed files are generated; edit `scripts/build-seed.mjs`, the JSON source, or
`src/model/legislation.ts`, `src/model/standards.ts` and `src/model/ontologies.ts`, then run:

```bash
npm run build-seed
```

The script checks that every indicator under an Annex I parameter appears word for word in that
parameter's legal text.

Build the same database outside the browser:

```bash
cat db/schema.sql db/seed/*.sql | sqlite3 dpp.sqlite
```

## Regulatory chain

The Requirements and Validation views read this from SQLite when the app opens.

```
legislation → data_requirement → standard → ontology → data_point
```

| Step | Table | What it holds |
|---|---|---|
| legislation → data requirement | `requirement_provision` | The legislation's legal basis for the data requirement |
| data requirement → standard | `standard_requirement` | The standard behind the data requirement, on the path through one legislation; `basis` is `stated` by the passage or `inferred` by us |
| | `standard_target` | A standard no act names, whose own scope targets the data requirement, per product group, with the page it rests on |
| data requirement → ontology | `data_requirement_term` | The `ontology_term` that defines the data requirement, and how closely |
| ontology → data point | `ontology_data_point` | No rows yet |

`legislation_standard` records which legislation references which standard, including those behind
no data requirement, and `standard_citation` where it does so, in the act's own words. Standards the
act names in one sentence each have a row with the same excerpt. The app shows each passage once, with
the standards it names and the data requirements they stand behind; the passage, its provision and
the `note`s are its context.

Only the latest version of a standard is kept. Where REACH also names an older version, that
reference is left out, and `npm run build-seed` fails if two versions of one standard are recorded.

The CEN/CLC/JTC 24 standards for the digital product passport are in both: the six that
Implementing Decision (EU) 2026/1736 cites go through ESPR, with excerpts checked against that
decision, and the other two are in `standard_target`.

`standard_target` has no legal weight from the acts and is our reading of each standard's scope. It
lists what we could verify, not everything that exists. Left out: standards scoped to other sectors,
such as IEC 62474 and EN IEC 63000 (electrotechnical) and EN 18120 (plastic packaging), and those
whose current status we could not confirm.

A data requirement in neither table is listed under "No standard found". Ontologies link to the
data requirement rather than the standard so that these can reach them too.

A standard here is a specific document a standards body or international organisation publishes,
named in the act's text and used as a benchmark for one of its rules. Union law, nomenclatures
such as IUPAC, passing mentions of treaties, and generic wording such as "harmonised standards" are
left out. ILO conventions count because the Forced Labour Regulation defines its central term through them.

```bash
npm run check-legal-text
```

fetches each act and fails if an excerpt is not word for word in it, if the act contains a
standard reference that `src/model/standards.ts` does not record, or if two different standard
excerpts cover overlapping text. It knows the older versions left out on purpose and accepts those.
For REACH it reads the consolidated text of 23 June 2025.

## Ontology terms

Each data requirement links to at least one term from an openly licensed vocabulary, with the
term's definition copied word for word. `npm run build-seed` fails if a data requirement has no term.

`match` follows the SKOS mapping properties: `exact`, `close`, `broad` where the term is wider than
the data requirement, and `narrow` where it is narrower. Anything but `exact` carries a `note` with our
reading of the difference. A compound data requirement, such as "Energy & resource use", can have a
term for each part.

We take a term from the most formal source that defines the concept: Schema.org, the GS1 Web
Vocabulary, the UN Transparency Protocol, the Open Energy Ontology and the NCI Thesaurus OBO Edition,
then GEMET (a thesaurus) and Wikidata (a knowledge base) where those have none. Schema.org marks some
terms as pending; the `note` says so. Wikidata descriptions are community-edited and can change.

Licences are as each publisher states them. For the UN Transparency Protocol that is the licence of
its specification repository. GEMET states none of its own, so it rests on the European Environment
Agency's legal notice; some of its definitions come from other works.

```bash
npm run check-ontology-terms
```

fetches each source and fails if a term is missing or its definition is not word for word in it.
