BEGIN;
CREATE OR REPLACE VIEW inventory.ledger_check AS
WITH acct AS (
  SELECT DISTINCT account_code FROM ledger.posting_rule
   WHERE leg = 'inventory' AND is_active
),
book AS (
  SELECT coalesce(sum(l.debit - l.credit), 0)::numeric AS value
    FROM ledger.journal_line l
   WHERE l.account_code IN (SELECT account_code FROM acct)
),
pending AS (
  SELECT coalesce(sum(i.cogs_amount),0)::numeric AS value
    FROM sales.invoice i JOIN ledger.posting_batch pb ON pb.id=i.posting_batch_id
   WHERE pb.status<>'posted' AND i.status IN ('finalized','paid','partially_returned','returned')
),
real AS (
  SELECT coalesce(sum(total_value), 0)::numeric AS value
    FROM inventory.stock_balance
)
SELECT (SELECT account_code FROM acct ORDER BY account_code LIMIT 1) AS account_code,
       b.value AS ledger_value,
       r.value AS stock_value,
       b.value - r.value - p.value AS diff,
       p.value AS unposted_cogs
  FROM book b CROSS JOIN real r CROSS JOIN pending p;

COMMENT ON VIEW inventory.ledger_check IS 'Actual ledger and stock values; diff excludes explicitly identified unposted sales COGS, exposed separately for reconciliation.';
COMMIT;
