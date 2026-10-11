# Receipt and checkout print — 2026-10-12

Requested reference: owner's compact ruled store receipt. The sales/proforma renderer now has title, quantity and net columns, original logo, connected totals, and Latin digits. Live routes use «لیبل مد» rather than an accounting branch name. Historical invoices, accounting scopes, amounts, return policy, CSP and escaping are unchanged.

POS adds an unchecked opt-in to call the existing authenticated print flow after a confirmed finalization. Unknown-result recovery and offline queues do not automatically print. The normal browser print dialog still exists; silent physical printing requires configured printer/browser support. Mobile printing with the PC off is not implemented or claimed.

Validation: 30 receipt/logo unit tests, API/web typecheck, lint, web build, and 8 targeted Chromium browser checks passed. Geometry fixtures now include 1.125, 10000 and 999999999.999 quantities; all 14 screen/print checks passed. Independent read-only review caught narrow quantity overflow; dynamic width and print font fixed it and the delta review found no remaining blocker. All canonical CI checks remain required before merge. Physical paper output still needs verification on the store printer.

Synthetic previews: [standard receipt](receipt-oct12/standard-print.png), [fractional/large quantities](receipt-oct12/quantities-print.png). Reproduce with `PLAYWRIGHT_EDGE=1 node --experimental-strip-types ops/render-receipts.ts evidence/receipt-oct12` on Windows with Edge installed. No customer data is in these fixtures.
