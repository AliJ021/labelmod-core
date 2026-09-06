-- =====================================================================
-- ۰۴۱ — پنل مدیریتی: ساعت، مقایسه دوره، و تحلیل سبد
-- =====================================================================
--
-- سه پرسشی که تا امروز از این سیستم پرسیدنی نبود:
--
--   «کدام ساعت روز پرفروش‌تر است؟»
--   «این ماه نسبت به ماه قبل بهتر بود یا بدتر؟»
--   «آن ده قلمی که امروز فروختیم، یک نفر برد یا ده نفر؟»
--
-- هر سه از همان منبعی می‌آیند که `sales.report_summary` می‌آید — یعنی
-- `sales.invoice` و `sales.sale_return` با همان چهار وضعیت واقعی — پس
-- جمعشان با گزارش فروش و با دفتر می‌خواند. عددی که فقط تست خودش
-- حسابش کرده باشد، هیچ‌چیز را اثبات نمی‌کند.
-- =====================================================================


-- ---------------------------------------------------------------------
-- ۱. ساعتِ کاری — مثل `business_date`، فقط یک پله ریزتر
-- ---------------------------------------------------------------------
-- `extract(hour from x)` روی یک `timestamptz` ساعت را از منطقه زمانی
-- **سرور** می‌گیرد، و سرور تولید UTC است. یعنی همان کلاس باگی که
-- مهاجرت‌های ۰۱۴، ۰۲۳، ۰۳۸ و ۰۳۹ چهار بار بستندش — این بار روی ساعت
-- به‌جای تاریخ، و بدتر: خطای تاریخ فقط بین ۰۰:۰۰ تا ۰۳:۳۰ دیده می‌شد،
-- ولی خطای ساعت **هر ساعتِ شبانه‌روز** را ۳ ساعت و نیم جابه‌جا می‌کند.
-- نمودار «شلوغ‌ترین ساعت فروشگاه» آن‌وقت ساعتی را نشان می‌دهد که
-- فروشگاه اصلاً باز نبوده.
--
-- پس یک تعریف، کنار همان تعریفی که «امروز» از آن می‌آید.

CREATE OR REPLACE FUNCTION platform.business_hour(p_at timestamptz DEFAULT now())
RETURNS smallint LANGUAGE sql STABLE AS $$
  SELECT extract(hour FROM
           (p_at AT TIME ZONE platform.setting_text('platform.timezone', 'Asia/Tehran'))
         )::smallint;
$$;
COMMENT ON FUNCTION platform.business_hour IS
  'ساعت (۰ تا ۲۳) در منطقه زمانی کسب‌وکار. همان قاعده platform.business_date، یک پله ریزتر.';


-- ---------------------------------------------------------------------
-- ۲. فروش به تفکیک ساعت
-- ---------------------------------------------------------------------
-- مرجوعی اینجا **کم نمی‌شود** و این عمدی است: پرسش این گزارش «چه
-- ساعتی شلوغ است؟» است، نه «چقدر سود کردیم؟». مرجوعیِ ساعت ۱۱ که
-- مربوط به فروشِ سه روز پیش است، شلوغی ساعت ۱۱ را کم نشان می‌داد.
-- سود و مرجوعی جای خودشان را دارند: `sales.report_summary`.

CREATE OR REPLACE FUNCTION sales.report_hourly(
  p_from date, p_to date, p_branch uuid DEFAULT NULL
) RETURNS TABLE (
  business_date  date,
  hour_of_day    smallint,
  channel        text,
  invoice_count  bigint,
  item_qty       platform.qty,
  net_amount     platform.money
) LANGUAGE sql STABLE AS $$
  SELECT platform.business_date(i.occurred_at),
         platform.business_hour(i.occurred_at),
         i.channel,
         count(*),
         coalesce(sum(l.qty), 0),
         sum(i.net_amount)
    FROM sales.invoice i
    LEFT JOIN LATERAL (
      SELECT sum(x.qty) AS qty FROM sales.invoice_line x WHERE x.invoice_id = i.id
    ) l ON true
   WHERE i.status IN ('finalized','paid','partially_returned','returned')
     AND i.occurred_at >= platform.business_day_start(p_from)
     AND i.occurred_at <  platform.business_day_start(p_to + 1)
     AND (p_branch IS NULL OR i.branch_id = p_branch)
   GROUP BY 1, 2, 3
   ORDER BY 1 DESC, 2, 3;
$$;
COMMENT ON FUNCTION sales.report_hourly IS
  'فروش به تفکیک روز، ساعتِ کاری و کانال. مرجوعی کم نمی‌شود — پرسش این گزارش شلوغی است، نه سود.';


-- ---------------------------------------------------------------------
-- ۳. مقایسه دو دوره
-- ---------------------------------------------------------------------
-- ⚠️ دوره مبنا **پارامتر است، نه محاسبه**. وسوسه‌اش این بود که داخل
-- تابع بنویسیم `p_from - interval '1 month'` و تمام. ولی این فروشگاه
-- تاریخ را **جلالی** می‌بیند (رابط کاربری با `Intl` فارسی‌اش می‌کند) و
-- «یک ماه قبلِ» میلادی با «ماه قبلِ» شمسی یکی نیست: ۳۱ مرداد منهای یک
-- ماه میلادی، وسط تیر می‌افتد. مالک عددی می‌دید که با تقویم خودش
-- نمی‌خواند و هیچ خطایی هم نمی‌گرفت.
--
-- پس انتخاب دوره بالادست انجام می‌شود و اینجا فقط جمع مالی. همان
-- تفکیکی که کل پروژه دارد: محاسبه پول در SQL، انتخاب دوره در جایی که
-- تقویم را می‌فهمد.
--
-- `direction` در خودِ SQL حساب می‌شود نه در کلاینت، چون آستانه‌اش یک
-- تصمیم است: صفر در برابر صفر «بدون تغییر» است، نه «رشد بی‌نهایت».

CREATE OR REPLACE FUNCTION sales.report_compare(
  p_from date, p_to date,
  p_prev_from date, p_prev_to date,
  p_branch uuid DEFAULT NULL
) RETURNS TABLE (
  channel          text,
  invoice_count    bigint,
  net_amount       platform.money,
  profit_amount    platform.money,
  prev_invoice_count bigint,
  prev_net_amount  platform.money,
  prev_profit_amount platform.money,
  delta_amount     platform.money,
  delta_percent    numeric,
  direction        text
) LANGUAGE sql STABLE AS $$
  WITH cur AS (
    SELECT s.channel,
           sum(s.invoice_count) AS n,
           sum(s.net_amount - s.return_amount) AS net,
           sum(s.profit_amount) AS profit
      FROM sales.report_summary(p_from, p_to, p_branch) s
     GROUP BY 1
  ),
  prv AS (
    SELECT s.channel,
           sum(s.invoice_count) AS n,
           sum(s.net_amount - s.return_amount) AS net,
           sum(s.profit_amount) AS profit
      FROM sales.report_summary(p_prev_from, p_prev_to, p_branch) s
     GROUP BY 1
  )
  SELECT coalesce(cur.channel, prv.channel),
         coalesce(cur.n, 0),
         coalesce(cur.net, 0),
         coalesce(cur.profit, 0),
         coalesce(prv.n, 0),
         coalesce(prv.net, 0),
         coalesce(prv.profit, 0),
         coalesce(cur.net, 0) - coalesce(prv.net, 0),
         -- درصد فقط وقتی معنا دارد که مبنا صفر نباشد. «از صفر به صد»
         -- رشدِ بی‌نهایت‌درصدی نیست؛ NULL است و صفحه باید «—» نشان دهد.
         CASE WHEN coalesce(prv.net, 0) = 0 THEN NULL
              ELSE round(
                     (coalesce(cur.net, 0) - prv.net)::numeric * 100 / prv.net,
                     1)
         END,
         CASE WHEN coalesce(cur.net, 0) > coalesce(prv.net, 0) THEN 'up'
              WHEN coalesce(cur.net, 0) < coalesce(prv.net, 0) THEN 'down'
              ELSE 'flat'
         END
    FROM cur
    FULL JOIN prv ON prv.channel = cur.channel
   ORDER BY 1;
$$;
COMMENT ON FUNCTION sales.report_compare IS
  'مقایسه دو دوره به تفکیک کانال. دوره مبنا پارامتر است، نه محاسبه — تقویم جلالی با حساب ماه میلادی نمی‌خواند.';


-- ---------------------------------------------------------------------
-- ۴. تحلیل سبد — «ده قلم را یک نفر برد یا ده نفر؟»
-- ---------------------------------------------------------------------
-- پرسشی که فقط با جمع فروش جواب ندارد. دو روزِ یک‌میلیونی می‌توانند
-- کاملاً متفاوت باشند: یکی ده مشتریِ تک‌قلمی، دیگری یک مشتری با ده
-- قلم. اولی یعنی ویترین کار می‌کند، دومی یعنی یک خریدِ خاص.
--
-- ⚠️ فاکتور بی‌مشتری **جدا شمرده می‌شود**، نه اینکه یک مشتری ناشناس
-- فرض شود. شماره مشتری پای صندوق اختیاری است؛ اگر پنج فاکتور بی‌شماره
-- را «یک نفر» بشماریم، عددِ «مشتری یکتا» دروغ می‌شود. و اگر «پنج نفر»
-- بشماریم هم دروغ است. پس شمرده نمی‌شوند و ستون خودشان را دارند.

CREATE OR REPLACE FUNCTION sales.report_basket(
  p_from date, p_to date, p_branch uuid DEFAULT NULL
) RETURNS TABLE (
  business_date     date,
  channel           text,
  invoice_count     bigint,
  known_customers   bigint,
  anonymous_count   bigint,
  item_qty          platform.qty,
  line_count        bigint,
  net_amount        platform.money,
  qty_per_invoice   numeric
) LANGUAGE sql STABLE AS $$
  WITH inv AS (
    SELECT platform.business_date(i.occurred_at) AS d,
           i.channel,
           i.id,
           i.customer_id,
           i.net_amount,
           (SELECT coalesce(sum(x.qty), 0) FROM sales.invoice_line x
             WHERE x.invoice_id = i.id) AS qty,
           (SELECT count(*) FROM sales.invoice_line x
             WHERE x.invoice_id = i.id) AS lines
      FROM sales.invoice i
     WHERE i.status IN ('finalized','paid','partially_returned','returned')
       AND i.occurred_at >= platform.business_day_start(p_from)
       AND i.occurred_at <  platform.business_day_start(p_to + 1)
       AND (p_branch IS NULL OR i.branch_id = p_branch)
  )
  SELECT d,
         channel,
         count(*),
         count(DISTINCT customer_id),
         count(*) FILTER (WHERE customer_id IS NULL),
         coalesce(sum(qty), 0),
         coalesce(sum(lines), 0),
         coalesce(sum(net_amount), 0),
         CASE WHEN count(*) = 0 THEN 0
              ELSE round(coalesce(sum(qty), 0) / count(*), 2) END
    FROM inv
   GROUP BY 1, 2
   ORDER BY 1 DESC, 2;
$$;
COMMENT ON FUNCTION sales.report_basket IS
  'تعداد فاکتور، مشتری یکتا، فاکتور بی‌شماره و اقلام هر روز و کانال. فاکتور بی‌مشتری جدا شمرده می‌شود، نه یک نفر فرض.';


-- ---------------------------------------------------------------------
-- ۵. همان پرسش، در سطح شخص
-- ---------------------------------------------------------------------
-- وقتی ستون «مشتری یکتا» عدد عجیبی نشان داد، این گزارش می‌گوید کدام
-- شخص بوده. فاکتور بی‌شماره اینجا **نمی‌آید** — چیزی برای نشان دادن
-- ندارد و آوردنش فقط فهرست را با سطرهای بی‌نام پر می‌کرد.

CREATE OR REPLACE FUNCTION sales.report_customer_basket(
  p_from date, p_to date, p_branch uuid DEFAULT NULL, p_limit int DEFAULT 100
) RETURNS TABLE (
  customer_id    uuid,
  full_name      text,
  mobile         text,
  invoice_count  bigint,
  item_qty       platform.qty,
  net_amount     platform.money,
  last_purchase  date
) LANGUAGE sql STABLE AS $$
  -- ⚠️ تعداد اقلام در یک زیرپرس‌وجوی هم‌بسته حساب می‌شود، نه با
  -- `JOIN invoice_line`. آن Join هر فاکتور را به تعداد سطرهایش تکرار
  -- می‌کند و `sum(net_amount)` مبلغ را چند برابر می‌نویسد — یک عدد
  -- مالی که بزرگ‌تر از واقعیت است و هیچ خطایی نمی‌دهد.
  WITH inv AS (
    SELECT i.customer_id,
           i.id,
           i.net_amount,
           platform.business_date(i.occurred_at) AS d,
           (SELECT coalesce(sum(x.qty), 0) FROM sales.invoice_line x
             WHERE x.invoice_id = i.id) AS qty
      FROM sales.invoice i
     WHERE i.status IN ('finalized','paid','partially_returned','returned')
       AND i.customer_id IS NOT NULL
       AND i.occurred_at >= platform.business_day_start(p_from)
       AND i.occurred_at <  platform.business_day_start(p_to + 1)
       AND (p_branch IS NULL OR i.branch_id = p_branch)
  )
  SELECT c.id,
         c.full_name,
         c.mobile_normalized,
         count(*),
         coalesce(sum(inv.qty), 0),
         coalesce(sum(inv.net_amount), 0),
         max(inv.d)
    FROM inv
    JOIN sales.customer c ON c.id = inv.customer_id
   GROUP BY c.id, c.full_name, c.mobile_normalized
   ORDER BY 6 DESC
   LIMIT p_limit;
$$;
COMMENT ON FUNCTION sales.report_customer_basket IS
  'خرید هر مشتری در یک بازه — تعداد فاکتور، اقلام و مبلغ. فاکتور بی‌شماره نمی‌آید؛ چیزی برای نشان دادن ندارد.';
