# Changelog

Functional changes to the DPP suite, one entry per merged pull request, newest first.

## Unreleased: Outputs screen supported (22 November 2026)

- The Outputs screen is labelled Supported. The three outputs, the central record with its versions, lineage and the release manifest passed an independent review in three rounds. In about 100 attempts, no denied field, raw derived value, live spreadsheet formula or undetected change reached an output.

## [#12](https://github.com/kyrvasesolutions/dpp-suite/pull/12) Outputs, central record and release manifest (22 November 2026)

- The three routes now have a **pinned output mapping**: every field a route may carry has exactly one output step with a stable step ID, in a fixed order. The contract checker refuses a route with a field that has no step, a step for a field the recipient may not see, a duplicate step ID, or a derived statement without its derived rule. The contract pack has a new digest and is signed again.
- **ERP staging CSV**: one header row and one data row from the ERP route's projection, UTF-8 without byte-order mark, ";" between cells, RFC 4180 quoting, numbers exactly as the source wrote them.
  - A text cell that starts with =, +, -, @, a tab or a carriage return is prefixed with an apostrophe so a spreadsheet shows it as text; numbers are never changed, and the release manifest counts the prefixed cells.
  - The footprint method, system boundary, reference year and calculated-by travel with the footprint value. Evidence references carry their digest, issuer, revision and access policy.
  - A route that is on hold is refused: no file is made, and the reasons are reported.
  - Where a cell joins several parts, `|` separates them and `key=` names them; a backslash, a pipe, and in keys and evidence details also `=`, `(`, `)` and `,` are written with a leading backslash, so no source text can pass for a separator or for another part. A single plain value is never changed, but a text property whose values carry qualifiers (language, element) always names them, even for one value.
- **Registry preparation JSON**: always a draft with `"status": "HOLD"` and `"submission": "never"`, the standing hold reason and any other holds; canonical JSON (sorted keys, two-space indent). It names only the fields the registry may see and is never sent anywhere.
- **Central record**: accepted imports are stored as append-only, versioned snapshots per product model and batch, in this browser. A corrected re-import makes the next version, linked to the one it replaces by digest; earlier versions stay readable, a stored version cannot be rewritten, and re-importing identical files stores nothing. The browser database moves to version 2 and keeps what it held.
- **Lineage**: every value in an output can be traced to its mapping step, to the derived rule for a derived statement, and to the source file, its sha256 and the exact place in it (for the footprint's method, system boundary, reference year and calculated-by, the place of that key, not of the value). A derived statement lists every value it was made from.
- **Release manifest**: canonical JSON, with no date or time, listing the software version and commit, the contract pack and every pinned file, the input files by role and sha256, the record version and digest, each output with its digest and status, and the lineage. Verification recomputes every digest of a set of files and reports each change, missing file or unlisted file.
- **Portable export and import of the central record** as one canonical JSON file with every version, the contract pack digest and its own sha256. Import checks the strict JSON syntax, the schema and every digest and link, and gives back exactly what was exported. It also derives again what the contract can check: the status of each value, the flags of each assertion, codes against the pinned code lists, and numbers, ranges and units. A file that is inconsistent or only partly changed, another pack, or a role other than the operator is refused. A file whose content was changed to other valid values and then sealed again with recomputed digests cannot be told from a genuine one without signing, which is out of scope. Imported laboratory values are also validated against the laboratory contract's own schema rules (patterns, allowed values, minimums), and a snapshot's sources must equal its record's sources. A version restored from a file always says so in the history ("Imported from a central-record file"), whatever the file says; a file carrying any other origin text is refused.
- **Customer PDF**: one fixed A4 layout with English labels and German labels in a second column, from the customer route's projection only.
  - Derived properties appear only as statements ("within the limits", with the basis and the rule), never as values. Evidence and the primary supplier do not appear.
  - The footprint keeps its method, system boundary, reference year and calculated-by. Each value names where it comes from (kind of file and position, never a file name). The footer has the record version, the record digest and the contract pack digest.
  - Standard Helvetica only, so no font file is embedded. The file has no date, producer or other metadata, so the same inputs give the same bytes. A few characters outside the font's set are spelled in ASCII ("<=", ">=", "CO2e"); any other character stops that file with the reason.
  - Like the CSV, it is refused when its route is on hold. It is also refused, with the new hold rule `RR-PDF-CHARACTER` naming the value, when a value holds a character the font cannot draw; the hold names the character's code point (U+XXXX), the property and the source location, in the manifest and on the screen.
  - Long texts are never cut off: pages are broken line by line, and nothing is drawn over the footer.
- New **Outputs** screen after Readiness, labelled Untested: per route the status and a download, or the reasons why no file is made; the registry file as **Download draft (HOLD)**; the release manifest with verification of a set of downloaded files; the history of the record with each version viewable read only; export and import of the central record; and a panel that traces any output value to its step, rule and source. The Import screen now reports which version was stored, that nothing new was stored, or an error if the record could not be saved. After importing a central-record file, the screen shows the latest version.
- Outputs use no clock, no randomness and no network. The browser bundle gains pdf-lib (pinned to 1.17.1); the PDF text reader used by the tests is a development dependency only and is checked to be absent from every script in the bundle (.js, .mjs and .cjs).

## [#11](https://github.com/kyrvasesolutions/dpp-suite/pull/11) Readiness screen supported (21 November 2026)

- The Readiness screen is labelled Supported: route readiness, the fixed recipient matrix and derived disclosure passed an independent review, with no leak found in more than 60 attempts to make a denied field reach a recipient.

## [#10](https://github.com/kyrvasesolutions/dpp-suite/pull/10) Route readiness and recipient disclosure (21 November 2026)

- New **Readiness** screen after Import. For each imported record it shows, per route, whether the route is ready or on hold, which required properties are present, missing, not accessible to the recipient or challenged, and why.
  - Every hold names a rule with its text, the property, and where the source values are. A missing value and the registry route's own hold are the only ones with no source value to point to.
  - The holds are: missing value, value the recipient may not see, challenged value, unknown code, several footprint results with no rule to choose one, draft text, evidence without a digest, a derived statement the limits cannot decide, and the registry route's standing hold.
  - Exactly one footprint result is selected. With several and no rule, none is selected and every route that needs the footprint holds; both results stay listed.
  - A required property that the recipient may not see and that is also missing shows both holds.
  - Three structural checks on the record are listed. A fixed notice says these are selected structural, completeness and route checks, not a conformity assessment.
- **View as recipient** shows exactly what each route's recipient would receive.
  - One decision function applies the fixed actor and field matrix. Only it reads the matrix.
  - A permitted value is copied with its source. A denied property does not appear; it is listed for the operator, never with its value.
  - The evidence record a permitted value rests on is not shown to a recipient who may not see evidence.
  - For the customer PDF, tensile strength and chemical composition appear only as *within* or *outside* the limits for the alloy. The basis reads "illustrative limits after" the standard, because the limits table is illustrative, and the statement cites the places of its inputs. The value, its uncertainty and its method are not shown.
  - Every permitted value shows where it came from: the kind of file (ERP extract or laboratory file) and the row and column or JSON path. The name of the uploaded file is never shown to a recipient; the operator's own views keep it.
  - A route on hold still gets a view, marked as on hold.
- A laboratory text about another product model than the file's own is refused at the semantics stage, and so is a laboratory product model or batch identifier with spaces or invisible characters at its ends.
- The record state now lives in the app, so the Readiness screen shows what the Import screen imported. Four prepared record states are available on the Readiness screen: a clean pair, a conflicting alloy, two footprints and a blocked export.
- The contract pack gains two pinned policy files, the readiness rules and the derived-disclosure rules. The contract check fails if a derived cell of the matrix lacks exactly one derived rule. The pack is signed again.
- Capability labels: the Readiness screen is Untested. The record checks and route readiness are no longer cited by the Validation and Mapping screens, which keep them as extensions.

## [#8](https://github.com/kyrvasesolutions/dpp-suite/pull/8) Import: stricter checks; Import screen supported (21 November 2026)

- ERP values are matched to their row by position, not by reading the file name. A file whose name contains "row 9" no longer loses or misplaces its values.
- Refused now:
  - two rows for the same product model and batch;
  - two lab entries with the same evidence, observation, result or text identifier;
  - identifiers and codes with spaces at their ends or invisible characters.
- Values:
  - A cell of only spaces or invisible characters counts as empty.
  - Lengths, masses and strengths must be greater than zero.
  - Numbers that would be rounded silently are refused.
- Files:
  - A `.csv` sent as an Excel file type is accepted.
  - Blank lines at the end of the extract are ignored.
- Lab values about a model or batch that the ERP extract does not contain are listed on the screen.
- The sample files follow the embedded contract pack.
- Labels:
  - The Import screen is labelled Supported.
  - The routing transformations, of which only the import side exists, are labelled Experimental.

## [#7](https://github.com/kyrvasesolutions/dpp-suite/pull/7) Import of the ERP extract and the laboratory file (21 November 2026)

- New **Import** screen for the two source files: the ERP extract as CSV and the laboratory and assessment file as JSON.
- Each file passes the stages bytes, parse, structure, semantics and authorisation. A problem rejects the file with an error that names the stage, the code and the place in the file.
- A strict JSON parser refuses duplicate keys and numbers that overflow. The Mapping screen uses it too.
- Accepted values are kept exactly as written, with file, row and column or JSON path.
  - Unknown codes are kept and flagged.
  - Units are checked and never converted.
- When the two files disagree, the value is marked challenged and both values are shown.
- Each value carries flags for its origin and quality. There is no overall score.
- Importing the same files again gives the same record and digest.
- Sample files cover a clean pair and each kind of error. Operator notes explain every error and flag.
- A contract pack only builds when its manifest digest matches the signed digest in `contracts/SIGNATURES.json`.
- Three more failure cases with test files: a decimal comma, a unit alias, and an evidence record without a digest.

## [#6](https://github.com/kyrvasesolutions/dpp-suite/pull/6) Profile: version pins for mappings; Profile screen supported (21 November 2026)

- The input contracts and routes are pinned by exact version. A file that says `latest` or another version is refused.
- A declared mapping must point at an existing property or field, and units must match.
- Each plan function carries one label. Screens that go beyond a function list it as an extension.
- The Profile screen is labelled Supported.

## [#5](https://github.com/kyrvasesolutions/dpp-suite/pull/5) Profile screen and pinned reference files (21 November 2026)

- New **Profile** screen, read-only. It shows the 24 business properties of the fixed profile:
  - definition, unit, which outputs need each property, English and German labels, and sector-specific labels;
  - nested fields;
  - the source status of each property's illustrative legal requirement, with a link to the provision.
- Search by identifier or label.
- The contract pack gains pinned files:
  - governed terms;
  - company code lists as editable CSV files;
  - legal links;
  - units.
- Every reference names an exact version.
- The build embeds the pack and fails when it is invalid. The app checks every file's digest again before showing anything.
- A build that embeds anything but the public pack cannot be published.

## [#4](https://github.com/kyrvasesolutions/dpp-suite/pull/4) Frozen contract pack (public stand-in) and test files (21 November 2026)

- The contract pack is frozen as a synthetic public stand-in. It contains:
  - 24 properties;
  - the ERP and laboratory input contracts;
  - the output field lists;
  - the disclosure matrix;
  - the failure cases.
- Synthetic test files: a valid ERP extract and laboratory file, and one file per failure case, pinned by digest.
- The contract checker can check another pack directory, and refuses failure cases whose test file is missing.

## [#3](https://github.com/kyrvasesolutions/dpp-suite/pull/3) Consumer labels: current standard versions (21 November 2026)

- GRS 5.0 and RCS 3.0, with their recycled-content thresholds (GRS: 20 % to certify, 50 % for a consumer label; RCS: 5 %).
- RWS 2.2 and RMS 1.2.

## [#2](https://github.com/kyrvasesolutions/dpp-suite/pull/2) Contract pack skeleton, tests and egress control (20 November 2026)

- Contract pack skeleton, with routes, strict ingress rules and synthetic failure cases, checked by `npm run check-contracts`.
- Unit and end-to-end tests with digest-pinned test files. Every end-to-end test fails on any request that leaves the app.
- A content security policy and an empty egress allow-list. The browser refuses any request outside the app's origin.
- Suggestions from a language model are behind a build flag that is off by default.
- Unclassified content is treated as restricted.
- Each screen shows a capability label: Supported, Experimental, Disabled or Untested.
- CI runs on every pull request. Third-party sources are checked weekly.

## [#1](https://github.com/kyrvasesolutions/dpp-suite/pull/1) IDTA templates, data spaces, consumer labels and graph view (20 November 2026)

- IDTA submodel templates as ontologies and data points.
- Data spaces (Catena-X), with the steps to join them.
- Consumer labels as business-to-consumer compliance targets.
- **Graph compliance** screen: an interactive explorer from legislation to data requirements.
- A spec library to upload or paste specification YAML.
- One-line summaries of the standards.
