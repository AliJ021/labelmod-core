-- =====================================================================
-- ۰۳۸ — مرز روز در گزارش‌ها هم از منطقه زمانی کسب‌وکار می‌آید
-- =====================================================================
--
-- ## باگ
--
-- گزارش‌های ۰۳۵ روزِ هر رکورد را با `platform.business_date()` — یعنی
-- به وقت تهران — **گروه‌بندی** می‌کردند، ولی بازه را با
-- `p_from::timestamptz` **فیلتر**. و آن Cast، تاریخ را در منطقه زمانی
-- **سرور** به timestamptz تبدیل می‌کند، نه در منطقه کسب‌وکار.
--
-- روی سروری با UTC (همان چیزی که `docs/DEPLOYMENT.md` می‌سازد) این
-- یعنی هر فروشِ بین **۰۰:۰۰ تا ۰۳:۳۰ بامداد به وقت تهران**:
--
--   * در گروه‌بندی به روز درست (مثلاً ۱۵ شهریور) می‌خورد،
--   * ولی در فیلترِ همان روز نمی‌گنجد، چون هنوز ۱۴ شهریور UTC است.
--
-- نتیجه: آن فروش **در هیچ روزی دیده نمی‌شود**. گزارش فروش روزانه
-- کمتر از دفتر می‌شد و هیچ خطایی هم نمی‌داد.
--
-- ## چرا تست‌ها نگرفته بودند
--
-- `db/test/reports.sql` روز را با `platform.business_date()` می‌گیرد و
-- فاکتور را با `now()` می‌سازد. این دو فقط در همان پنجره ۳٫۵ ساعته از
-- هم جدا می‌شوند — پس تست ۲۰٫۵ ساعت از شبانه‌روز سبز بود و ۳٫۵ ساعت
-- قرمز. یک اجرای شبانه در CI آن را پیدا کرد.
--
-- این دقیقاً همان کلاسی است که CLAUDE.md درباره‌اش هشدار داده:
-- «"امروز" یک تعریف دارد، نه چند تا». اینجا دو تا بود — یکی برای
-- گروه‌بندی و یکی برای فیلتر.
--
-- ## اصلاح
--
-- `platform.business_day_start(date)` — لحظه‌ای که آن روزِ کاری شروع
-- می‌شود، در منطقه زمانی کسب‌وکار. همان تعریفی که
-- `platform.business_date()` از آن می‌آید، فقط در جهت معکوس.
--
-- مرز `<` روی روزِ بعد می‌ماند (نه `<=` روی پایان روز): با `<=` یک
-- رکورد دقیقاً روی نیمه‌شب در هر دو روز شمرده می‌شد.
--
-- ⚠️ فقط توابعی که روی `timestamptz` فیلتر می‌کنند اصلاح می‌شوند.
--    گزارش‌های دفتر (`ledger.report_*`) روی `entry_date` که خودش
--    `date` است فیلتر می‌کنند و این باگ را هرگز نداشتند.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. آغاز یک روز کاری، به‌عنوان یک لحظه
-- ---------------------------------------------------------------------
-- عکسِ `platform.business_date()`. هر جا بازه‌ای از تاریخ‌ها روی یک
-- ستون `timestamptz` اعمال می‌شود، مرزش باید از اینجا بیاید — وگرنه
-- منطقه زمانی سرور بی‌صدا تصمیم می‌گیرد.

CREATE OR REPLACE FUNCTION platform.business_day_start(p_day date)
RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT p_day::timestamp AT TIME ZONE
         platform.setting_text('platform.timezone', 'Asia/Tehran');
$$;

COMMENT ON FUNCTION platform.business_day_start IS
  'لحظه آغاز یک روز کاری در منطقه زمانی کسب‌وکار. مرز بازه هر گزارشی که روی timestamptz فیلتر می‌کند باید از اینجا بیاید.';

-- ---------------------------------------------------------------------
-- ۲. چهار گزارشی که روی timestamptz فیلتر می‌کنند
-- ---------------------------------------------------------------------
-- بدنه‌ها عیناً از ۰۳۵ آمده‌اند؛ تنها تفاوت، همان دو مرز بازه است.

CREATE OR REPLACE FUNCTION sales.report_summary(
  p_from date, p_to date, p_branch uuid DEFAULT NULL
) RETURNS TABLE (
  business_date  date,
  channel        text,
  invoice_count  bigint,
  gross_amount   platform.money,
  discount_amount platform.money,
  net_amount     platform.money,
  return_count   bigint,
  return_amount  platform.money,
  cogs_amount    platform.money,
  profit_amount  platform.money
) LANGUAGE sql STABLE AS $$
  WITH inv AS (
    SELECT platform.business_date(i.occurred_at) AS d,
           i.channel,
           count(*)                AS n,
           sum(i.gross_amount)     AS gross,
           sum(i.discount_amount)  AS disc,
           sum(i.net_amount)       AS net,
           sum(i.cogs_amount)      AS cogs
      FROM sales.invoice i
     WHERE i.status IN ('finalized','paid','partially_returned','returned')
       AND i.occurred_at >= platform.business_day_start(p_from)
       AND i.occurred_at <  platform.business_day_start(p_to + 1)
       AND (p_branch IS NULL OR i.branch_id = p_branch)
     GROUP BY 1, 2
  ),
  ret AS (
    -- کانال مرجوعی از **فاکتور اصلی** می‌آید: برگ مرجوعی خودش کانال
    -- ندارد و بدون این Join، مرجوعیِ سفارش سایت زیر «صندوق» می‌نشست.
    SELECT platform.business_date(r.occurred_at) AS d,
           i.channel,
           count(*)             AS n,
           sum(r.net_amount)    AS amount,
           sum(r.cogs_amount)   AS cogs
      FROM sales.sale_return r
      JOIN sales.invoice i ON i.id = r.invoice_id
     WHERE r.status = 'posted'
       AND r.occurred_at >= platform.business_day_start(p_from)
       AND r.occurred_at <  platform.business_day_start(p_to + 1)
       AND (p_branch IS NULL OR r.branch_id = p_branch)
     GROUP BY 1, 2
  )
  SELECT coalesce(inv.d, ret.d),
         coalesce(inv.channel, ret.channel),
         coalesce(inv.n, 0),
         coalesce(inv.gross, 0),
         coalesce(inv.disc, 0),
         coalesce(inv.net, 0),
         coalesce(ret.n, 0),
         coalesce(ret.amount, 0),
         coalesce(inv.cogs, 0) - coalesce(ret.cogs, 0),
         (coalesce(inv.net, 0) - coalesce(ret.amount, 0))
           - (coalesce(inv.cogs, 0) - coalesce(ret.cogs, 0))
    FROM inv
    FULL JOIN ret ON ret.d = inv.d AND ret.channel = inv.channel
   ORDER BY 1 DESC, 2;
$$;

CREATE OR REPLACE FUNCTION sales.report_profit_by_product(
  p_from date, p_to date, p_branch uuid DEFAULT NULL, p_limit int DEFAULT 100
) RETURNS TABLE (
  variation_id  uuid,
  sku           text,
  product_name  text,
  color         text,
  size          text,
  qty_sold      platform.qty,
  qty_returned  platform.qty,
  net_amount    platform.money,
  cogs_amount   platform.money,
  profit_amount platform.money,
  margin_percent numeric
) LANGUAGE sql STABLE AS $$
  WITH sold AS (
    SELECT l.variation_id,
           sum(l.qty)                       AS qty,
           sum(l.returned_qty)              AS qty_ret,
           sum(l.net_amount)                AS net,
           sum(l.cogs_amount)               AS cogs
      FROM sales.invoice_line l
      JOIN sales.invoice i ON i.id = l.invoice_id
     WHERE i.status IN ('finalized','paid','partially_returned','returned')
       AND i.occurred_at >= platform.business_day_start(p_from)
       AND i.occurred_at <  platform.business_day_start(p_to + 1)
       AND (p_branch IS NULL OR i.branch_id = p_branch)
     GROUP BY l.variation_id
  ),
  returned AS (
    SELECT l.variation_id,
           sum(rl.net_amount)  AS net,
           sum(rl.cogs_amount) AS cogs
      FROM sales.sale_return_line rl
      JOIN sales.sale_return r  ON r.id = rl.return_id
      JOIN sales.invoice_line l ON l.id = rl.invoice_line_id
      JOIN sales.invoice i      ON i.id = l.invoice_id
     WHERE r.status = 'posted'
       AND i.occurred_at >= platform.business_day_start(p_from)
       AND i.occurred_at <  platform.business_day_start(p_to + 1)
       AND (p_branch IS NULL OR r.branch_id = p_branch)
     GROUP BY l.variation_id
  )
  SELECT v.id, v.sku, p.name_internal, v.color, v.size,
         s.qty, s.qty_ret,
         s.net  - coalesce(rt.net, 0),
         s.cogs - coalesce(rt.cogs, 0),
         (s.net - coalesce(rt.net, 0)) - (s.cogs - coalesce(rt.cogs, 0)),
         -- حاشیه روی **فروش** حساب می‌شود نه روی بها. صفر شدن مخرج
         -- یعنی همه‌اش برگشته؛ آن‌وقت درصد بی‌معناست و NULL می‌ماند.
         CASE WHEN (s.net - coalesce(rt.net, 0)) > 0
              THEN round(((s.net - coalesce(rt.net, 0)) - (s.cogs - coalesce(rt.cogs, 0)))
                         * 100.0 / (s.net - coalesce(rt.net, 0)), 1)
              ELSE NULL END
    FROM sold s
    JOIN catalog.variation v ON v.id = s.variation_id
    JOIN catalog.product   p ON p.id = v.product_id
    LEFT JOIN returned rt ON rt.variation_id = s.variation_id
   ORDER BY 11 DESC NULLS LAST
   LIMIT p_limit;
$$;

CREATE OR REPLACE FUNCTION inventory.report_movements(
  p_variation uuid, p_from date, p_to date, p_warehouse uuid DEFAULT NULL
) RETURNS TABLE (
  occurred_at    timestamptz,
  warehouse_name text,
  kind           text,
  qty            platform.qty,
  unit_cost      platform.money,
  value_delta    platform.money,
  running_qty    platform.qty,
  ref_type       text,
  ref_id         uuid,
  note           text
) LANGUAGE sql STABLE AS $$
  WITH opening AS (
    -- مانده **پیش از** شروع بازه. بدون آن، کاردکس از صفر شروع
    -- می‌شد و انباردار فکر می‌کرد کالا اول ماه نبوده.
    SELECT coalesce(sum(m.qty), 0) AS qty
      FROM inventory.stock_movement m
     WHERE m.variation_id = p_variation
       AND (p_warehouse IS NULL OR m.warehouse_id = p_warehouse)
       AND m.occurred_at < platform.business_day_start(p_from)
  )
  SELECT m.occurred_at, w.name, m.kind, m.qty, m.unit_cost, m.value_delta,
         (SELECT qty FROM opening)
           + sum(m.qty) OVER (ORDER BY m.occurred_at, m.id
                              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),
         m.ref_type, m.ref_id, m.note
    FROM inventory.stock_movement m
    JOIN inventory.warehouse w ON w.id = m.warehouse_id
   WHERE m.variation_id = p_variation
     AND (p_warehouse IS NULL OR m.warehouse_id = p_warehouse)
     AND m.occurred_at >= platform.business_day_start(p_from)
     AND m.occurred_at <  platform.business_day_start(p_to + 1)
   ORDER BY m.occurred_at, m.id;
$$;

CREATE OR REPLACE FUNCTION treasury.report_cash_reconciliation(
  p_from date, p_to date, p_branch uuid DEFAULT NULL
) RETURNS TABLE (
  shift_id      uuid,
  branch_name   text,
  user_name     text,
  opened_at     timestamptz,
  closed_at     timestamptz,
  opening_cash  platform.money,
  cash_sales    platform.money,
  cash_refunds  platform.money,
  cash_in       platform.money,
  cash_out      platform.money,
  expected_cash platform.money,
  counted_cash  platform.money,
  variance      platform.money,
  status        text
) LANGUAGE sql STABLE AS $$
  SELECT s.id, b.name, u.full_name, s.opened_at, s.closed_at, s.opening_cash,
         -- فروش نقدی و بازپرداخت نقدی، هر دو از `treasury.payment`
         -- با همان `shift_id` که `close_shift` می‌خواند.
         coalesce((SELECT sum(p.amount) FROM treasury.payment p
                    WHERE p.shift_id = s.id AND p.direction = 'in'
                      AND p.status = 'succeeded' AND p.method_code = 'cash'), 0),
         coalesce((SELECT sum(p.amount) FROM treasury.payment p
                    WHERE p.shift_id = s.id AND p.direction = 'out'
                      AND p.status = 'succeeded' AND p.method_code = 'cash'), 0),
         -- حرکت نقد غیرفروشی: ورود به صندوق و خروج از آن.
         coalesce((SELECT sum(t.amount) FROM treasury.transaction t
                    JOIN treasury.account a ON a.id = t.to_account_id
                   WHERE t.shift_id = s.id AND t.status = 'posted'
                     AND a.kind = 'cash_box'), 0),
         coalesce((SELECT sum(t.amount) FROM treasury.transaction t
                    JOIN treasury.account a ON a.id = t.from_account_id
                   WHERE t.shift_id = s.id AND t.status = 'posted'
                     AND a.kind = 'cash_box'), 0),
         s.expected_cash, s.counted_cash, s.variance, s.status
    FROM sales.cash_shift s
    JOIN platform.branch     b ON b.id = s.branch_id
    JOIN identity.app_user   u ON u.id = s.user_id
   WHERE s.opened_at >= platform.business_day_start(p_from)
     AND s.opened_at <  platform.business_day_start(p_to + 1)
     AND (p_branch IS NULL OR s.branch_id = p_branch)
   ORDER BY s.opened_at DESC;
$$;

COMMIT;
