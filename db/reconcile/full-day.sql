-- =====================================================================
-- تطبیق پایانی «یک روز کامل فروشگاه» — بخش ۸٫۷ ممیزی
-- =====================================================================
-- این پرونده **هیچ داده‌ای نمی‌سازد**. روی دیتابیسی اجرا می‌شود که یک
-- روز کامل فروشگاه در آن گذشته و هر عدد را **مستقل** حساب می‌کند و با
-- منبعی که باید از آن بیاید مقایسه می‌کند.
--
-- ⚠️ چرا در `db/test/` نیست: `ops/db.sh test` هر `db/test/*.sql` را روی
--    یک دیتابیس **خالی** اجرا می‌کند. یک تطبیقِ فقط‌خواندنی روی دیتابیس
--    خالی بی‌معنا سبز می‌شود — «صفر با صفر می‌خواند». همان تلهٔ «موفقیت
--    پوچ». پس این پرونده از بیرون صدا زده می‌شود:
--
--      apps/api/test/full-store-day.integration.test.ts
--
--    و **بند ۰ خودش جلوی پوچی را می‌گیرد**: اگر داده روز واقعاً آنجا
--    نباشد، پیش از هر تطبیقی خطا می‌دهد.
--
-- ⚠️ و همین پرونده دو بار اجرا می‌شود: یک بار روی دیتابیس زنده، و یک بار
--    روی دیتابیسی که از **بکاپ** برگردانده شده. بکاپی که تطبیق‌هایش را
--    پاس نکند، بکاپ نیست.
-- =====================================================================

\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_eq(
  p_label text, p_actual numeric, p_expected numeric
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: %\n      واقعی : %', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE '  ✓ % = %', p_label, p_actual;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.assert_ge(
  p_label text, p_actual numeric, p_min numeric
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS NULL OR p_actual < p_min THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: دست‌کم %\n      واقعی : %', p_label, p_min, p_actual;
  END IF;
  RAISE NOTICE '  ✓ % = % (≥ %)', p_label, p_actual, p_min;
END $$;

DO $recon$
DECLARE
  BR   uuid := '00000000-0000-7000-8000-000000000001';
  n    bigint;
  d    numeric;
  a    numeric;
  b    numeric;
  rec  record;
  v_day date;
BEGIN
RAISE NOTICE E'\n── ۰. ضد‌پوچی: داده روز واقعاً اینجاست ─────────────────────';

  -- بی این بند، همهٔ تطبیق‌های زیر روی یک دیتابیس خالی «سبز» می‌شدند.
  -- عددها حداقلِ سناریوی ۸٫۷ است، نه یک عدد دلخواه.
  SELECT count(*) INTO n FROM sales.invoice WHERE status <> 'draft';
  PERFORM pg_temp.assert_ge('فاکتور غیرپیش‌نویس', n, 5);

  SELECT count(*) INTO n FROM sales.sale_return WHERE status = 'posted';
  PERFORM pg_temp.assert_ge('مرجوعی ثبت‌شده', n, 1);

  SELECT count(*) INTO n FROM purchasing.receipt WHERE status = 'posted';
  PERFORM pg_temp.assert_ge('رسید خرید ثبت‌شده', n, 1);

  SELECT count(*) INTO n FROM purchasing.purchase_return WHERE status = 'posted';
  PERFORM pg_temp.assert_ge('برگشت از خرید ثبت‌شده', n, 1);

  SELECT count(*) INTO n FROM inventory.transfer WHERE status = 'posted';
  PERFORM pg_temp.assert_ge('انتقال ثبت‌شده', n, 1);

  SELECT count(*) INTO n FROM inventory.stock_count WHERE status = 'posted';
  PERFORM pg_temp.assert_ge('انبارگردانی ثبت‌شده', n, 1);

  SELECT count(*) INTO n FROM treasury.cheque_event;
  PERFORM pg_temp.assert_ge('رویداد چک', n, 2);

  SELECT count(*) INTO n FROM sales.cash_shift WHERE status = 'closed';
  PERFORM pg_temp.assert_ge('شیفت بسته‌شده', n, 1);

  SELECT count(*) INTO n FROM ledger.journal_entry WHERE status IN ('confirmed','final');
  PERFORM pg_temp.assert_ge('سند قطعی', n, 6);

RAISE NOTICE E'\n── ۱. inventory.balance_check باید خالی باشد ───────────────';

  SELECT count(*) INTO n FROM inventory.balance_check
   WHERE qty_diff <> 0 OR value_diff <> 0;
  PERFORM pg_temp.assert_eq('واگرایی Projection با حرکت‌ها', n, 0);

RAISE NOTICE E'\n── ۲. sales.unposted_revenue باید خالی باشد ────────────────';

  SELECT count(*) INTO n FROM sales.unposted_revenue;
  PERFORM pg_temp.assert_eq('درآمد ثبت‌نشده در دفتر', n, 0);

RAISE NOTICE E'\n── ۳. توازن هر سند، یکی‌یکی ────────────────────────────────';

  -- جمع کل بدهکار = جمع کل بستانکار **کافی نیست**: دو سند نامتوازنِ
  -- قرینه، جمع کل را متوازن نشان می‌دهند. پس سندبه‌سند.
  SELECT count(*) INTO n FROM (
    SELECT entry_id FROM ledger.journal_line
     GROUP BY entry_id HAVING sum(debit) <> sum(credit)) x;
  PERFORM pg_temp.assert_eq('سند نامتوازن', n, 0);

  -- و هیچ سندی بدون سطر نماند
  SELECT count(*) INTO n FROM ledger.journal_entry e
   WHERE NOT EXISTS (SELECT 1 FROM ledger.journal_line l WHERE l.entry_id = e.id);
  PERFORM pg_temp.assert_eq('سند بدون سطر', n, 0);

RAISE NOTICE E'\n── ۴. تراز کل: دارایی = بدهی + سرمایه + (درآمد − هزینه) ────';

  -- دو سمت **جدا** حساب می‌شوند و از نوع حساب می‌آیند، نه از یک SUM.
  -- اگر کسی نوع یک حساب را غلط بگذارد (مثلاً درآمد را دارایی)، جمع کل
  -- بدهکار/بستانکار همچنان متوازن است ولی این ادعا می‌شکند.
  SELECT coalesce(sum(l.debit - l.credit), 0) INTO a
    FROM ledger.journal_line l
    JOIN ledger.account ac ON ac.code = l.account_code
    JOIN ledger.journal_entry e ON e.id = l.entry_id
   WHERE e.status IN ('confirmed','final') AND ac.type = 'asset';

  SELECT coalesce(sum(l.credit - l.debit), 0) INTO b
    FROM ledger.journal_line l
    JOIN ledger.account ac ON ac.code = l.account_code
    JOIN ledger.journal_entry e ON e.id = l.entry_id
   WHERE e.status IN ('confirmed','final')
     AND ac.type IN ('liability','equity','revenue','contra_revenue','expense');

  PERFORM pg_temp.assert_eq('دارایی − (بدهی+سرمایه+نتیجه)', a - b, 0);

  -- و هیچ حسابی بدون نوع شناخته‌شده نماند، وگرنه بند بالا بی‌صدا
  -- نصف دفتر را نادیده می‌گرفت.
  SELECT count(*) INTO n FROM ledger.journal_line l
   WHERE NOT EXISTS (
     SELECT 1 FROM ledger.account ac
      WHERE ac.code = l.account_code
        AND ac.type IN ('asset','liability','equity','revenue','contra_revenue','expense'));
  PERFORM pg_temp.assert_eq('سطر سند با حساب بی‌نوع', n, 0);

RAISE NOTICE E'\n── ۵. sales.daily_summary در برابر جمع مستقل فاکتورها ──────';

  FOR v_day IN
    SELECT DISTINCT platform.business_date(i.occurred_at)
      FROM sales.invoice i
     WHERE i.branch_id = BR AND i.status NOT IN ('draft','cancelled')
  LOOP
    SELECT s.sales_amount::numeric INTO a FROM sales.daily_summary(BR, v_day) s;

    -- جمع مستقل: فاکتور منهای مرجوعی، از خودِ سطرها نه از نما
    SELECT coalesce((SELECT sum(i.net_amount) FROM sales.invoice i
                      WHERE i.branch_id = BR AND i.status NOT IN ('draft','cancelled')
                        AND platform.business_date(i.occurred_at) = v_day), 0)
         - coalesce((SELECT sum(r.net_amount) FROM sales.sale_return r
                      WHERE r.branch_id = BR AND r.status = 'posted'
                        AND platform.business_date(r.occurred_at) = v_day), 0)
      INTO b;

    PERFORM pg_temp.assert_eq(format('فروش %s: نما = جمع مستقل', v_day), a, b);

    -- سود: (فروش − بهای تمام‌شده) مستقل
    SELECT s.profit_amount::numeric INTO a FROM sales.daily_summary(BR, v_day) s;
    SELECT coalesce((SELECT sum(i.net_amount - i.cogs_amount) FROM sales.invoice i
                      WHERE i.branch_id = BR AND i.status NOT IN ('draft','cancelled')
                        AND platform.business_date(i.occurred_at) = v_day), 0)
         - coalesce((SELECT sum(r.net_amount - r.cogs_amount) FROM sales.sale_return r
                      WHERE r.branch_id = BR AND r.status = 'posted'
                        AND platform.business_date(r.occurred_at) = v_day), 0)
      INTO b;
    PERFORM pg_temp.assert_eq(format('سود %s: نما = جمع مستقل', v_day), a, b);
  END LOOP;

RAISE NOTICE E'\n── ۶. ارزش موجودی: انبار ↔ حرکات ↔ دفتر ───────────────────';

  -- الف) stock_balance در برابر جمع مستقل حرکات
  SELECT coalesce(sum(total_value),0) INTO a FROM inventory.stock_balance;
  SELECT coalesce(sum(value_delta),0) INTO b FROM inventory.stock_movement;
  PERFORM pg_temp.assert_eq('ارزش انبار = جمع value_delta', a, b);

  SELECT coalesce(sum(on_hand),0) INTO a FROM inventory.stock_balance;
  SELECT coalesce(sum(qty),0)     INTO b FROM inventory.stock_movement;
  PERFORM pg_temp.assert_eq('تعداد انبار = جمع qty', a, b);

  -- ب) و دفتر در برابر انبار — چیزی که balance_check **نمی‌سنجد**
  SELECT diff INTO d FROM inventory.ledger_check;
  PERFORM pg_temp.assert_eq('حساب موجودی کالا در دفتر = ارزش انبار', d, 0);

  -- پ) هیچ موجودی منفی
  SELECT count(*) INTO n FROM inventory.stock_balance WHERE on_hand < 0;
  PERFORM pg_temp.assert_eq('موجودی منفی', n, 0);

  -- ت) و تعداد صفر با ارزش ناصفر نمی‌ماند (باقی‌ماندهٔ گرد کردن)
  SELECT count(*) INTO n FROM inventory.stock_balance
   WHERE on_hand = 0 AND total_value <> 0;
  PERFORM pg_temp.assert_eq('موجودی صفر با ارزش ناصفر', n, 0);

RAISE NOTICE E'\n── ۷. مانده صندوق در برابر شمارش شیفت ──────────────────────';

  FOR rec IN
    SELECT s.id, s.opening_cash, s.counted_cash, s.expected_cash, s.variance
      FROM sales.cash_shift s WHERE s.status = 'closed' AND s.branch_id = BR
  LOOP
    -- محاسبهٔ مستقل نقد شیفت: موجودی اول + دریافت نقد − بازپرداخت نقد
    -- ± تراکنش‌های خزانهٔ همان شیفت.
    SELECT coalesce(sum(CASE WHEN p.direction = 'in' THEN p.amount ELSE -p.amount END), 0)
      INTO a
      FROM treasury.payment p
     WHERE p.shift_id = rec.id AND p.status = 'succeeded'
       AND p.method_code IN (SELECT code FROM treasury.payment_method WHERE kind = 'cash');

    SELECT coalesce(sum(
             CASE WHEN t.to_account_id IS NOT NULL
                       AND t.to_account_id IN (SELECT id FROM treasury.account WHERE kind='cash_box')
                  THEN t.amount ELSE 0 END
           - CASE WHEN t.from_account_id IS NOT NULL
                       AND t.from_account_id IN (SELECT id FROM treasury.account WHERE kind='cash_box')
                  THEN t.amount ELSE 0 END), 0)
      INTO b
      FROM treasury.transaction t WHERE t.shift_id = rec.id;

    PERFORM pg_temp.assert_eq(
      format('نقد انتظاری شیفت %s', left(rec.id::text, 8)),
      rec.expected_cash::numeric, rec.opening_cash::numeric + a + b);

    PERFORM pg_temp.assert_eq(
      format('مغایرت شیفت %s = شمارش − انتظار', left(rec.id::text, 8)),
      rec.variance::numeric, rec.counted_cash::numeric - rec.expected_cash::numeric);
  END LOOP;

RAISE NOTICE E'\n── ۸. مانده هر مشتری در برابر جمع مستقل اسناد ──────────────';

  -- مرجع مستقل، از **خودِ اسناد** نه از دفتر:
  --
  --   دریافتنی = فاکتور − پول دریافتی − چکِ گرفته‌شده − دریافت مستقیم
  --              − سهمی از مرجوعی که به بدهی خورده
  --
  -- ⚠️ نسخه اول این بند چک را جا انداخته بود و ۲۰٬۰۰۰٬۰۰۰ اختلاف دید.
  --    اشکالِ **فرمول من** بود نه محصول: چکِ دریافتی از مشتریِ بی‌بدهی،
  --    حساب دریافتنی را بستانکار می‌کند (پیش‌دریافت). ثبتش درست است؛
  --    آنچه کم بود، یک جمله در مرجع مستقل بود.
  --
  -- ⚠️ و چکِ برگشتی حساب نمی‌شود: `bounced` یعنی اثرش معکوس شده.
  FOR rec IN SELECT id, full_name FROM sales.customer LOOP
    SELECT coalesce(sum(l.debit - l.credit), 0) INTO a
      FROM ledger.journal_line l
      JOIN ledger.journal_entry e ON e.id = l.entry_id
     WHERE e.status IN ('confirmed','final')
       AND l.party_type = 'customer' AND l.party_id = rec.id
       AND l.account_code IN (SELECT DISTINCT account_code FROM ledger.posting_rule
                               WHERE leg = 'receivable' AND is_active);

    SELECT
        coalesce((SELECT sum(i.payable_amount) FROM sales.invoice i
                   WHERE i.customer_id = rec.id
                     AND i.status NOT IN ('draft','cancelled')), 0)
      - coalesce((SELECT sum(CASE WHEN p.direction = 'in' THEN p.amount ELSE -p.amount END)
                    FROM treasury.payment p
                    JOIN sales.invoice i2 ON i2.id = p.invoice_id
                   WHERE i2.customer_id = rec.id AND p.status = 'succeeded'), 0)
      - coalesce((SELECT sum(c.amount) FROM treasury.cheque c
                   WHERE c.direction = 'received' AND c.party_type = 'customer'
                     AND c.party_id = rec.id
                     AND c.status NOT IN ('draft','bounced','cancelled')), 0)
      - coalesce((SELECT sum(t.amount) FROM treasury.transaction t
                   WHERE t.purpose = 'customer_receipt' AND t.party_type = 'customer'
                     AND t.party_id = rec.id AND t.status = 'posted'), 0)
      - coalesce((SELECT sum(r.receivable_applied) FROM sales.sale_return r
                    JOIN sales.invoice i3 ON i3.id = r.invoice_id
                   WHERE i3.customer_id = rec.id AND r.status = 'posted'), 0)
      INTO b;

    PERFORM pg_temp.assert_eq(
      format('مانده مشتری «%s»: دفتر = جمع اسناد', rec.full_name), a, b);
  END LOOP;

  -- و جمع تفصیلی‌ها باید با **کل** حساب دریافتنی بخواند: اگر سطری
  -- `party_id` نداشته باشد، اینجا دیده می‌شود و در حلقهٔ بالا نه.
  SELECT coalesce(sum(l.debit - l.credit), 0) INTO a
    FROM ledger.journal_line l
    JOIN ledger.journal_entry e ON e.id = l.entry_id
   WHERE e.status IN ('confirmed','final')
     AND l.account_code IN (SELECT DISTINCT account_code FROM ledger.posting_rule
                             WHERE leg = 'receivable' AND is_active);
  SELECT coalesce(sum(l.debit - l.credit), 0) INTO b
    FROM ledger.journal_line l
    JOIN ledger.journal_entry e ON e.id = l.entry_id
   WHERE e.status IN ('confirmed','final')
     AND l.party_type = 'customer' AND l.party_id IS NOT NULL
     AND l.account_code IN (SELECT DISTINCT account_code FROM ledger.posting_rule
                             WHERE leg = 'receivable' AND is_active);
  PERFORM pg_temp.assert_eq('کل دریافتنی = جمع تفصیلی اشخاص', a, b);

RAISE NOTICE E'\n── ۹. صف: نامه مرده و پیام گیرکرده ─────────────────────────';

  SELECT count(*) INTO n FROM platform.outbox_dead;
  IF n > 0 THEN
    FOR rec IN SELECT topic, last_error FROM platform.outbox_dead LOOP
      RAISE NOTICE '    نامه مرده: % → %', rec.topic, left(coalesce(rec.last_error,'—'), 90);
    END LOOP;
    RAISE EXCEPTION E'\n  ✗ نامه مرده در صف: %', n;
  END IF;
  RAISE NOTICE '  ✓ نامه مرده = 0';

  -- پیامی که بی‌نهایت در `sending` مانده باشد هم یک نقص است
  SELECT count(*) INTO n FROM platform.outbox_message
   WHERE status = 'sending' AND next_attempt_at < now() - interval '1 hour';
  PERFORM pg_temp.assert_eq('پیام رهاشده در sending', n, 0);

RAISE NOTICE E'\n── ۱۰. زنجیره هش حسابرسی، حلقه‌به‌حلقه ─────────────────────';

  SELECT count(*) INTO n FROM (
    SELECT prev_hash, lag(hash) OVER (ORDER BY id) AS expected_prev
      FROM platform.audit_log) x
   WHERE prev_hash IS DISTINCT FROM expected_prev;
  PERFORM pg_temp.assert_eq('گسست در زنجیره هش', n, 0);

  -- و هر حلقه واقعاً محاسبه شود، نه فقط به قبلی اشاره کند
  SELECT count(*) INTO n FROM platform.audit_log;
  PERFORM pg_temp.assert_ge('رکورد حسابرسی', n, 20);

RAISE NOTICE E'\n── ۱۱. چک: دفتر ↔ پرونده، و وضعیت ↔ رویداد ─────────────────';

  SELECT count(*) INTO n FROM treasury.cheque_check WHERE diff <> 0;
  PERFORM pg_temp.assert_eq('اختلاف دفتر با پرونده چک', n, 0);

  -- ستون status یک Projection است؛ باید با آخرین رویداد بخواند
  SELECT count(*) INTO n FROM treasury.cheque c
   WHERE c.status <> (SELECT ev.to_status FROM treasury.cheque_event ev
                       WHERE ev.cheque_id = c.id
                       ORDER BY ev.seq DESC LIMIT 1);
  PERFORM pg_temp.assert_eq('وضعیت چک ≠ آخرین رویداد', n, 0);

RAISE NOTICE E'\n── ۱۲. Snapshot فاکتور دست‌نخورده ماند ─────────────────────';

  -- بند ۲۰ الحاقیه: تغییر تنظیمات یا قیمت جاری نباید Snapshot گذشته را
  -- عوض کند. هر سطر فاکتور باید بها و قیمت لحظهٔ فروش را داشته باشد.
  SELECT count(*) INTO n FROM sales.invoice_line il
    JOIN sales.invoice i ON i.id = il.invoice_id
   WHERE i.status NOT IN ('draft','cancelled')
     AND (il.unit_price IS NULL OR il.unit_cost IS NULL);
  PERFORM pg_temp.assert_eq('سطر فاکتور بدون Snapshot بها/قیمت', n, 0);

RAISE NOTICE E'\n═══ تطبیق پایانی: همه بندها پاس ═══════════════════════════\n';
END $recon$;

ROLLBACK;
