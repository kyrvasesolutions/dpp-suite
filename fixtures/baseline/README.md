# Baseline fixture pack

Small synthetic files that pin how the current field extraction (`src/model/dataFields.ts`) behaves, so
later cycles see any change in it (Cycle 0 characterisation tests, regression replay). Values are invented.

| File | Exercises |
|---|---|
| `erp-comma.csv` | Comma delimiter, quoted cell containing the delimiter |
| `erp-semicolon-bom.csv` | Byte-order mark, semicolon delimiter, decimal comma |
| `nested.json` | Nested objects, arrays of objects, empty array, long value |
| `product.xml` | Namespaced root, attributes, nested elements |
| `product.ttl` | Turtle prefixes, `a` and `rdf:type`, literal objects |
| `erp.xlsx` | First sheet header and first data row |
