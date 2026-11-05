# Database

The app keeps its data in a SQLite database. In the browser it runs through
[sql.js](https://sql.js.org) and the file is saved in the browser's IndexedDB;
**Export → Database (SQLite)** downloads it and **Upload** accepts it back.

| File | What it is |
|---|---|
| `schema.sql` | Traceability tables (`source`, `tree`, `node`, `mapping`) and the regulatory chain below |
| `source/espr-annex-i.json` | ESPR (EU) 2024/1781 Annex I, copied verbatim from EUR-Lex |
| `source/idta-submodels.json` | IDTA submodel templates reduced to their elements, pinned to one commit of the publisher's repository |
| `seed/01-product-sample.sql` | Sample product structure (left column) |
| `seed/02-espr-annex-i.sql` | Annex I product parameters as the "Data category" tree (right column) |
| `seed/03-mappings-sample.sql` | Sample mappings |
| `seed/04-regulatory-chain.sql` | Legislation, its data requirements, and the standards behind them |
| `seed/05-ontology-terms.sql` | Open vocabulary terms that define the data requirements |
| `seed/06-idta-submodels.sql` | IDTA templates as ontologies, their terms and their data points |

The seed files are generated; edit `scripts/build-seed.mjs`, the JSON source, or
`src/model/legislation.ts`, `src/model/dataSpaces.ts`, `src/model/standards.ts`,
`src/model/ontologies.ts` and `src/model/idta.ts`, then run:

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
| ontology → data point | `ontology_data_point` | Every field of an IDTA template |
| | `term_data_point` | The fields an IDTA term covers, which is what the Data points column follows |

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

## Compliance targets

A compliance target is what a company can be asked to comply with. `target_type` holds the three
types and their colours: legislation (B2G, dark blue), data spaces (B2B, dark orange) and consumer
branding (B2C, bright green).

All of them are rows of the `legislation` table and follow the same chain. It says legislation because
that came first.

A data space's or label's `requirement_provision` rows are what its documents ask for, and its
`standard_requirement` rows are marked `inferred`. Both are our plain-language reading with a link,
because those documents are copyrighted: the Catena-X notice explicitly does not allow copying. So
`npm run build-seed` rejects quotes in them, and they have no `standard_citation`. `join_step` lists what a company does
to join, per product group where it differs. Data spaces are written in `src/model/dataSpaces.ts`.

```bash
npm run check-data-spaces
```

fails if a Catena-X standard is no longer published in the version recorded, is no longer on the
current release, or if a step's source no longer opens.

Consumer labels are written in `src/model/consumerLabels.ts`. A label counts if its mark or claim
reaches the consumer; schemes that work only between businesses are left out. The list is what we
could verify at each scheme's source, not everything that exists. A label's own scheme document is
its `standard` row, with `kind` `scheme`, so its data requirements don't read as "No standard found".

```bash
npm run check-labels
```

fails if a label's source is gone. Some sites refuse automated requests; those are listed to check by hand.

The catalogue is everything filled from `04-regulatory-chain.sql`, `05-ontology-terms.sql` and `06-idta-submodels.sql`. It holds
nothing of the user's, so `CATALOGUE_VERSION` in `src/db/database.ts` rebuilds it in saved databases:
raise it whenever those seeds or their tables change. Trees and mappings are left as they are.

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

## IDTA submodel templates

The [IDTA submodel templates](https://github.com/admin-shell-io/submodel-templates) define data models
for the Asset Administration Shell, published in JSON under CC BY 4.0. Each template in
`src/model/idta.ts` becomes one `ontology` row, named by its IDTA number:

| In the template | In the database |
|---|---|
| The submodel template | `ontology`, whose `uri` is the file at the recorded commit |
| An element that defines a data requirement | `ontology_term`, whose `uri` is the element's semantic ID |
| An element with nothing inside it | `data_point`, with its idShort path, type, cardinality and unit |

Names and definitions come from the concept description the element's semantic ID points to, or else
the element's own English description, with only runs of whitespace collapsed. Definitions marked
`SOURCE:` quote the standard they name, as the template publishes them. Elements such as `ArbitraryProperty` and `Section`
are slots for the user's own elements, so they are not data points.

Links from data requirements to elements are in `IDTA_REQUIREMENT_TERMS`, and they are our reading.
`match` and `note` work as for other terms. A term covers its own value or those of the elements inside it,
which `term_data_point` records, so opening a data requirement narrows the data points. The rest of the
template stays available under "other fields". `npm run build-seed` fails on a path a template lacks or on a
template that defines no data requirement. IDTA terms are additional: every data requirement still needs a term
in `src/model/ontologies.ts`.

Semantic IDs are shown as text, because IRDIs and many `admin-shell.io` addresses do not open as web pages.

Only templates that can apply to the product groups here are listed. Battery passport templates (IDTA 02035)
are left out because no compliance target covers batteries, and templates for machines and plants
because they describe equipment rather than the product. To add one, add it to `IDTA_TEMPLATES` with at
least one term, then run `npm run fetch-idta` and `npm run build-seed`.

```bash
npm run fetch-idta -- --latest   # move to the repository's current commit
npm run check-idta
```

`check-idta` reads the recorded commit again and fails if `source/idta-submodels.json` no longer
matches. It also lists files newer than that commit without failing.
