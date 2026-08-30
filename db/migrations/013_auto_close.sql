-- =====================================================================
-- ۰۱۳ — پیش‌فرض «آخرین قیمت خرید» و بستن خودکار دوره کانال آنلاین
-- =====================================================================
-- دو تصمیم مالک، در یک مهاجرت چون هر دو رفتار پیش‌فرض سیستم را عوض
-- می‌کنند:
--
-- ۱. روش قیمت تمام‌شده پیش‌فرض، «آخرین قیمت خرید» شود (مثل هلو).
-- ۲. دوره ثبت فروش سایت شبانه و خودکار بسته شود.
--
-- ⚠️ درباره تصمیم اول، آنچه بررسی شد و باید ثبت بماند:
--    استاندارد حسابداری شماره ۸ ایران روش‌های میانگین موزون، FIFO و
--    شناسایی ویژه را می‌پذیرد؛ «آخرین قیمت خرید» در آن فهرست نیست.
--    مالک با آگاهی از این نکته تصمیم گرفت. جزئیات در ADR-006.
--    پیش از اولین اظهارنامه باید با حسابدار تأیید شود.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. پیش‌فرض تازه — ولی فقط جایی که کسی دستش نزده
-- ---------------------------------------------------------------------
-- `updated_by IS NULL` یعنی این تنظیم از seed آمده و هیچ‌کس از مسیر
-- `platform.set_setting()` عوضش نکرده. اگر حسابدار روی نصبی صریحاً
-- «میانگین موزون» را انتخاب کرده باشد، این مهاجرت انتخابش را
-- برنمی‌گرداند — همان قاعده‌ای که seed هم رعایت می‌کند.

SELECT set_config('labelmod.setting_write', 'on', true);

UPDATE platform.setting
   SET value = '"last_purchase"'::jsonb
 WHERE key = 'costing.method'
   AND updated_by IS NULL
   AND value = '"moving_weighted_average"'::jsonb;

SELECT set_config('labelmod.setting_write', '', true);

-- ---------------------------------------------------------------------
-- ۲. بستن خودکار دوره کانال
-- ---------------------------------------------------------------------
-- **این تابع موجودی را دست نمی‌زند.** کالا در همان لحظه فروش از انبار
-- خارج شده (`finalize_invoice` → `apply_movement`). آنچه اینجا بسته
-- می‌شود فقط **سند حسابداری** درآمد و بهای تمام‌شده است.
--
-- فروش حضوری با بستن شیفت صندوق سندش را می‌گیرد. فروش سایت شیفت
-- ندارد، پس تا امروز کسی باید دستی `close-channel-day` را صدا می‌زد —
-- و اگر یادش می‌رفت، درآمد در `sales.unposted_revenue` می‌ماند.
--
-- ## سه قاعده که این تابع را بی‌خطر می‌کنند
--
-- **الف. دوره امروز هرگز بسته نمی‌شود.** فقط `business_date` کوچک‌تر
-- از امروز. وگرنه سفارش ساعت ۲۳ در دوره‌ای می‌افتاد که ساعت ۲۲ بسته
-- شده و `resolve_posting_batch` فاکتور را رد می‌کرد.
--
-- **ب. یک مهلت پس از نیمه‌شب.** `sales.auto_close_after_hours` —
-- فاصله‌ای برای سفارشی که دقیقه آخر ثبت شده و همگام‌سازی‌اش دیرتر
-- می‌رسد.
--
-- **ج. دوره مشکل‌دار رد می‌شود، نه اینکه کل اجرا را بشکند.** یک
-- فاکتور نیمه‌کاره در یک روز نباید مانع بسته‌شدن بیست روز و کانال
-- دیگر شود. دلیلش برمی‌گردد تا دیده شود.
--
-- تاریخ کاری از `now()::date` می‌آید — **همان عبارتی که
-- `resolve_posting_batch` برای ساختن دوره به کار می‌برد**، تا دو
-- تعریف متفاوت از «امروز» در سیستم نباشد. منطقه زمانی سرور دیتابیس
-- در `docker-compose.yml` روی `Asia/Tehran` است.

CREATE OR REPLACE FUNCTION sales.close_due_channel_days(
  p_actor uuid,
  p_now   timestamptz DEFAULT now()
) RETURNS TABLE (
  batch_id      uuid,
  branch_id     uuid,
  channel       text,
  business_date date,
  sale_entry    uuid,
  cogs_entry    uuid,
  skipped       text
) LANGUAGE plpgsql AS $$
DECLARE
  b       record;
  v_grace int;
  v_sale  uuid;
  v_cogs  uuid;
  v_open  int;
  v_rows  int;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'بستن دوره ثبت بدون کاربر عامل مجاز نیست.';
  END IF;

  IF NOT platform.setting_bool('sales.auto_close_channel_day', true) THEN
    RETURN;                          -- خاموش است؛ هیچ دوره‌ای بسته نمی‌شود
  END IF;

  v_grace := platform.setting_int('sales.auto_close_after_hours', 2);

  FOR b IN
    SELECT pb.id, pb.branch_id, pb.channel, pb.business_date
      FROM ledger.posting_batch pb
     WHERE pb.kind = 'channel_day'
       AND pb.status = 'open'
       AND pb.business_date < p_now::date
       AND p_now >= (pb.business_date + 1)::timestamp + make_interval(hours => v_grace)
     ORDER BY pb.business_date, pb.branch_id, pb.channel
  LOOP
    -- فاکتور نیمه‌کاره: دوره را رد کن، ولی بگو چرا.
    SELECT count(*) INTO v_open FROM sales.invoice
     WHERE posting_batch_id = b.id
       AND status IN ('draft','confirmed','partially_paid');

    IF v_open > 0 THEN
      batch_id := b.id; branch_id := b.branch_id; channel := b.channel;
      business_date := b.business_date; sale_entry := NULL; cogs_entry := NULL;
      skipped := format('%s فاکتور نهایی‌نشده دارد', v_open);
      RETURN NEXT;
      CONTINUE;
    END IF;

    -- دوره‌ای که هیچ فاکتور نهایی‌شده‌ای ندارد، سندی هم ندارد. بستنش
    -- یعنی «سند بدون سطر» — پس رد می‌شود، نه اینکه خطا بدهد.
    SELECT count(*) INTO v_rows FROM sales.invoice
     WHERE posting_batch_id = b.id
       AND status IN ('finalized','paid','partially_returned','returned');

    IF v_rows = 0 THEN
      batch_id := b.id; branch_id := b.branch_id; channel := b.channel;
      business_date := b.business_date; sale_entry := NULL; cogs_entry := NULL;
      skipped := 'فاکتور نهایی‌شده‌ای ندارد';
      RETURN NEXT;
      CONTINUE;
    END IF;

    SELECT s.sale_entry, s.cogs_entry INTO v_sale, v_cogs
      FROM sales.post_batch(b.id, p_actor) s;

    batch_id := b.id; branch_id := b.branch_id; channel := b.channel;
    business_date := b.business_date;
    sale_entry := v_sale; cogs_entry := v_cogs; skipped := NULL;
    RETURN NEXT;
  END LOOP;

  RETURN;
END $$;

COMMENT ON FUNCTION sales.close_due_channel_days IS
  'دوره‌های کانال آنلاینِ روزهای گذشته را می‌بندد. موجودی را دست نمی‌زند — فقط سند حسابداری. دوره امروز هرگز بسته نمی‌شود.';

COMMIT;
