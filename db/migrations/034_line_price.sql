-- =====================================================================
-- ۰۳۴ — قیمت دستی روی سطری که همین حالا در سبد است
-- =====================================================================
-- مهاجرت ۰۱۰ قیمت دستی را در لحظه **افزودن** قلم ممکن کرد. صندوق‌داری
-- که کالا را اسکن کرده و بعد می‌خواهد قیمتش را عوض کند — همان کاری که
-- «دشت» با F-کلید می‌کند — تنها یک راه داشت: حذف سطر و افزودن دوباره.
--
-- همان راهی که ۰۱۵ برای تعداد و ۰۱۷ برای تخفیف ردش کردند، و به همان
-- دلیل: افزودن دوباره، قیمت فهرست را از `catalog.price` **دوباره**
-- می‌خواند. اگر وسط شیفت حراج خورده باشد، `list_price` سطر تازه با
-- قیمتی که مشتری روی برچسب دیده یکی نیست — و «کاهش کل» که سقف تخفیف
-- از آن سنجیده می‌شود، با عدد عوضی حساب می‌شود.
--
-- ── سه چیزی که این تابع نگه می‌دارد ────────────────────────────────
--
-- **قیمت فهرست یک بار Snapshot می‌شود، نه هر بار.** سطری که قبلاً
-- قیمت دستی خورده، `list_price` خودش را دارد؛ نوشتن قیمت دوم آن را
-- دست نمی‌زند. وگرنه تایپ اشتباه ۱۰۰ و اصلاحش به ۹۰، قیمت فهرست را
-- روی ۱۰۰ می‌نشاند و کاهش واقعی نسبت به ۱۲۰ گم می‌شد.
--
-- **برگشت به قیمت فهرست، اثر را پاک می‌کند.** اگر قیمت تازه دقیقاً
-- همان `list_price` باشد، سطر دوباره «دست‌نخورده» می‌شود:
-- `list_price` و دلیل هر دو NULL. صندوق‌داری که اشتباه تایپ کرده باید
-- بتواند برش گرداند، نه اینکه سطر تا ابد «قیمت دستی خورده» بماند و
-- گزارش کاهش قیمت را شلوغ کند.
--
-- **تخفیف دست نمی‌خورد.** ولی دوباره سنجیده می‌شود: تخفیفی که با
-- قیمت قبلی مجاز بود، با قیمت پایین‌تر می‌تواند از مبلغ خودِ قلم بیشتر
-- شود.
--
-- ── چه چیزی اینجا **نیست** ────────────────────────────────────────
--
-- مجوز `sale.price_override` و سقف «کاهش کل». آن‌ها در
-- `permission_rule` و در `sales/markdown-gate.ts` می‌مانند — همان
-- دروازه‌ای که `POST /lines` و سفارش سایت از آن می‌گذرند. دروازه یک
-- تعریف دارد، نه سه تا.
--
-- آنچه دیتابیس اجبار می‌کند سر جایش می‌ماند: `invoice_line_reason_guard`
-- (مهاجرت ۰۱۰) روی همین UPDATE هم اجرا می‌شود، پس کاهش بالاتر از
-- آستانه بدون دلیل از این مسیر هم رد می‌شود.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۰. زنجیره حسابرسی باید از داخل تابعی با search_path پین‌شده هم کار کند
-- ---------------------------------------------------------------------
-- `platform.audit_chain()` (مهاجرت ۰۰۳) `digest()` را بدون نام اسکیما
-- صدا می‌زند. تا امروز مسئله‌ای نبود چون هیچ تابعی که `platform.audit()`
-- می‌زند `search_path` پین‌شده نداشت. اولین تابعی که هر دو را داشت،
-- `ERROR: function digest(text, unknown) does not exist` گرفت — یعنی
-- ثبت حسابرسی از آن مسیر **اصلاً ممکن نبود**، نه اینکه کند باشد.
--
-- خودِ Trigger هم `search_path` پین‌شده می‌گیرد تا نتیجه‌اش به تابع
-- فراخوان وابسته نماند. `public` جایی است که مهاجرت ۰۰۱ pgcrypto را
-- نصب کرده؛ در PostgreSQL 15 به بعد نقش‌های عادی روی آن CREATE ندارند،
-- پس افزودنش در به‌ربایی نام باز نمی‌کند.

CREATE OR REPLACE FUNCTION platform.audit_chain() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
DECLARE v_prev text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('platform.audit_log')::bigint);

  SELECT hash INTO v_prev FROM platform.audit_log ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := v_prev;
  NEW.hash := encode(public.digest(
      coalesce(v_prev,'') || NEW.at::text || coalesce(NEW.actor_id::text,'')
      || NEW.action || NEW.entity || coalesce(NEW.entity_id,'')
      || coalesce(NEW.after::text,''), 'sha256'), 'hex');
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- ۱. قیمت دستی روی سطر سبد
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION sales.set_line_price(
  p_invoice uuid, p_line uuid,
  p_price platform.money, p_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
DECLARE
  v_status  text;
  l         sales.invoice_line%ROWTYPE;
  v_list    platform.money;
  v_gross   platform.money;
  v_reason  text;
BEGIN
  IF p_price IS NULL OR p_price <= 0 THEN
    RAISE EXCEPTION 'قیمت باید بزرگ‌تر از صفر باشد';
  END IF;

  -- قفل فاکتور پیش از خواندن سطر — همان ترتیب `set_line_qty` و
  -- `set_line_discount`. ترتیب متفاوت میان این سه یعنی Deadlock.
  SELECT status INTO v_status FROM sales.invoice WHERE id = p_invoice FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'فاکتور یافت نشد';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'فاکتور در وضعیت «%» است و سبد آن دیگر تغییر نمی‌کند', v_status;
  END IF;

  SELECT * INTO l FROM sales.invoice_line
    WHERE id = p_line AND invoice_id = p_invoice FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'این قلم در فاکتور نیست';
  END IF;

  -- قیمت فهرست واقعی: اگر سطر قبلاً دستکاری شده، همان Snapshot اول.
  v_list := coalesce(l.list_price, l.unit_price);

  -- ناخالص با همان `round()` که `set_line_qty` و
  -- `refresh_invoice_totals` دارند. تقسیم و ضرب در لایه دیگر، جمع
  -- فاکتور را از جمع سطرها جدا می‌کند.
  v_gross := round(l.qty * p_price);
  IF l.discount_amount > v_gross THEN
    RAISE EXCEPTION
      'تخفیف ثبت‌شده (%) از مبلغ قلم با قیمت تازه (%) بیشتر می‌شود؛ اول تخفیف را کم کنید',
      l.discount_amount, v_gross;
  END IF;

  IF p_price = v_list THEN
    -- برگشت به فهرست: سطر دوباره دست‌نخورده است.
    UPDATE sales.invoice_line
       SET unit_price            = p_price,
           list_price            = NULL,
           price_override_reason = NULL,
           net_amount            = v_gross - l.discount_amount
     WHERE id = p_line;
    v_reason := NULL;
  ELSE
    -- دلیل تازه جای دلیل قبلی را می‌گیرد؛ دلیل خالی آن را پاک نمی‌کند.
    v_reason := coalesce(nullif(btrim(p_reason), ''), l.price_override_reason);
    UPDATE sales.invoice_line
       SET unit_price            = p_price,
           list_price            = v_list,
           price_override_reason = v_reason,
           net_amount            = v_gross - l.discount_amount
     WHERE id = p_line;
  END IF;

  -- ردّ حسابرسی داخل خودِ تابع، نه در لایه فراخوان: مسیر تازه‌ای که
  -- روزی این تابع را صدا بزند نباید بتواند فراموشش کند. کاربر عامل
  -- از `platform.set_actor()` می‌آید و نبودش عمداً خطا می‌دهد.
  -- ⚠️ مبالغ **رشته** ذخیره می‌شوند، نه عدد JSON. قاعده «پول در JSON
  --    رشته است» به مرز API محدود نیست: عدد JSON بالای ۹ کوادریلیون
  --    دقت را از دست می‌دهد و هر خواننده‌ای که این ردّ را با
  --    JSON.parse بخواند همان‌جا خرابش می‌کند. مسیر `addLine` هم از
  --    روز اول رشته می‌نوشت؛ دو شکل در یک ستون یعنی گزارش حسابرسی
  --    باید هر دو را بفهمد.
  PERFORM platform.audit(
    'sale.price_override', 'invoice_line', p_line::text,
    jsonb_build_object(
      'unitPrice', p_price::text, 'listPrice', v_list::text, 'qty', l.qty::text,
      'variationId', l.variation_id, 'invoiceId', p_invoice),
    NULL, v_reason,
    jsonb_build_object(
      'unitPrice', l.unit_price::text,
      'listPrice', CASE WHEN l.list_price IS NULL THEN NULL ELSE l.list_price::text END));

  PERFORM sales.refresh_invoice_totals(p_invoice);
END $$;

COMMENT ON FUNCTION sales.set_line_price IS
  'قیمت یک سطر سبد را زیر قفل فاکتور عوض می‌کند. قیمت فهرست یک بار Snapshot می‌شود؛ برگشت به فهرست اثر را پاک می‌کند. مجوز و سقف کاهش کار لایه API است.';

COMMIT;
