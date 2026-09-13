-- =====================================================================
-- ۰۵۳ — نگاشت حساب از مسیر محصول عوض می‌شود، نه با psql
-- =====================================================================
-- `CLAUDE.md` از روز اول می‌گوید «کدینگ حساب و نگاشتش داده‌اند، نه کد —
-- تغییرشان `UPDATE` است نه Deploy». نیمهٔ اولش درست بود:
-- `ledger.account` مسیر API و صفحهٔ «کدینگ حساب» داشت.
--
-- نیمهٔ دومش نداشت. `ledger.posting_rule` — همان جدولی که می‌گوید
-- **درآمد فروش به کدام حساب بخورد و بهای تمام‌شده به کدام** — هیچ مسیری
-- نداشت. یعنی حسابدار می‌توانست حساب ۴۱۰۲ را بسازد ولی نمی‌توانست
-- بگوید «تخفیف را به آن بزن»؛ آن یک `UPDATE` دستی در psql بود:
--
--   • بی هیچ ردّ حسابرسی — هیچ‌کس فردا نمی‌فهمید چه کسی و چرا عوضش کرد
--   • بی هیچ نگهبانی — `account_code` فقط FK به `ledger.account` دارد،
--     پس «درآمد فروش» را می‌شد به یک حساب **دارایی** نگاشت و ترازنامه
--     بی‌صدا غلط می‌شد. سند همچنان متوازن بود (بند ۵۵ الحاقیه: توازن ≠
--     صحت معنایی).
--   • و روی حسابی **غیرقابل ثبت** یا **غیرفعال** هم می‌نشست، که یعنی
--     اولین فروشِ بعدی با خطا رد می‌شد — نه در لحظهٔ تغییر، بلکه ساعت‌ها
--     بعد پای صندوق.
--
-- ── سه چیزی که این تابع عوض نمی‌کند، و چرا ──────────────────────────
--
-- `event_type`، `leg` و `side` **قرارداد کد**اند نه تصمیم حسابدار:
-- `sales.post_batch()` مؤلفهٔ `sales` را به نام می‌خواند. عوض‌کردنشان از
-- UI یعنی سندی که یک سمتش گم می‌شود. پس کلید قاعده فقط **پیدا** می‌شود؛
-- تنها چیزی که نوشته می‌شود `account_code` است.
--
-- `allow_account_override` هم اینجا نیست: قاعدهٔ `CLAUDE.md` می‌گوید
-- درآمد، تخفیف، مالیات، بهای تمام‌شده و موجودی کالا هرگز روشن نمی‌شوند.
-- روشن‌کردنش از UI یعنی دور زدنِ همان قاعده.
--
-- و `is_active` هم نه: غیرفعال‌کردن قاعدهٔ «فروش کالا» یعنی هر فروش
-- بعدی رد شود. آن یک تصمیم مهاجرت است، نه یک دکمه.
--
-- ⚠️ **نوع حساب باید یکی بماند.** این سخت‌گیرانه‌ترین نگهبان این مهاجرت
--    است و عمدی: «درآمد فروش» می‌تواند از ۴۱۰۱ به ۴۱۰۲ برود (هر دو
--    `revenue`)، ولی نه به ۱۳۰۱ (`asset`). تغییر نگاشت جای حساب را عوض
--    می‌کند، نه **ماهیتش**. اگر روزی حسابدار واقعاً ماهیت را عوض بخواهد،
--    آن یک مهاجرت است با فکرِ اینکه سندهای قبلی چه می‌شوند.
--
-- ⚠️ **تغییر نگاشت، تاریخ را بازنویسی نمی‌کند.** سندهای قبلی همان
--    حسابِ قبلی را دارند و همین درست است — سند مالی تغییرناپذیر است.
--    نما `entry_count` را نشان می‌دهد تا کاربر بداند چند سطر سند روی
--    حساب فعلی نشسته و انتظار نداشته باشد عوض شوند.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. نما — همان چیزی که صفحه می‌خواند
-- ---------------------------------------------------------------------
-- چرا نما و نه Join در لایه API: «کدام حساب‌ها برای این قاعده مجازند»
-- همان قاعدهٔ نوع است که تابع اجبارش می‌کند. اگر UI فهرست را خودش
-- می‌ساخت، دو تعریف از یک قاعده داشتیم و آن که در psql دور زده می‌شود
-- همان است که اهمیت دارد.

CREATE OR REPLACE VIEW ledger.posting_rule_overview AS
SELECT r.id,
       r.event_type,
       r.leg,
       r.side,
       r.account_code,
       a.name        AS account_name,
       a.type        AS account_type,
       a.nature      AS account_nature,
       a.is_active   AS account_is_active,
       a.is_postable AS account_is_postable,
       r.party_type,
       r.description,
       r.sort_order,
       r.is_active,
       r.allow_account_override,
       -- چند سطر سند روی حساب **فعلی** نشسته. «روی این قاعده» نیست و
       -- نمی‌تواند باشد: `journal_line` به `posting_rule` ارجاع نمی‌دهد
       -- و نباید بدهد — سند پس از ثبت به قاعده‌ای که ساختش وابسته
       -- نمی‌ماند. این عدد فقط می‌گوید «این حساب دست‌خورده است».
       (SELECT count(*) FROM ledger.journal_line l
         WHERE l.account_code = r.account_code) AS entry_count
  FROM ledger.posting_rule r
  JOIN ledger.account a ON a.code = r.account_code;

COMMENT ON VIEW ledger.posting_rule_overview IS
  'نگاشت حساب با نام و نوع حساب مقصد. entry_count شمار سطرهای سند روی همان حساب است، نه روی همان قاعده — سند به قاعده ارجاع نمی‌دهد.';

-- ---------------------------------------------------------------------
-- ۲. تنها مسیر نوشتن
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ledger.set_posting_rule(
  p_event_type   text,
  p_leg          text,
  p_side         text,
  p_account_code text,
  p_reason       text,
  p_user         uuid
) RETURNS ledger.posting_rule LANGUAGE plpgsql AS $$
DECLARE
  v_rule    ledger.posting_rule;
  v_old     ledger.account;
  v_new     ledger.account;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'تغییر نگاشت حساب بدون ثبت دلیل ممکن نیست';
  END IF;

  -- قفل سطر: دو تغییر هم‌زمان روی یک قاعده یعنی یکی از دو دلیل در
  -- حسابرسی بی‌اثر می‌ماند.
  SELECT * INTO v_rule FROM ledger.posting_rule
   WHERE event_type = p_event_type AND leg = p_leg AND side = p_side
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'قاعده ثبتی با این مشخصات وجود ندارد: % / % / %',
      p_event_type, p_leg, p_side;
  END IF;

  SELECT * INTO v_old FROM ledger.account WHERE code = v_rule.account_code;
  SELECT * INTO v_new FROM ledger.account WHERE code = p_account_code;

  IF NOT FOUND OR v_new.code IS NULL THEN
    RAISE EXCEPTION 'حساب % در کدینگ وجود ندارد', p_account_code;
  END IF;

  IF v_new.code = v_old.code THEN
    RAISE EXCEPTION 'حساب % همان حساب فعلی این قاعده است', p_account_code;
  END IF;

  -- حسابِ غیرقابل ثبت، سطح میانی درخت است. نگاشت رویش یعنی اولین
  -- فروشِ بعدی رد شود — ساعت‌ها بعد و پای صندوق، نه اینجا.
  IF NOT v_new.is_postable THEN
    RAISE EXCEPTION 'حساب % قابل ثبت سند نیست (سطح میانی کدینگ است)',
      p_account_code;
  END IF;

  IF NOT v_new.is_active THEN
    RAISE EXCEPTION 'حساب % غیرفعال است', p_account_code;
  END IF;

  -- سخت‌گیرانه‌ترین نگهبان، و دلیلش در سرصفحهٔ همین مهاجرت.
  IF v_new.type IS DISTINCT FROM v_old.type THEN
    RAISE EXCEPTION
      'نوع حساب باید یکی بماند: قاعده «%» روی حساب % از نوع % است و % از نوع % — تغییر نگاشت جای حساب را عوض می‌کند نه ماهیتش',
      v_rule.description, v_old.code, v_old.type, v_new.code, v_new.type;
  END IF;

  UPDATE ledger.posting_rule
     SET account_code = p_account_code
   WHERE id = v_rule.id
   RETURNING * INTO v_rule;

  PERFORM platform.audit(
    'ledger.set_posting_rule',
    'posting_rule',
    v_rule.id::text,
    jsonb_build_object('account_code', v_new.code, 'account_name', v_new.name),
    p_user,
    p_reason,
    jsonb_build_object('account_code', v_old.code, 'account_name', v_old.name));

  RETURN v_rule;
END $$;

COMMENT ON FUNCTION ledger.set_posting_rule IS
  'تنها مسیر تغییر نگاشت حساب. کلید قاعده (رویداد، مؤلفه، سمت) فقط پیدا می‌شود؛ تنها account_code نوشته می‌شود و نوع حساب باید یکی بماند. دلیل اجباری است و در audit_log با مقدار پیش و پس می‌نشیند.';

COMMIT;
