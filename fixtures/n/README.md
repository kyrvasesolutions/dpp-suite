# N fixture pack (synthetic aluminium D03a inputs, public stand-in)

Synthetic inputs that follow the frozen stand-in N contract pack in `contracts/n`:
one valid ERP CSV extract and laboratory/assessment JSON for one product model and batch, plus one input
for each failure class in `contracts/n/failure-cases/`. No real customer data (LEAN-DEF-12).

| File | Use |
|---|---|
| `d03a-erp-extract.csv` | Valid ERP extract (also the fixture for leakage and reproducibility) |
| `d03a-lab-assessment.json` | Valid laboratory and assessment file |
| `erp-missing-recycled-content.csv` | Blocked export: a property the customer PDF requires is empty |
| `erp-missing-alloy-column.csv` | Missing required column |
| `erp-unknown-company-code.csv` | Company code not in the code list |
| `erp-latin1.csv` | Not valid UTF-8 (ISO-8859-1 bytes) |
| `lab-two-footprints.json` | Two footprint results and no selection rule |
| `lab-conflicting-alloy.json` | Alloy differs from the ERP extract |
| `lab-missing-unit.json` | Measured thickness without a unit |
| `lab-wrong-unit.json` | Measured thickness in inches, not allowed |
| `lab-duplicate-key.json` | Object with the key `value` twice |
| `lab-non-finite.json` | Number that overflows to Infinity |
| `routes/customer-pdf-requires-denied.yaml` | Route variant that requires denied properties |

After any change run `npm run check-fixtures -- --write`.
Tests read fixtures only through `tests/support/fixtures.ts`, which refuses a file whose digest doesn't match.
