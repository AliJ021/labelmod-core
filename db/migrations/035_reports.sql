-- =====================================================================
-- ۰۳۵ — گزارش‌ها: هشت پرسشی که مالک هر ماه می‌پرسد
-- =====================================================================
-- تا امروز داده همه‌اش بود و هیچ راهی برای **پرسیدن** از آن نبود جز
-- psql. یعنی سیستمی که سود را دقیق نگه می‌دارد، سود را نشان نمی‌داد.
--
-- ── چرا تابع، نه View ────────────────────────────────────────────
--
-- هر گزارش مالی سه پارامتر دارد که بی‌آن‌ها بی‌معناست: **از کی، تا
-- کی، کدام شعبه**. یک View بدون پارامتر یا کل تاریخ را جمع می‌زند
-- (که هیچ‌کس نمی‌خواهد) یا فیلترش به لایه فراخوان می‌افتد — و آن‌وقت
-- هر مسیر تازه‌ای می‌تواند فیلتر شعبه را فراموش کند و داده شعبه دیگر
-- را نشان دهد.
--
-- `ledger.trial_balance` (مهاجرت ۰۰۲) همین مشکل را دارد: کل تاریخ.
-- برای تراز پایان دوره لازم است، ولی «تراز آبان» را نمی‌دهد. اینجا
-- نسخه پارامتری‌اش می‌آید و آن View دست‌نخورده می‌ماند — گزارش‌های
-- موجود و تست‌هایشان نباید بشکنند.
--
-- ── سه قاعده مشترک هر هشت تابع ───────────────────────────────────
--
-- **بازه شامل هر دو سر است.** `[from, to]` نه `[from, to)`. کاربری
-- که «۱ تا ۳۰ آبان» می‌خواهد، ۳۰ آبان را هم می‌خواهد. تبدیل به بازه
-- زمانی با `< to + 1 day` انجام می‌شود تا ساعت‌های همان روز جا نیفتند.
--
-- **`p_branch IS NULL` یعنی «همه شعبه‌ها»** — و دامنه کاربر را لایه
-- API اعمال می‌کند، نه اینجا. دیتابیس نمی‌داند کدام کاربر به کدام
-- شعبه دسترسی دارد؛ همان جدایی که در `treasury-routes.ts` هست.
--
-- **فقط سند و فاکتور واقعی.** فاکتور `cancelled` و سند `draft` در
-- هیچ گزارشی نمی‌آیند. اگر بیایند، گزارش با دفتر یکی درنمی‌آید و
-- کسی نمی‌فهمد کدام درست است.
--
-- ⚠️ «فاکتور واقعی» یعنی هر چهار وضعیت
--    `finalized · paid · partially_returned · returned` — همان فهرستی
--    که `sales.unposted_revenue` و `post_batch` دارند. `post_return`
--    وضعیت فاکتور را عوض می‌کند، پس فهرست دوتایی یعنی هر فاکتوری که
--    مرجوعی خورده **کاملاً** از گزارش فروش بیفتد: فروش اصلی‌اش هم
--    ناپدید شود، نه فقط بخش برگشتی. اولین اجرای تست همین را گرفت.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. فروش دوره‌ای — به تفکیک روز و کانال
-- ---------------------------------------------------------------------
-- شش عدد که هرگز زیر «دخل» جمع نمی‌شوند (قاعده زبانی design.md):
-- فروش ناخالص، تخفیف، خالص، مرجوعی، بهای تمام‌شده، سود ناخالص.
--
-- مرجوعی **در همان روزی** شمرده می‌شود که برگ مرجوعی ثبت شده، نه
-- روز فروش اصلی. دلیلش دفتر است: سند مرجوعی همان روز زده می‌شود، و
-- گزارشی که آن را به روز فروش برگرداند با دفتر یکی درنمی‌آید.

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
       AND i.occurred_at >= p_from::timestamptz
       AND i.occurred_at <  (p_to + 1)::timestamptz
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
       AND r.occurred_at >= p_from::timestamptz
       AND r.occurred_at <  (p_to + 1)::timestamptz
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

COMMENT ON FUNCTION sales.report_summary IS
  'فروش، تخفیف، مرجوعی، بهای تمام‌شده و سود ناخالص یک بازه، به تفکیک روز و کانال. مرجوعی در روز ثبتش شمرده می‌شود، نه روز فروش.';

-- ---------------------------------------------------------------------
-- ۲. سود به تفکیک کالا
-- ---------------------------------------------------------------------
-- سودِ سطر از Snapshot خودِ سطر ساخته می‌شود (`net_amount` و
-- `cogs_amount`)، نه از قیمت یا بهای امروز. همان قاعده‌ای که کل
-- `invoice_line` برایش وجود دارد.
--
-- `returned_qty` سهم برگشتی را کم می‌کند — به نسبت، چون سطر مرجوعی
-- Snapshot خودش را دارد ولی به تعداد جزئی هم ممکن است برگردد.

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
       AND i.occurred_at >= p_from::timestamptz
       AND i.occurred_at <  (p_to + 1)::timestamptz
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
       AND i.occurred_at >= p_from::timestamptz
       AND i.occurred_at <  (p_to + 1)::timestamptz
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

COMMENT ON FUNCTION sales.report_profit_by_product IS
  'سود هر تنوع در یک بازه، از Snapshot سطر فاکتور. برگشتی کم می‌شود و حاشیه روی فروش خالص حساب می‌شود.';

-- ---------------------------------------------------------------------
-- ۳. ارزش‌گذاری موجودی
-- ---------------------------------------------------------------------
-- **از `stock_balance` می‌آید، نه از جمع حرکت‌ها.** آن جدول را فقط
-- `apply_movement` می‌نویسد و `inventory.balance_check` هم‌خوانی‌اش با
-- حرکت‌ها را می‌سنجد. جمع دوباره در گزارش یعنی یک مرجع دوم که روزی
-- از اولی جدا می‌افتد.

CREATE OR REPLACE FUNCTION inventory.report_valuation(
  p_warehouse uuid DEFAULT NULL
) RETURNS TABLE (
  warehouse_id   uuid,
  warehouse_name text,
  variation_id   uuid,
  sku            text,
  product_name   text,
  color          text,
  size           text,
  on_hand        platform.qty,
  total_value    platform.money,
  unit_cost      platform.money
) LANGUAGE sql STABLE AS $$
  SELECT w.id, w.name, v.id, v.sku, p.name_internal, v.color, v.size,
         b.on_hand, b.total_value,
         -- بهای واحد **مشتق** است، نه ذخیره‌شده. تقسیم بر صفر یعنی
         -- موجودی صفر با ارزش صفر — آن‌وقت بهای واحد بی‌معناست.
         CASE WHEN b.on_hand > 0 THEN round(b.total_value / b.on_hand) ELSE NULL END
    FROM inventory.stock_balance b
    JOIN inventory.warehouse w ON w.id = b.warehouse_id
    JOIN catalog.variation   v ON v.id = b.variation_id
    JOIN catalog.product     p ON p.id = v.product_id
   WHERE (p_warehouse IS NULL OR b.warehouse_id = p_warehouse)
     AND (b.on_hand <> 0 OR b.total_value <> 0)
   ORDER BY w.name, p.name_internal, v.color, v.size;
$$;

COMMENT ON FUNCTION inventory.report_valuation IS
  'موجودی و ارزش دفتری هر تنوع در هر انبار، از stock_balance. بهای واحد مشتق است و برای موجودی صفر NULL می‌ماند.';

-- ---------------------------------------------------------------------
-- ۴. گردش انبار — کاردکس یک کالا
-- ---------------------------------------------------------------------
-- مانده تجمعی با `sum() OVER` ساخته می‌شود، نه در لایه فراخوان: اگر
-- صفحه‌بندی یا مرتب‌سازی عوض شود، مانده‌ای که در TypeScript جمع شده
-- بی‌صدا غلط می‌شود.

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
       AND m.occurred_at < p_from::timestamptz
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
     AND m.occurred_at >= p_from::timestamptz
     AND m.occurred_at <  (p_to + 1)::timestamptz
   ORDER BY m.occurred_at, m.id;
$$;

COMMENT ON FUNCTION inventory.report_movements IS
  'کاردکس یک تنوع در یک بازه، با مانده اول دوره و مانده تجمعی — هر دو در SQL.';

-- ---------------------------------------------------------------------
-- ۵. دفتر یک حساب
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ledger.report_account_ledger(
  p_code text, p_from date, p_to date, p_branch uuid DEFAULT NULL
) RETURNS TABLE (
  entry_date   date,
  entry_number text,
  description  text,
  party_name   text,
  debit        platform.money,
  credit       platform.money,
  running      platform.money
) LANGUAGE sql STABLE AS $$
  WITH opening AS (
    SELECT coalesce(sum(l.debit - l.credit), 0) AS bal
      FROM ledger.journal_line l
      JOIN ledger.journal_entry e ON e.id = l.entry_id
     WHERE l.account_code = p_code
       AND e.status IN ('confirmed','final')
       AND e.entry_date < p_from
       AND (p_branch IS NULL OR e.branch_id = p_branch)
  )
  SELECT e.entry_date, e.number,
         coalesce(l.description, e.description),
         coalesce(c.full_name, s.name),
         l.debit, l.credit,
         -- مانده تجمعی **با ماهیت حساب** معنا پیدا نمی‌کند اینجا:
         -- عمداً «بدهکار منهای بستانکار» می‌ماند تا با ستون مانده در
         -- `trial_balance` یکی باشد. تبدیلش به ماهیت، کار نمایش است.
         (SELECT bal FROM opening)
           + sum(l.debit - l.credit) OVER (ORDER BY e.entry_date, e.number, l.line_no
                                           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
    FROM ledger.journal_line l
    JOIN ledger.journal_entry e ON e.id = l.entry_id
    LEFT JOIN sales.customer      c ON l.party_type = 'customer' AND c.id = l.party_id
    LEFT JOIN purchasing.supplier s ON l.party_type = 'supplier' AND s.id = l.party_id
   WHERE l.account_code = p_code
     AND e.status IN ('confirmed','final')
     AND e.entry_date >= p_from AND e.entry_date <= p_to
     AND (p_branch IS NULL OR e.branch_id = p_branch)
   ORDER BY e.entry_date, e.number, l.line_no;
$$;

COMMENT ON FUNCTION ledger.report_account_ledger IS
  'گردش یک حساب در یک بازه، با مانده اول دوره و مانده تجمعی. فقط سند confirmed و final.';

-- ---------------------------------------------------------------------
-- ۶. تراز آزمایشی دوره‌ای
-- ---------------------------------------------------------------------
-- `ledger.trial_balance` (۰۰۲) کل تاریخ را می‌دهد و دست‌نخورده
-- می‌ماند. این نسخه بازه می‌گیرد و مانده اول دوره را جدا نشان می‌دهد
-- — بدون آن، «تراز آبان» ستون مانده‌اش با ترازنامه یکی درنمی‌آمد.

CREATE OR REPLACE FUNCTION ledger.report_trial_balance(
  p_from date, p_to date, p_branch uuid DEFAULT NULL
) RETURNS TABLE (
  code            text,
  name            text,
  account_type    text,
  opening_balance platform.money,
  debit           platform.money,
  credit          platform.money,
  closing_balance platform.money
) LANGUAGE sql STABLE AS $$
  WITH opening AS (
    SELECT l.account_code, sum(l.debit - l.credit) AS bal
      FROM ledger.journal_line l
      JOIN ledger.journal_entry e ON e.id = l.entry_id
     WHERE e.status IN ('confirmed','final')
       AND e.entry_date < p_from
       AND (p_branch IS NULL OR e.branch_id = p_branch)
     GROUP BY l.account_code
  ),
  period AS (
    SELECT l.account_code, sum(l.debit) AS dr, sum(l.credit) AS cr
      FROM ledger.journal_line l
      JOIN ledger.journal_entry e ON e.id = l.entry_id
     WHERE e.status IN ('confirmed','final')
       AND e.entry_date >= p_from AND e.entry_date <= p_to
       AND (p_branch IS NULL OR e.branch_id = p_branch)
     GROUP BY l.account_code
  )
  SELECT a.code, a.name, a.type,
         coalesce(o.bal, 0), coalesce(p.dr, 0), coalesce(p.cr, 0),
         coalesce(o.bal, 0) + coalesce(p.dr, 0) - coalesce(p.cr, 0)
    FROM ledger.account a
    LEFT JOIN opening o ON o.account_code = a.code
    LEFT JOIN period  p ON p.account_code = a.code
   WHERE coalesce(o.bal, 0) <> 0 OR coalesce(p.dr, 0) <> 0 OR coalesce(p.cr, 0) <> 0
   ORDER BY a.code;
$$;

COMMENT ON FUNCTION ledger.report_trial_balance IS
  'تراز آزمایشی یک بازه با مانده اول دوره. حسابی که نه مانده دارد نه گردش، نمی‌آید.';

-- ---------------------------------------------------------------------
-- ۷. دریافتنی و پرداختنی — به تفکیک شخص
-- ---------------------------------------------------------------------
-- از `ledger.party_tafsili` می‌آید که از `party_id` سند ساخته شده،
-- نه از یک جدول موازی. قاعده «هر سطر دریافتنی و بدهی تأمین‌کننده
-- `party_id` دارد» دقیقاً برای همین بود.

CREATE OR REPLACE FUNCTION ledger.report_party_balances(
  p_party_type text DEFAULT NULL
) RETURNS TABLE (
  party_type  text,
  party_id    uuid,
  party_name  text,
  code        text,
  parent_name text,
  debit       platform.money,
  credit      platform.money,
  balance     platform.money
) LANGUAGE sql STABLE AS $$
  SELECT t.party_type, t.party_id, t.party_name, t.code, t.parent_name,
         t.debit, t.credit, t.balance
    FROM ledger.party_tafsili t
   WHERE (p_party_type IS NULL OR t.party_type = p_party_type)
     AND t.balance <> 0
   ORDER BY t.balance DESC;
$$;

COMMENT ON FUNCTION ledger.report_party_balances IS
  'مانده دریافتنی و پرداختنی هر شخص، از تفصیلی سند. مانده صفر نمی‌آید.';

-- ---------------------------------------------------------------------
-- ۸. مغایرت‌گیری نقد — شیفت به شیفت
-- ---------------------------------------------------------------------
-- «چقدر باید در کشو باشد» را `close_shift` حساب کرده و در
-- `expected_cash` نوشته. این گزارش آن را دوباره حساب **نمی‌کند** —
-- دو محاسبه از یک عدد یعنی روزی یکی‌شان غلط می‌شود و هیچ‌کس نمی‌فهمد
-- کدام. فقط نشانش می‌دهد، کنار اجزایش.

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
   WHERE s.opened_at >= p_from::timestamptz
     AND s.opened_at <  (p_to + 1)::timestamptz
     AND (p_branch IS NULL OR s.branch_id = p_branch)
   ORDER BY s.opened_at DESC;
$$;

COMMENT ON FUNCTION treasury.report_cash_reconciliation IS
  'شمارش کشو در برابر آنچه باید باشد، شیفت به شیفت. عدد انتظار دوباره حساب نمی‌شود — همان است که close_shift نوشته.';

COMMIT;
