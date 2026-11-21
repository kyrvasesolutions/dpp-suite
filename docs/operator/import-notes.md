# Operator notes: importing the two source files

These notes are for the person who imports product data into the N demonstrator. They describe the Import
screen, the two files it accepts, and what each error and flag means. Everything happens on your device;
nothing is sent anywhere.

## The two files

| File | Format | What it holds |
|---|---|---|
| ERP extract | CSV, UTF-8 without byte order mark, `;` between fields, `.` as decimal separator, one header row | One row per product batch: identifiers, alloy, temper, dimensions, mass, finish, recycled content, country of casting, production date, customer article number, supplier code |
| Laboratory and assessment file | JSON, UTF-8 | One batch: measured values with uncertainty, the imported carbon footprint, the evidence records, and approved texts |

The exact columns and structure are fixed by the pinned input contracts. The Profile screen lists them, with the code lists.

## Importing

1. Open **Import** in the left rail.
2. Choose the ERP extract under **ERP extract (.csv)**, and the laboratory file under **Laboratory and assessment file (.json)**.
   Each file is checked as soon as you choose it.
3. Each file shows the stages it passed: **bytes**, **parse**, **structure**, **semantics**, **authorisation**.
   (**route** comes later, when outputs are prepared.) A file is either **Accepted** or **Rejected at stage …**.
4. When the ERP extract is accepted, a **record** appears for each batch, with every value as it stands in the file,
   where it came from (file, row and column, or the path in the JSON), its status and its flags.
5. **Import the same files again** checks that nothing changed: the record digest must stay the same.

To practise, pick an entry under **Sample files** and press **Import sample**. The samples include a clean pair and
one file for each kind of error.

## When a file is rejected

A rejected file is not imported at all, so no wrong value can slip through. The error names the stage, the code,
the place in the file, and the cause. Correct the file at its source (usually the export settings) and choose it again.

| Code | Stage | What it means and what to do |
|---|---|---|
| `media-type` | bytes | The file is not of the expected type. Use the ERP extract as .csv and the laboratory file as .json. |
| `byte-order-mark` | bytes | The file starts with a byte order mark. Save it as UTF-8 without BOM. |
| `wrong-encoding` | bytes | The file is not valid UTF-8. Export it again with UTF-8 encoding. |
| `empty-file` | bytes | The file is empty. |
| `csv-syntax` | parse | The CSV text is malformed, for example a quote that is never closed. |
| `ragged-row` | parse | A row has a different number of fields from the header. Check for an extra or missing delimiter. |
| `json-syntax` | parse | The JSON text is malformed. |
| `duplicate-key` | parse | An object in the JSON has the same key twice, so it is unclear which value is meant. |
| `non-finite-number` | parse | A number is too large to represent, or not a number at all. |
| `duplicate-column` | structure | A column name appears twice in the header. |
| `missing-column` | structure | A column the contract requires is missing from the header. |
| `unexpected-column` | structure | The header has a column the contract does not know. Remove it or ask for the contract to change. |
| `no-rows` | structure | The extract has a header but no data rows. |
| `schema` | structure | The JSON does not have the structure the contract requires. |
| `missing-value` | semantics | A required value is empty. |
| `not-a-number` | semantics | A numeric value is not a plain number with a point as decimal separator. |
| `decimal-comma` | semantics | A numeric value uses a comma as decimal separator. The contract requires a point. |
| `out-of-range` | semantics | A value is outside its possible range, such as a negative length or a share over 100 %. |
| `invalid-date` | semantics | A date is not a real calendar date in the form YYYY-MM-DD. |
| `missing-unit` | semantics | A measured value has no unit. It is not accepted as unitless. |
| `wrong-unit` | semantics | A measured value has a unit the contract does not allow for this property. Nothing is converted. |
| `unknown-evidence` | semantics | A value refers to an evidence record that the file does not contain. |
| `not-authorised` | authorisation | This role may not import source files. |

## Status of a value

| Status | Meaning |
|---|---|
| `single` | One file states the value. |
| `agreeing` | Both files state the value, and they agree. |
| `challenged` | The two files disagree. Both values are kept and shown; neither wins. Resolve it in the source systems. |

## Flags

Flags describe where a value comes from and anything to watch. They are shown one by one; there is no overall
quality score that could hide one of them.

| Flag | Meaning |
|---|---|
| `declared` | Declared in the ERP extract |
| `measured` | Measured by the laboratory |
| `calculated-externally` | Calculated outside this tool and imported as is |
| `unit-from-contract` | Unit given by the ERP contract column |
| `unit-stated` | Unit stated in the source |
| `uncertainty-stated` | Measurement uncertainty stated |
| `evidence-linked` | Linked to an evidence record |
| `evidence-digest-missing` | Evidence record has no digest |
| `code-mapped` | Company code mapped through the code list |
| `unknown-code` | Code not in the code list: kept as given |
| `several-results` | Several results and no rule to select one |
| `draft-text` | Text not yet approved |
| `challenged` | The sources disagree: both values are kept |

An **unknown code** does not reject the file: the value is kept exactly as written and flagged, so you can see it
and correct either the file or the code list. A laboratory file about a model or batch that the ERP extract does
not contain is kept but not attached to any record.
