-- =====================================================================
-- ۱۱۲ — «اثر ثبت‌نشده» روی طلب مشتری (تصمیم مالک، ۲۰۲۶/۱۱/۰۷)
-- =====================================================================
-- طلب مشتری در فهرست مشتریان از سند ثبت‌شده می‌آید. فروشی که دوره ثبتش
-- (شیفت یا روز کانال) هنوز بسته نشده، در دفتر نیست؛ پس نسیهٔ امروز در
-- ستون «طلب» دیده نمی‌شود تا شب.
--
-- این تابع **پیش‌نمایش** همان عددی است که بستن دوره به طلب هر مشتری
-- می‌زند — نه تعریف تازه. برای هر فاکتور واقعیِ دورهٔ ثبت‌نشده، دقیقاً
-- عبارت `per_invoice.due` تابع `sales.post_batch` (۰۸۵):
--
--   payable_amount
--     − جمع پرداخت‌ها (روش غیر از credit؛ وضعیت succeeded/settled/
--       reconciled/pending/unknown؛ ورودی مثبت، خروجی منفی)
--     − sales.exchange_in(فاکتور)
--
-- و جمع آن به‌ازای (شعبه، مشتری). مثبت یعنی طلب زیاد می‌شود، منفی کم.
--
-- ⚠️ دریافت از مشتری بابت فاکتورهای قبلی اینجا نیست و نباید باشد: آن
--    پول از مسیر `treasury.transaction` (customer_receipt) همان لحظه سند
--    می‌خورد و در «طلب» ثبت‌شده هست؛ روی فاکتور غیرپیش‌نویس هم دریافت
--    تازه پذیرفته نمی‌شود (۰۶۸).
-- ⚠️ فروش بی‌مشتری طلبی نمی‌سازد (post_batch آن را رد می‌کند) و اینجا
--    کنار گذاشته می‌شود.
-- ⚠️ `post_batch` بازنویسی نمی‌شود؛ `db/test/unposted-receivable.sql`
--    پیش از بستن، این پیش‌نمایش را می‌گیرد و پس از `post_batch` ادعا
--    می‌کند سطر طلب همان مشتری در سند دقیقاً همین عدد است.
--
-- بدون جدول، بدون تغییر داده، بدون `SECURITY DEFINER`.
-- =====================================================================

BEGIN;

CREATE FUNCTION sales.unposted_receivable()
RETURNS TABLE (branch_id uuid, customer_id uuid, amount platform.money, invoice_count bigint)
LANGUAGE sql STABLE
SET search_path = pg_catalog AS $$
  WITH per_invoice AS (
    SELECT i.branch_id, i.customer_id,
           i.payable_amount - coalesce((
             SELECT sum(CASE WHEN p.direction = 'in' THEN p.amount ELSE -p.amount END)
               FROM treasury.payment p
               JOIN treasury.payment_method m ON m.code = p.method_code
              WHERE p.invoice_id = i.id
                AND m.kind <> 'credit'
                AND p.status IN ('succeeded', 'settled', 'reconciled', 'pending', 'unknown')
           ), 0) - sales.exchange_in(i.id) AS due
      FROM sales.invoice i
      LEFT JOIN ledger.posting_batch b ON b.id = i.posting_batch_id
     WHERE i.status IN ('finalized', 'paid', 'partially_returned', 'returned')
       AND i.customer_id IS NOT NULL
       AND (b.id IS NULL OR b.status <> 'posted')
  )
  SELECT branch_id, customer_id, sum(due)::platform.money, count(*)
    FROM per_invoice
   GROUP BY branch_id, customer_id
  HAVING sum(due) <> 0;
$$;
COMMENT ON FUNCTION sales.unposted_receivable IS
  'پیش‌نمایش سطر طلب (receivable) سند فروش دوره‌های ثبت‌نشده به‌ازای (شعبه، مشتری) — همان per_invoice.due تابع sales.post_batch. موقت؛ با طلب ثبت‌شده جمع نمی‌شود.';

COMMIT;
