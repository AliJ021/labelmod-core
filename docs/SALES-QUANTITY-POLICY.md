# Sales quantity policy (107)

`sales.allow_fractional_qty` defaults to **false**. Its Settings → Sales switch uses the existing `settings.security` permission and audited settings service. It controls new or changed sale quantities for POS, Instagram POS, phone, website orders and exchange replacements. Whole values such as `1.000` are valid. When enabled, quantities support up to three decimal places, matching the existing `numeric(14,3)` domain.

This policy does not round, rewrite or conceal stock or invoice history. Existing fractional draft lines can be finalized without changing their quantities. Price/discount edits, previously finalized order replay, and returns against previously sold fractions remain valid when the switch is off. Moving a fractional line to another invoice is a new assignment and is checked again. The old Instagram multi-step order workflow retains its own integer-only contract.

The POS shows a quantity input when fractional sales are enabled; Persian/Arabic digits and the decimal separator are normalized without floating-point arithmetic. Integer-only mode retains the usual plus/minus buttons. A legacy fractional line remains visibly fractional and its plus/minus buttons are disabled while the policy is off. Stock receipts, counts, transfers and reconciliation retain their existing contracts; an old discrepancy is never hidden by formatting it as an integer.

## Write boundary and concurrency

`sales.sale_quantity_guard` protects `sales.invoice_line` inserts and updates of quantity or invoice identity. Both fields must be unchanged to bypass a historical-line check. The shared assertion is also called for scan deltas: a fractional scan must not bypass the policy by turning an old fractional total into a whole number.

For a fractional value, the assertion reads the setting row `FOR SHARE`. The existing `platform.set_setting` takes `FOR UPDATE` on the same row. Both locks survive until their transactions finish. An admitted fractional write delays a concurrent toggle; a write waiting behind a committed disabling toggle is rejected. The focused two-connection test checks PostgreSQL blocking PIDs and actual line INSERT/UPDATE results in both orders. Integer writes do not need a policy lock because they are valid in either mode.

The assertion is a fixed-search-path security-definer function only to acquire the settings row lock without granting table-update rights. PUBLIC execution is revoked; existing app-role grants/default privileges cover application calls. No role, channel, payment, finalization or historical Instagram authorization is changed.

The API accepts a quantity's decimal **shape**, while the database makes the authoritative policy decision in the write transaction. UI state is advisory, refreshed on focus or the existing settings-change event; stale clients still receive a clear Persian rejection from the database. Exchange preview checks the policy, and posting independently rechecks at the actual line write.

## Upgrade and recovery

1. Back up and restore-drill using the deployment guide before applying107. Inspect existing fractional invoice/stock values read-only; do not round or rewrite them.
2. Apply migrations with the owner role through `ops/db.sh migrate`; never seed an existing database. Deploy the matching API/UI together. The new switch starts off unless an operator deliberately enables it later.
3. The upgrade test installs106 with synthetic fractional history, rolls107 back within a transaction, then applies107 through the normal migration runner. Invoice lines, stock movements, audit rows and journal entries must retain identical fingerprints. Restricted-role tests independently exercise the policy and unauthorized setting changes.
4. To stop new fractional sales, turn the switch off through Settings. This is audited and does not invalidate old fractional invoices, their returns or replays.
5. Do **not** drop107, change the quantity domain, truncate values or delete migration history as a rollback. Older POS code truncated fractional quantities when stepping and older Instagram guards rejected their edits. Keep the107 schema and compatible clients; use a forward fix. If a full database restore is needed, follow the backup/restore runbook and reconcile all writes after the snapshot explicitly before reopening sales. A snapshot restore is not a no-loss code rollback.

Focused validation covers default false/enabled behavior, Persian exact entry, stale-client rejection, direct restricted-role bypass attempts, scan deltas, legacy non-quantity edits, fractional historical returns, Woo replay, toggle ordering, real106→107 upgrade and rollback. A negative-control run disabling only the trigger must fail on a fractional direct write. Physical printing and production Woo latency are separate acceptance gates.
