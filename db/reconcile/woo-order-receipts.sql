-- psql -v order_ids=9029,9030 -f db/reconcile/woo-order-receipts.sql
-- One row per requested Woo order, even before delivery. Readable before migration 145.
\set ON_ERROR_STOP on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
WITH wanted AS (
  SELECT DISTINCT trim(item) AS external_id FROM unnest(string_to_array(:'order_ids', ',')) AS item
), receipt AS (
  SELECT w.external_id, m.result_ref, p.invoice_id AS payment_invoice_id,
         p.method_code, p.status AS payment_status, p.amount, a.name AS payment_account
    FROM wanted w
    LEFT JOIN platform.inbox_message m ON m.source='api.web.order' AND m.event_id='woo-order:'||w.external_id
    LEFT JOIN treasury.payment p ON p.client_event_id='woo:'||w.external_id
    LEFT JOIN treasury.account a ON a.id=p.account_id
)
SELECT r.external_id, i.number AS invoice_number, i.status AS invoice_status, i.payable_amount AS payable_rial,
       r.method_code, r.payment_account, r.payment_status, r.amount AS received_rial,
       (r.result_ref IS NOT NULL AND r.result_ref=r.payment_invoice_id::text) AS receipt_matches_payment,
       (SELECT count(*) FROM treasury.payment p WHERE p.invoice_id=i.id AND p.direction='in') AS incoming_payments,
       (SELECT count(*) FROM inventory.stock_movement s WHERE s.ref_type='invoice' AND s.ref_id=i.id AND s.kind='sale') AS sale_movements,
       (SELECT string_agg(v.sku||' ('||s.qty::text||')', ', ' ORDER BY v.sku)
          FROM inventory.stock_movement s JOIN catalog.variation v ON v.id=s.variation_id
         WHERE s.ref_type='invoice' AND s.ref_id=i.id AND s.kind='sale') AS sku_and_stock_change
  FROM receipt r LEFT JOIN sales.invoice i ON i.id::text=coalesce(r.result_ref,r.payment_invoice_id::text)
 ORDER BY r.external_id;
COMMIT;
