-- =====================================================================
-- ۱۱۵ — پیش‌نمایش برگشت از خرید از دیتابیس، نه از مرورگر
-- =====================================================================
-- تصمیم مالک (۲۰۲۶/۱۱/۰۹): هر عدد پولی که پیش از تأیید دیده می‌شود هم از
-- دیتابیس بیاید. فرم برگشت از خرید تا امروز «کاهش بدهی» و «کاهش ارزش
-- موجودی» را با BigInt در مرورگر حساب می‌کرد، و دو جا با ثبت واقعی فرق
-- داشت:
--   ۱. «کاهش بدهی» فقط بهای کالا بود؛ `post_purchase_return` بدهی را به
--      اندازهٔ بهای کالا **به‌علاوهٔ مالیات** سهم همان کالا کم می‌کند.
--   ۲. برگشتِ آخرین تکهٔ یک سطر رسید، باقی‌ماندهٔ گرد کردن را می‌برد
--      (`line_amount + charge_alloc − برگشت‌های قبلی`)، نه `qty × بها`.
--
-- این تابع **همان عبارت‌های** `post_purchase_return` (نسخهٔ جاری: مهاجرت
-- ۰۶۲) را بی هیچ نوشتنی حساب می‌کند. `db/test/purchase-return-preview.sql`
-- برابری را با ثبت واقعی می‌سنجد: برگشت جزئی، برگشت آخرین تکه، چند برگشت
-- پیاپی و مالیات غیرصفر. اگر روزی فرمول ثبت عوض شود و این نه، آن آزمون
-- قرمز می‌شود.
--
-- ⚠️ STABLE و SECURITY INVOKER: نه قفل می‌گیرد نه شماره می‌سوزاند. عدد
-- پیش‌نمایش تصویر همین لحظه است؛ ثبت واقعی زیر قفل دوباره حساب می‌کند و
-- اگر برگشت هم‌زمانی باقی‌مانده را کم کرده باشد، همان پیام «بیشتر از آنچه
-- رسید شده» را می‌دهد.
-- ⚠️ پیام‌های خطا همان پیام‌های ثبت‌اند (P0001 ← ۴۰۹ برای کاربر).
-- =====================================================================

BEGIN;

CREATE FUNCTION purchasing.purchase_return_preview(p_receipt uuid, p_lines jsonb)
RETURNS TABLE (goods_amount numeric, cost_amount numeric, tax_amount numeric,
               charge_loss numeric, payable_reduction numeric)
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public
AS $function$
#variable_conflict use_column
DECLARE
  rc              purchasing.receipt%ROWTYPE;
  v_line          record;
  v_goods         numeric := 0;
  v_cost          numeric := 0;
  v_tax           numeric := 0;
  v_line_cost     numeric;
  v_receipt_goods numeric;
  v_n             int;
BEGIN
  SELECT * INTO rc FROM purchasing.receipt WHERE id = p_receipt;
  IF NOT FOUND THEN RAISE EXCEPTION 'رسید خرید یافت نشد'; END IF;
  IF rc.status <> 'posted' THEN
    RAISE EXCEPTION 'رسید خرید هنوز ثبت نشده — چیزی نیامده که برگردد';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'برگ برگشت بدون قلم قابل ثبت نیست';
  END IF;

  -- همان قید یکتای (برگه، سطر رسید) جدول برگشت: هر سطر رسید یک بار.
  SELECT count(*) - count(DISTINCT x->>'receiptLineId') INTO v_n FROM jsonb_array_elements(p_lines) x;
  IF v_n > 0 THEN RAISE EXCEPTION 'یک سطر رسید دو بار در برگه آمده است'; END IF;

  -- سطر باید به همین رسید بچسبد (همان سنجش `createDraft`).
  SELECT count(*) INTO v_n FROM jsonb_array_elements(p_lines) x
   WHERE NOT EXISTS (SELECT 1 FROM purchasing.receipt_line rl
                      WHERE rl.receipt_id = p_receipt AND rl.id::text = x->>'receiptLineId');
  IF v_n > 0 THEN RAISE EXCEPTION 'سطر برگشت به هیچ سطری از رسید نمی‌چسبد'; END IF;

  -- جمع کالای خودِ رسید — پایهٔ تسهیم مالیات (همان عبارت ثبت).
  SELECT coalesce(sum(round(qty * unit_price)), 0) INTO v_receipt_goods
    FROM purchasing.receipt_line WHERE receipt_id = p_receipt;

  FOR v_line IN
    SELECT (x->>'qty')::numeric(14,3) AS qty, rl.id AS receipt_line_id,
           rl.unit_price, rl.line_amount, rl.charge_alloc, rl.qty AS received_qty, rl.returned_qty
      FROM jsonb_array_elements(p_lines) x
      JOIN purchasing.receipt_line rl ON rl.id::text = x->>'receiptLineId' AND rl.receipt_id = p_receipt
  LOOP
    IF v_line.qty IS NULL OR v_line.qty <= 0 THEN
      RAISE EXCEPTION 'تعداد باید بزرگ‌تر از صفر باشد';
    END IF;
    IF v_line.returned_qty + v_line.qty > v_line.received_qty THEN
      RAISE EXCEPTION
        'بیشتر از آنچه رسید شده برگشت داده می‌شود: رسیدشده %، قبلاً برگشته %، درخواست %',
        v_line.received_qty, v_line.returned_qty, v_line.qty;
    END IF;

    IF v_line.returned_qty + v_line.qty = v_line.received_qty THEN
      SELECT v_line.line_amount + v_line.charge_alloc - coalesce(sum(x.cost_amount), 0)
        INTO v_line_cost FROM purchasing.purchase_return_line x JOIN purchasing.purchase_return y ON y.id = x.return_id
       WHERE x.receipt_line_id = v_line.receipt_line_id AND y.status = 'posted';
    ELSE
      v_line_cost := round((v_line.line_amount + v_line.charge_alloc) * v_line.qty / v_line.received_qty);
    END IF;

    v_goods := v_goods + round(v_line.qty * v_line.unit_price);
    v_cost  := v_cost + v_line_cost;
  END LOOP;

  v_tax := CASE WHEN v_receipt_goods > 0
                THEN round(rc.tax_amount * (v_goods + coalesce((SELECT sum(goods_amount) FROM purchasing.purchase_return
                       WHERE receipt_id = rc.id AND status = 'posted'), 0)) / v_receipt_goods)
                     - coalesce((SELECT sum(tax_amount) FROM purchasing.purchase_return WHERE receipt_id = rc.id AND status = 'posted'), 0)
                ELSE 0 END;

  RETURN QUERY SELECT v_goods, v_cost, v_tax, v_cost - v_goods, v_goods + v_tax;
END $function$;

COMMENT ON FUNCTION purchasing.purchase_return_preview(uuid, jsonb) IS
  'پیش‌نمایش فقط‌خواندنی برگشت از خرید با همان عبارت‌های post_purchase_return (۰۶۲): بهای کالا، ارزش دفتری، مالیات، حمل برنگشتنی و کاهش بدهی (کالا + مالیات). برابری در db/test/purchase-return-preview.sql.';

COMMIT;
