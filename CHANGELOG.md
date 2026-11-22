# Changelog

Functional changes to the DPP suite, one entry per merged pull request, newest first.

## Cycle 6 exit: Durable server (P) supported (22 November 2026)

- **Durable server (P)** is labelled **Supported** (`src/model/capabilities.ts`) following Cycle 6 exit verification: three independent review rounds, live concurrency and crash-recovery (`kill -9` and staged crash injection) verification, retention and legal-hold enforcement, Pack-verified start-up, cross-model operator walkthrough (`HT-W`) and domain exception review (`HT-R`). The five narrow demonstrator screens retain their Supported labels unchanged; real customer contracts, real exception samples, real metallurgical limits, real operators, authentication/authorisation (Cycle 7) and cryptographic signing remain dated holds.

## [#16](https://github.com/kyrvasesolutions/dpp-suite/pull/16) Durable server, staged idempotent imports and evidence retention (22 November 2026)

- **A durable local server** (`npm run server`, Node 24). Records, evidence, execution log and job state are kept in a SQLite database in WAL mode (the `node:sqlite` module of Node 24, so no new dependency), behind a small adapter so a PostgreSQL store can replace it later. It serves the built application on its own origin and binds to `127.0.0.1` by default. There is no authentication yet: run it only on the machine you work on. Environment variables are documented in `config/env.example` (`DPP_DB_PATH`, `DPP_SERVER_HOST`, `DPP_SERVER_PORT`, `DPP_ALLOWED_ORIGIN`, `DPP_STATIC_DIR`). Node 24 prints an "experimental" warning for `node:sqlite`; that is expected.
  - **The application uses it when it is there.** The Import screen finds the server on its own origin and submits each import to it as a job; the Record screen reads versions from it and sends corrections to it. The static build (GitHub Pages) finds no server and keeps working from browser storage, with no change.
  - **Imports are staged, idempotent and recoverable.** A job moves through received, classified, validated and staged and then commits in one transaction, leaving an update receipt. The same idempotency key sent twice, or at the same moment, stores one version and returns the same result; the same key with a different file is refused with a conflict. A job interrupted at any stage resumes or rolls back cleanly when the server restarts, and recovery never touches a job that is still running.
  - **Concurrent operators cannot lose or duplicate an update.** Writes are serialised with an expected-version check; a stale update is a conflict, not an overwrite.
  - **Classification and retention before data.** A pinned `RETENTION@1.0.0` policy (default class restricted, ten-year horizon, legal holds) must be active before anything is accepted, and is activated only as it comes out of the signed contract pack. The server assigns the recording time, so no caller can shorten a horizon, and an import accepts only the two input datasets. Evidence is stored by SHA-256 and checked on write and read; it cannot be deleted before its horizon ends or while held, and the database itself refuses an early delete. A legal hold can be placed over the API but not released until operators are identified.
  - **A closed boundary.** The server answers only to its own host names, accepts cross-origin requests only from origins you configure, requires JSON on every POST, reads the Host header strictly, and has no endpoint that writes a snapshot or a log entry directly.
  - **A verified pack.** At start-up the server runs the same frozen and signed check as CI on the contract pack and refuses to start if a file does not match its manifest or the manifest is not the digest the owner signed. Evidence is also held at least restricted and for at least ten years by a code-level floor, whatever a policy says.
  - **Append-only means append-only.** Triggers refuse an insert over an existing row (so `INSERT OR REPLACE` and upserts cannot rewrite a snapshot, evidence object, receipt or log entry), and retention policies cannot be changed or deleted with raw SQL. The same idempotency key with different evidence is a conflict.
  - **Versioned schema.** Migrations go forward and backward, the applied ones are frozen by checksum, and a rollback refuses to drop tables that still hold retained evidence or snapshots.
- **Customer onboarding pack (artificial demonstration).** `RETENTION@1.0.0` and `EXCEPTIONS@1.0.0` join the contract pack with twelve representative data-quality fixtures (byte-order mark, Windows line endings, decimal comma, padded identifiers, unknown supplier, zero mass, recycled content over 100, duplicate observation id, missing evidence digest, characters outside WinAnsi, an unattached laboratory file, conflicting alloy). They are written to represent such files and are not real customer data. The contract pack has new digests and is signed again.
- **Capability labels.** The server increment has its own entry, "Durable server (P)", labelled Untested until the Cycle 6 exit and shown only while the server holds the records. The screens keep their Supported labels for the narrow demonstrator, and a function carries one label per increment.
- A record-level simulation of the same contract (idempotency by digest, server-assigned time, the two input datasets, the crash points) runs against the real server pipeline in the tests.

## [#15](https://github.com/kyrvasesolutions/dpp-suite/pull/15) Record screen supported; narrow demonstrator complete (22 November 2026)

- The **Record** screen is labelled **Supported** (all five screens of the narrow demonstrator — Profile, Import, Record, Readiness and Outputs — are now Supported). The Record chain, non-silent operator correction, field-level diffs, local execution log, declared input limits, exact dependency pins, clean-clone installation rehearsal, 73-case three-route acceptance suite, contract-tightness and adversarial mutation suites, and five-viewer comprehension walkthrough passed independent review and clean-clone testing.

## [#14](https://github.com/kyrvasesolutions/dpp-suite/pull/14) Record screen, packaging, execution log, acceptance suite and ADRs (22 November 2026)

- **One record per file pair, and declared limits.** A new pinned pack file, `policy/LIMITS@1.0.0.yaml`, declares the input limits: 10 MiB per source file, JSON nesting depth 12, a 30-second job deadline and exactly one data row in the ERP extract. They are design targets, not measured limits, and change only by pinning a new version of the file. The contract pack has a new digest and is signed again.
  - An ERP extract with more than one data row is rejected at the structure stage (`multiple-records`) with nothing imported; this replaces the earlier acceptance of several rows.
  - A file over the size limit is rejected at the bytes stage before it is decoded (`too-large`). JSON nested deeper than the limit is rejected at the parse stage (`too-deep`), checked inside the strict parser so a hostile text cannot overflow the stack. An import that runs past the deadline stops with `deadline` and no output.

- **Execution and error log.** A local, append-only log in this browser records import accepted or rejected, readiness assessed, output made or refused, release, record export, record import and correction. It is shown on the Import and Outputs screens and can be downloaded as one JSON file.
  - The public field set is fixed: sequence, event, stage, code, route, rule, step, record (model and batch as digests only), version, file role, file digest and outcome. A value, a code value, a file name or free text is never logged; any other field, or content of the wrong shape, is dropped, and content without a confidentiality class is treated as restricted. Error messages on the screen may still show the operator's own values.
  - A test runs every fixture and failure fixture through import, readiness, outputs and export and checks that no source value or file name is in the log.

- **Packaging, configuration and dependencies.**
  - Every dependency is pinned to one exact version, matching the lockfile. Node 24 is set in `.nvmrc` and in `package.json` engines, and `npm run serve` serves the build on port 4173.
  - `config/env.example` lists the four configuration points (contract pack, fixture pack, the Claude flag, base path) with no secret values.
  - `npm run check-secrets` scans tracked files for Anthropic, GitHub and AWS keys, private key blocks and committed `.env` files; `npm run check-licences` checks the licence of every production dependency, nested ones included, against an allow-list and prints the table. Both run in CI, with a non-blocking `npm audit` report for production dependencies.
  - `scripts/rehearse-install.sh` clones a ref into a temporary directory, installs, typechecks, checks the contract pack, builds, checks the bundle and serves the build, then prints a dated summary.

- **Export time as declared generated metadata.** The release manifest has `generated` (the ISO time and the role that made the release) and a `substantiveDigest` over everything except `generated`. The time is in no digest and in no comparison: the three output files stay byte-identical on every run, and the golden files and the double-run check compare the substantive content. Verification now also recomputes the substantive digest, so a changed manifest is caught while a changed generation time is not. The Outputs screen shows the time, the role and the substantive digest.

- **Record screen and correction.** A new Record screen, labelled Untested, shows one record from its source files to each route's output: every source with its role, sha256 and accepted or rejected status; every value with its status, flags, kind (declared, measured, calculated externally, corrected) and sources; for each route what it may see (permitted, withheld, derived only), its readiness, holds and the output made or refused; and links to the Readiness and Outputs screens.
  - The operator can correct one value of the selected record. A reason is required. The correction makes a new version of the record, in which the corrected value is flagged `corrected` with the actor and reason and has the status `corrected`; the earlier value stays visible. Readiness counts the value as present, and the output lineage and release manifest name the correction version, actor and reason. A correction cannot target another record, the pack or a code list, an identifier or an evidence reference, and a coded value must already be in its list.
  - The screen and the exported central-record file show the field-level difference between versions. A correction is logged as an event with no value and no reason.
- **Acceptance suite and coverage matrix.** `npm run acceptance` runs 73 end-to-end cases through the UI, from files the operator picks, on the production build, and writes `test-results/acceptance-report.json` and `.md`. Every failure class of the contract pack, and the two limit classes that are built in the tests (a file over the size limit, a run past the deadline), is run against each of the three routes with its expected outcome (refused at ingress, route held with its rules, output refused, field withheld, registry draft only, or not applicable with the reason). It also runs one positive case per route, reproducibility across two browsers, no partial success after a good record, conflicting sources and a correction, a scan of the downloaded log for any source value, and a scan of the error and hold messages for values a recipient may not see. `tests/acceptance/coverage.json` maps each case to its FUNC, criterion and gate IDs, and a unit test checks it against the case list and the pack. The suite also runs in CI.
- **Performance report.** `npm run perf` runs the one-record, two-input, three-route scenario (import both files, assess readiness, make the three outputs and the manifest) 30 times in Node, and prints p50 and p95 for the cold first run and the warm runs with the machine description, plus one browser timing. It only reports; it never fails on a number and is not part of CI.
- **Clearer customer sheet.** The sheet ends with a short "Reading this sheet" legend that explains the footprint result ID (for example PCF-1), the customer scope alias, the language/sector/market qualifier of a text and rule IDs, and says that the record and contract pack digests identify exactly which record and contract the sheet was made from. The post-consumer share now states its basis, "mass share of the product", from the profile definition (a new optional `basis` on a profile property; the contract pack has a new digest and is signed again). A label that wraps now stays inside its own column and keeps its words together in the file's text, and an item is no longer split across a page break. The golden files are updated.
- **Validation fixes.**
  - A re-import never silently undoes an operator correction. It is carried onto the new version (still flagged `corrected`, with its lineage), confirmed with lineage to both if the source now agrees with the correction (shown as "Also stated by…", not struck through), or — if the source says something else or drops the value — both values are kept (with any superseded source file retained by sha256 and annotated as an earlier file version), the value is challenged (`source-changed`) and the routes hold until the operator decides. A plain re-import is labelled "Re-import", never "Corrected import"; versions are labelled First import, Re-import, the operator's reason, or imported from a central-record file.
  - A correction to the value the record already has is refused with a clear message. The flag is named `corrected` everywhere.
  - A version is stored only once both files are in, accepted, and attached to the same product model and batch; a lone file or a laboratory file for another model or batch waits and stays picked when you look at another screen, and an ERP-only record is stored only when the operator asks. Readiness, Record and Outputs all read the latest version of the selected record.
  - The Record screen names its two digests apart (Record digest, as on the customer sheet; Version digest), says "Declared in the laboratory file" for laboratory values, strikes through only values a correction replaced, and has no Correct button on identifiers or evidence references.
  - The 30-second deadline now counts the whole import of the pair, not each file, and a central-record file import obeys the declared size, depth and deadline limits. `npm run perf` reports the cold figure from five fresh processes.
  - The test helper that reads fixtures works under both vitest (jsdom) and Playwright, so `npx vitest run` exits 0 again. The acceptance matrix now has cases for the Record chain, re-import after a correction, the file pair, the install smoke check and the matrix itself (73 cases).
  - Re-importing identical dropped files after an operator settles a dropped-value challenge stays idempotent and keeps the settled correction without re-challenging; laboratory JSON schema checking uses own-property lookup (`Object.hasOwn`) so prototype property names (`__proto__`, `constructor`, `toString`) cannot bypass `additionalProperties: false`; Playwright end-to-end tests write artifacts to `test-results/e2e-artifacts` so they never wipe `test-results/acceptance-report.md`.
- **Contract-tightness and codified adversarial mutation tests.**
  - `tests/unit/contractTightness.test.ts` drops every required profile property, every required ERP CSV column and every required laboratory JSON key one by one to prove no route or ingress contract can pass by construction, mutates representative scalar and derived properties to prove outputs change live (no canned output substitution), and checks 100 % lineage continuity across import, correction and re-import versions.
  - `tests/unit/adversarialMutations.test.ts` permanently codifies repeatable adversarial probes: canary leak scans across logs, PDF and registry JSON, formula- and separator-injection attempts through operator corrections, unauthorized/silent-correction refusals, and hostile input-limit boundaries (over-size bytes, 10,000-level JSON nesting, multi-row extracts, shared job deadlines).
- **Public Architecture Decision Records (`adr/`).** Added `adr/0001-browser-only-pipeline-and-contract-packs.md`, `adr/0002-deterministic-contract-testing-and-three-layer-verification.md` and `adr/0003-reimport-and-correction-semantics.md`. Public documentation remains restricted to `CHANGELOG.md` and `adr/*.md`; working, operator and assessment documentation stays local and git-ignored.
- **Failure cases for the input limits.** The contract pack has failure cases and small fixtures for an ERP extract with two data rows and a laboratory file nested past the depth limit. The pack has a new digest and is signed again.
- **A pack-only acceptance change is tested.** A test copies the stand-in pack to a temporary directory, adds one optional ERP column for a property no column filled yet, brings the manifest up to date with the contract checker alone, and then checks import, readiness and all three outputs: the customer PDF and the ERP staging CSV carry the new value, the registry route stays on its hold, a value that disagrees with the laboratory is still challenged, and no file under `src/` changes.
- **The PDF character hold names the exact field.** When a text holds a character the PDF font cannot draw, the hold now names the key of the source object that holds it (for example `calculated_by`) and that key's own place (`/footprints/0/calculated_by`), not the whole value. The release manifest and the Outputs screen show it too.

## [#13](https://github.com/kyrvasesolutions/dpp-suite/pull/13) Outputs screen supported (22 November 2026)

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
