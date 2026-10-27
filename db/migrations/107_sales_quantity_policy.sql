BEGIN;

-- Only NEW/changed sale quantities are governed. Existing fractional invoices,
-- returns, inventory reconciliation, money edits and replay are never rewritten.
INSERT INTO platform.setting(key,value,description,requires_approval,kind,label,group_key,help,sort_order,permission,is_editable)
VALUES ('sales.allow_fractional_qty','false'::jsonb,
  'فروش با تعداد اعشاری مجاز باشد.', false, 'bool','فروش با تعداد اعشاری','sales',
  'پیش‌فرض خاموش: تعداد تازهٔ فروش باید صحیح باشد. روشن: تا سه رقم اعشار مجاز است. مقادیر قبلی و مرجوعی آن‌ها تغییر نمی‌کنند؛ خاموش‌کردن، ویرایش غیرتعدادی یا نهایی‌سازی پیش‌نویس قبلی را نمی‌بندد. این گزینه موجودی و شمارش انبار را گرد نمی‌کند.',
  36,'settings.security',true)
ON CONFLICT (key) DO NOTHING;

-- set_setting locks this same row FOR UPDATE. The shared lock is held through
-- commit, so a concurrent toggle cannot commit between decision and line write.
-- SECURITY DEFINER is needed only for row locking: app cannot UPDATE settings.
CREATE FUNCTION sales.assert_sale_quantity(p_qty numeric) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_allowed boolean;
BEGIN
  IF p_qty = trunc(p_qty) THEN RETURN; END IF;
  SELECT value = 'true'::jsonb INTO v_allowed FROM platform.setting
    WHERE key = 'sales.allow_fractional_qty' FOR SHARE;
  IF v_allowed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'تعداد تازهٔ فروش باید عدد صحیح باشد؛ فروش اعشاری در تنظیمات غیرفعال است';
  END IF;
END $$;
REVOKE ALL ON FUNCTION sales.assert_sale_quantity(numeric) FROM PUBLIC;
CREATE FUNCTION sales.sale_quantity_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.qty IS NOT DISTINCT FROM OLD.qty
     AND NEW.invoice_id IS NOT DISTINCT FROM OLD.invoice_id THEN RETURN NEW; END IF;
  PERFORM sales.assert_sale_quantity(NEW.qty);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION sales.sale_quantity_guard() FROM PUBLIC;
CREATE TRIGGER sale_quantity_guard BEFORE INSERT OR UPDATE OF qty, invoice_id
ON sales.invoice_line FOR EACH ROW EXECUTE FUNCTION sales.sale_quantity_guard();

-- Retain every v1/order/channel/status safeguard from105. Only new IG POS uses
-- the shared policy instead of the previous unconditional integer restriction.
CREATE OR REPLACE FUNCTION sales.instagram_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_invoice uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  inv record;
  o sales.instagram_order%ROWTYPE;
BEGIN
  SELECT channel, status INTO inv FROM sales.invoice WHERE id = v_invoice;
  IF inv.channel IS DISTINCT FROM 'instagram' OR inv.status <> 'draft' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  SELECT * INTO o FROM sales.instagram_order WHERE invoice_id = v_invoice FOR UPDATE;
  IF NOT FOUND THEN
    -- حالت صندوق: سیاست مشترک تعداد در sale_quantity_guard سنجیده می‌شود.
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF coalesce(current_setting('lmc.instagram_order', true), '') <> o.id::text THEN
    RAISE EXCEPTION 'اقلام سفارش اینستاگرام فقط از صفحهٔ همان سفارش تغییر می‌کند';
  END IF;
  IF o.status = 'confirming' THEN                 -- Snapshot بها در نهایی‌سازی
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF o.status <> 'draft' THEN
    RAISE EXCEPTION 'سفارش % رزرو یا بسته است؛ برای تغییر اقلام ابتدا رزرو را برگردانید', o.order_no;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.qty <> trunc(NEW.qty) THEN
    RAISE EXCEPTION 'تعداد کالای سفارش اینستاگرام باید عدد صحیح باشد';
  END IF;
  UPDATE sales.instagram_order SET version = version + 1, updated_at = now() WHERE id = o.id;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;


COMMIT;
