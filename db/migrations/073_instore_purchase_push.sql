-- اعلان خرید در همان تراکنش نهایی‌سازی؛ جزئیات مشتری از خوراک مجوزدار خوانده می‌شود.
CREATE OR REPLACE FUNCTION sales.notify_instore_purchase() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, platform, sales
AS $$
BEGIN
  IF NEW.finalized_at IS NOT NULL AND OLD.finalized_at IS NULL
     AND NEW.status IN ('finalized', 'paid') AND NEW.channel <> 'web'
     AND platform.setting_bool('web.push_enabled', false)
     AND EXISTS (SELECT 1 FROM sales.customer c
                  WHERE c.id=NEW.customer_id AND c.mobile_normalized IS NOT NULL) THEN
    INSERT INTO platform.outbox_message(topic, payload)
    VALUES ('web.instore_push', jsonb_build_object('invoiceId', NEW.id, 'branchId', NEW.branch_id));
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION sales.notify_instore_purchase() FROM PUBLIC;
DROP TRIGGER IF EXISTS invoice_instore_push ON sales.invoice;
CREATE TRIGGER invoice_instore_push AFTER UPDATE OF finalized_at ON sales.invoice
FOR EACH ROW EXECUTE FUNCTION sales.notify_instore_purchase();

COMMENT ON FUNCTION sales.notify_instore_purchase() IS
  'اعلان بدون اطلاعات مشتری؛ برگشت تراکنش اعلان را نیز برمی‌گرداند. دریافت دوره‌ای پشتیبان باقی می‌ماند.';
