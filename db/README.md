# Database

The app keeps its data in a SQLite database. In the browser it runs through
[sql.js](https://sql.js.org) and the file is saved in the browser's IndexedDB;
**Export → Database (SQLite)** downloads it and **Upload** accepts it back.

| File | What it is |
|---|---|
| `schema.sql` | Tables: `source`, `tree`, `node`, `mapping` |
| `source/espr-annex-i.json` | ESPR (EU) 2024/1781 Annex I, copied verbatim from EUR-Lex |
| `seed/01-product-sample.sql` | Sample product structure (left column) |
| `seed/02-espr-annex-i.sql` | Annex I product parameters as the "Data category" tree (right column) |
| `seed/03-mappings-sample.sql` | Sample mappings |

The seed files are generated; edit `scripts/build-seed.mjs` or the JSON source, then run:

```bash
npm run build-seed
```

The script checks that every indicator under an Annex I parameter appears word for word in that
parameter's legal text.

Build the same database outside the browser:

```bash
cat db/schema.sql db/seed/*.sql | sqlite3 dpp.sqlite
```
