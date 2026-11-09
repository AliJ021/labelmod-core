-- =====================================================================
-- ۱۱۶ — پیش‌نمایش «حساب مرجوعی» از دیتابیس
-- =====================================================================
-- تصمیم مالک (۲۰۲۶/۱۱/۰۹): ردیف‌های حساب مرجوعی طرح ۱۰ (بدهی همین فاکتور،
-- اول صرف بدهی، قابل بازپرداخت، مازاد به اعتبار مشتری) ساخته شوند — با
-- محاسبه در سرور. تا امروز صفحه فقط «ارزش کالا» را نشان می‌داد و آن را هم
-- `suggestedRefund` با BigInt در مرورگر حساب می‌کرد؛ صندوق‌دار نمی‌دید چقدر
-- از ارزش کالا صرف بدهی می‌شود، و اگر بیش از پول دریافت‌شده می‌نوشت، فقط
-- هنگام ثبت رد می‌شد.
--
-- این تابع **همان عبارت‌های** `sales.post_return` (نسخهٔ جاری: مهاجرت ۰۹۵)
-- را برای مرجوعی ساده (نه تعویض؛ تعویض `POST /exchanges/quote` خودش را
-- دارد) بی هیچ نوشتنی حساب می‌کند:
--   ارزش برگشتی   = Σ سطر (خالص + مالیات، نسبتی منهای برگشت‌های قبلی)
--   پشتوانه       = دریافتی + تأمین تعویض − بازپرداخت‌های قبلی
--   بدهی          = تعهد − برگشت‌های قبلی − دریافتی + بازپرداخت‌ها ± تعویض، کف صفر
--   صرف بدهی      = کمینهٔ (ارزش − بازپرداخت، بدهی)
--   اعتبار مشتری  = ارزش − بازپرداخت − صرف بدهی
--
-- «بازپرداخت پیشنهادی» = کمینهٔ (پشتوانه، ارزش − بدهی) با کف صفر: یعنی
-- اول بدهی همین فاکتور صاف می‌شود، بعد پول تا سقف دریافت‌شده برمی‌گردد، و
-- چیزی برای اعتبار نمی‌ماند. وقتی بدهی نیست، همان ارزش کالاست — رفتار قبلی.
-- صندوق‌دار هر عدد دیگری تا سقف را می‌تواند بنویسد؛ مازادش اعتبار مشتری است.
--
-- `db/test/return-account-preview.sql` برابری را با ثبت واقعی می‌سنجد
-- (`receivable_applied` و `credit_applied` برگ ثبت‌شده).
--
-- ⚠️ STABLE و SECURITY INVOKER: بی قفل و بی شماره. ثبت واقعی زیر قفل
-- فاکتور دوباره حساب می‌کند و نگهبان‌هایش همان‌جا می‌مانند.
-- ⚠️ ورودی نادرست (سطر بیگانه، تکراری، بیش از باقی‌مانده) همان پیام ثبت
-- را می‌دهد. ولی بازپرداخت نامجاز خطا **نیست**: در `problem` برمی‌گردد تا
-- صفحه پیش از ثبت نشانش دهد.
-- =====================================================================

BEGIN;

CREATE FUNCTION sales.return_account_preview(p_invoice uuid, p_lines jsonb, p_refund numeric DEFAULT NULL)
RETURNS TABLE (returned_value numeric, outstanding numeric, funds numeric, max_refund numeric,
               suggested_refund numeric, refund numeric, debt_applied numeric, customer_credit numeric,
               problem text)
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public
AS $function$
#variable_conflict use_column
DECLARE
  inv               sales.invoice%ROWTYPE;
  v_n               int;
  v_over            record;
  v_value           numeric;
  v_received        numeric;
  v_refunded_before numeric;
  v_returned_before numeric;
  v_funds           numeric;
  v_outstanding     numeric;
  v_max             numeric;
  v_suggest         numeric;
  v_refund          numeric;
  v_recv            numeric;
  v_credit          numeric;
  v_problem         text;
BEGIN
  SELECT * INTO inv FROM sales.invoice WHERE id = p_invoice;
  IF NOT FOUND THEN RAISE EXCEPTION 'فاکتور یافت نشد'; END IF;
  IF inv.status NOT IN ('finalized','paid','partially_returned') THEN
    RAISE EXCEPTION 'فاکتور % در وضعیت قابل مرجوعی نیست (%)', sales.invoice_display_number(inv.id), inv.status;
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'برگ مرجوعی بدون قلم ساخته نمی‌شود';
  END IF;
  SELECT count(*) - count(DISTINCT x->>'invoiceLineId') INTO v_n FROM jsonb_array_elements(p_lines) x;
  IF v_n > 0 THEN RAISE EXCEPTION 'یک سطر فاکتور دو بار در برگ مرجوعی آمده است'; END IF;
  SELECT count(*) INTO v_n FROM jsonb_array_elements(p_lines) x
   WHERE NOT EXISTS (SELECT 1 FROM sales.invoice_line il WHERE il.invoice_id = p_invoice AND il.id::text = x->>'invoiceLineId');
  IF v_n > 0 THEN RAISE EXCEPTION 'سطر مرجوعی به این فاکتور تعلق ندارد'; END IF;

  -- همان پیام و همان سنجش ثبت: تعداد مثبت و حداکثر باقی‌ماندهٔ سطر.
  SELECT count(*) INTO v_n FROM jsonb_array_elements(p_lines) x
    JOIN sales.invoice_line il ON il.id::text = x->>'invoiceLineId'
   WHERE (x->>'qty')::numeric(14,3) IS NULL OR (x->>'qty')::numeric(14,3) <= 0;
  IF v_n > 0 THEN RAISE EXCEPTION 'تعداد مرجوعی باید بزرگ‌تر از صفر باشد'; END IF;
  SELECT (x->>'qty')::numeric(14,3) AS wanted, il.qty - il.returned_qty AS remaining INTO v_over
    FROM jsonb_array_elements(p_lines) x JOIN sales.invoice_line il ON il.id::text = x->>'invoiceLineId'
   WHERE (x->>'qty')::numeric(14,3) > il.qty - il.returned_qty LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'تعداد مرجوعی بیش از باقی‌مانده سطر است: درخواست %، باقی‌مانده %', v_over.wanted, v_over.remaining;
  END IF;

  -- ارزش هر سطر: همان دو عبارت `UPDATE sales.sale_return_line` در ثبت (خالص و مالیات جدا گرد می‌شوند).
  SELECT coalesce(sum(
           round(il.net_amount * (il.returned_qty + q.qty) / il.qty) - coalesce((
             SELECT sum(x.net_amount) FROM sales.sale_return_line x JOIN sales.sale_return y ON y.id = x.return_id
              WHERE x.invoice_line_id = il.id AND y.status = 'posted'), 0)
         + round(il.tax_amount * (il.returned_qty + q.qty) / il.qty) - coalesce((
             SELECT sum(x.tax_amount) FROM sales.sale_return_line x JOIN sales.sale_return y ON y.id = x.return_id
              WHERE x.invoice_line_id = il.id AND y.status = 'posted'), 0)), 0)
    INTO v_value
    FROM (SELECT (x->>'invoiceLineId')::uuid AS id, (x->>'qty')::numeric(14,3) AS qty FROM jsonb_array_elements(p_lines) x) q
    JOIN sales.invoice_line il ON il.id = q.id;

  -- پول واقعاً دریافت‌شده بابت این فاکتور. «نامشخص» پول نیست.
  SELECT coalesce(sum(CASE WHEN p.direction='in' THEN p.amount ELSE -p.amount END),0) INTO v_received
    FROM treasury.payment p JOIN treasury.payment_method m ON m.code=p.method_code
   WHERE p.invoice_id=inv.id AND m.kind<>'credit'
     AND p.status IN ('succeeded','settled','reconciled');

  SELECT coalesce(sum(refund_amount),0), coalesce(sum(net_amount + tax_amount + shipping_amount),0)
    INTO v_refunded_before, v_returned_before
    FROM sales.sale_return WHERE invoice_id = inv.id AND status = 'posted';

  v_funds := v_received + sales.exchange_funding(inv.id) - v_refunded_before;
  v_outstanding := inv.payable_amount - v_returned_before - v_received + v_refunded_before
    + sales.exchange_out(inv.id) - sales.exchange_in(inv.id);
  IF v_outstanding < 0 THEN v_outstanding := 0; END IF;

  v_max     := least(v_value, greatest(v_funds, 0));
  v_suggest := least(greatest(v_funds, 0), greatest(v_value - v_outstanding, 0));
  v_refund  := coalesce(p_refund, v_suggest);
  v_recv    := least(greatest(v_value - v_refund, 0), v_outstanding);
  v_credit  := (v_value - v_refund) - v_recv;

  v_problem := CASE
    WHEN v_refund < 0 THEN 'مبلغ بازپرداخت منفی نمی‌شود.'
    WHEN v_refund > v_value THEN 'بازپرداخت بیش از ارزش کالای مرجوعی است.'
    WHEN v_refund > v_funds THEN 'بازپرداخت بیش از مبلغ دریافت‌شده بابت این فاکتور است. پولی که گرفته نشده، پس داده نمی‌شود.'
    WHEN v_credit > 0 AND inv.customer_id IS NULL THEN 'فروش ناشناس اعتبار مشتری نمی‌پذیرد. برای مرجوعی این فاکتور، بازپرداخت باید کامل باشد.'
    ELSE NULL END;

  RETURN QUERY SELECT v_value, v_outstanding, v_funds, v_max, v_suggest, v_refund, v_recv, v_credit, v_problem;
END $function$;

COMMENT ON FUNCTION sales.return_account_preview(uuid, jsonb, numeric) IS
  'پیش‌نمایش فقط‌خواندنی حساب مرجوعی ساده با همان عبارت‌های sales.post_return (۰۹۵): ارزش، بدهی، پشتوانه، سقف و پیشنهاد بازپرداخت، صرف بدهی و اعتبار مشتری. برابری در db/test/return-account-preview.sql.';

COMMIT;
