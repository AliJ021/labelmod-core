-- ۰۶۰ — بستن EXECUTE عمومی روی توابع SECURITY DEFINER، و محدودکردن
--        موضوع و Payload صف Push سایت (یافتهٔ FND-R60-04)
--
-- ── مسئله ───────────────────────────────────────────────────────────
--
-- مهاجرت ۰۵۰ و ۰۵۸ شش تابع را `SECURITY DEFINER` کردند تا
-- `ops/db-roles.sh` بتواند حق نوشتنِ مستقیم روی سه جدول قفل‌شده را از
-- نقش برنامه بگیرد و دروازه‌ها باز بمانند. آن کار درست بود و یک چیز را
-- جا گذاشت: **ACL خودِ آن توابع**.
--
-- ACL پیش‌فرض یک تابع در پستگرس `EXECUTE` برای `PUBLIC` است. یعنی هر
-- شش تابع — از جمله سه **کمکیِ درونی** که هیچ‌کس بیرون از دیتابیس
-- نباید صدا بزند — برای هر نقشی که فقط `USAGE` روی اسکیما داشته باشد
-- قابل فراخوان بودند. اندازه‌گیری شد، نه حدس:
--
--     CREATE ROLE probe LOGIN PASSWORD '…';
--     GRANT USAGE ON SCHEMA platform TO probe;
--     -- درج مستقیم:  ERROR: permission denied for table outbox_message
--     -- از راه تابع:  SELECT platform.enqueue_web_push(
--     --                 'web.stock_push',
--     --                 '{"variationId":"…","onHand":9999,
--     --                   "version":999999999}') → id=1
--
-- یعنی نقشی **بی هیچ حقی روی جدول** یک پیام دلخواه در صف می‌گذاشت،
-- Worker امضایش می‌کرد، و موجودی واقعی سایت ۹۹۹۹ می‌شد. و بدتر:
-- افزونه پیام با `version` کوچک‌تر‌یا‌مساوی نسخهٔ ذخیره‌شده را **دور
-- می‌اندازد**، پس `version = 999999999` هر Push **بعدیِ** آن کالا را
-- تا ابد بی‌صدا می‌بست — خرابی‌ای که هیچ خطایی تولید نمی‌کند.
--
-- ── دو لایه، و هیچ‌کدام کافی نیست ───────────────────────────────────
--
-- ⚠️ **لایه ۱ — ACL: اینجا فقط `PUBLIC` بسته می‌شود، نه بیشتر.**
--    مهاجرت نام نقش برنامه را نمی‌داند (یک تصمیم استقرار است، بند ۳
--    SECURITY.md)، پس `GRANT`دادن به آن و `REVOKE` از سه کمکی کارِ
--    `ops/db-roles.sh` است. **و آن اسکریپت پس از مهاجرت اجرا می‌شود**:
--    اگر REVOKE فقط اینجا می‌بود، اولین
--    `GRANT EXECUTE ON ALL FUNCTIONS` همان اسکریپت بازش می‌کرد.
--
-- ⚠️ **لایه ۲ — خودِ تابع.** ACL یک مرز دسترسی است و مرز دسترسی روزی
--    اشتباه تنظیم می‌شود. پس `enqueue_web_push` دیگر به فراخوانش
--    اعتماد نمی‌کند: موضوع از یک فهرست بسته می‌آید، شکل Payload سنجیده
--    می‌شود، و **`version` از خودِ دنباله گرفته می‌شود نه از ورودی** —
--    یعنی حتی اگر روزی کسی به تابع برسد، «نسخهٔ سمّی» نمی‌تواند بسازد.
--    این لایه همان چیزی است که ACL را از یک نقطهٔ شکست به یک لایه
--    تبدیل می‌کند.

-- ═══════════════════════════════════════════════════════════════════
-- ۱. REVOKE ALL … FROM PUBLIC روی هر تابع SECURITY DEFINER
-- ═══════════════════════════════════════════════════════════════════
--
-- ⚠️ **یک کلاس، نه یک فهرست.** کاتالوگ خوانده می‌شود، پس تابع
--    DEFINERی که امروز هست و من در فهرست ننوشتم هم پوشیده می‌شود.
--    (تابع DEFINERی که **فردا** ساخته شود کار این مهاجرت نیست —
--    `db/test/write-gate.sql` بند ۵ آن را قرمز می‌کند.)
--
-- ⚠️ و یک **ضدپوچی**: اگر شمارش صفر یا کمتر از شش شد، یعنی یا کاتالوگ
--    را غلط می‌خوانم یا مهاجرت ۰۵۰/۰۵۸ اجرا نشده. یک مهاجرتِ
--    بی‌اثرِ سبز از هر خطایی بدتر است.
DO $$
DECLARE
  v_sig text;
  v_n   int := 0;
BEGIN
  FOR v_sig IN
    SELECT quote_ident(n.nspname) || '.' || quote_ident(p.proname) || '(' ||
           pg_get_function_identity_arguments(p.oid) || ')'
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosecdef
       AND p.prokind = 'f'
       AND n.nspname IN ('platform','identity','catalog','inventory',
                         'purchasing','sales','treasury','ledger')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_sig);
    v_n := v_n + 1;
  END LOOP;

  IF v_n < 6 THEN
    RAISE EXCEPTION 'انتظار دست‌کم شش تابع SECURITY DEFINER بود، % پیدا شد. '
                    'مهاجرت ۰۵۰ یا ۰۵۸ اجرا نشده است؟', v_n;
  END IF;

  RAISE NOTICE 'EXECUTE عمومی از % تابع SECURITY DEFINER گرفته شد.', v_n;
END $$;

-- ═══════════════════════════════════════════════════════════════════
-- ۲. صف Push سایت: موضوع بسته، Payload سنجیده، نسخه از دنباله
-- ═══════════════════════════════════════════════════════════════════
--
-- ⚠️ `platform.enqueue_health_alerts()` از این تابع استفاده **نمی‌کند**
--    (خودش مستقیم در `outbox_message` درج می‌کند و `SECURITY DEFINER`
--    نیست، پس حق جدول برایش اعمال می‌شود). پس `health.alert` در فهرست
--    مجاز **نمی‌ماند** — نگه‌داشتنش یعنی همان سوراخ با یک نام دیگر.
--
-- ⚠️ `version` دیگر از ورودی خوانده نمی‌شود. مقدارِ ورودی — اگر باشد —
--    **بی‌صدا دور انداخته نمی‌شود**؛ بازنویسی می‌شود و همین درست است:
--    تنها منبع نسخه `platform.web_push_version` است و دو منبع یعنی
--    ترتیب سمت افزونه شکسته شود.
--
-- ⚠️ وجودِ `variationId` در `catalog.variation` سنجیده می‌شود. شناسهٔ
--    ناموجود یعنی پیامی که افزونه هرگز نمی‌تواند به کالایی بچسباند —
--    همان کلاس FND-R60 روی `party_id` (مهاجرت ۰۵۲).
CREATE OR REPLACE FUNCTION platform.enqueue_web_push(
  p_topic   text,
  p_payload jsonb
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, platform, catalog
AS $$
DECLARE
  v_id      bigint;
  v_var     text := p_payload->>'variationId';
  v_uuid    uuid;
  v_payload jsonb;
BEGIN
  -- ── موضوع: فهرست بسته ──────────────────────────────────────────
  IF p_topic IS NULL OR p_topic NOT IN ('web.stock_push', 'web.price_push') THEN
    RAISE EXCEPTION 'موضوع «%» از صف Push سایت ساخته نمی‌شود.', coalesce(p_topic, '‹تهی›');
  END IF;

  -- ── شناسهٔ تنوع: موجود، uuid، و واقعاً در کاتالوگ ───────────────
  IF v_var IS NULL THEN
    RAISE EXCEPTION 'پیام Push بدون variationId ساخته نمی‌شود.';
  END IF;

  BEGIN
    v_uuid := v_var::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'variationId «%» یک شناسهٔ معتبر نیست.', v_var;
  END;

  IF NOT EXISTS (SELECT 1 FROM catalog.variation WHERE id = v_uuid) THEN
    RAISE EXCEPTION 'تنوع با شناسهٔ % وجود ندارد؛ پیام Push ساخته نمی‌شود.', v_uuid;
  END IF;

  -- ── شکل Payload، به‌ازای هر موضوع ───────────────────────────────
  IF p_topic = 'web.stock_push' THEN
    -- ⚠️ `IS DISTINCT FROM` اجباری است: کلیدِ **نبوده** را
    --    `jsonb_typeof` با NULL جواب می‌دهد و `NULL <> 'number'` خودش
    --    NULL است، پس `IF` شلیک نمی‌کرد. نسخهٔ اول همین را داشت و
    --    Payload بی `onHand` بی‌صدا از نگهبان رد می‌شد.
    IF jsonb_typeof(p_payload->'onHand') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Push موجودی باید onHand عددی داشته باشد.';
    END IF;
    IF (p_payload->>'onHand')::numeric < 0 THEN
      RAISE EXCEPTION 'onHand منفی به سایت فرستاده نمی‌شود.';
    END IF;
  ELSE
    -- قیمت: `null` یعنی «قیمت ندارد» و مجاز است؛ عدد **نه** — پول در
    -- JSON رشته است و نوشتنش به‌شکل number دقت را از دست می‌دهد.
    IF NOT p_payload ? 'priceRial' THEN
      RAISE EXCEPTION 'Push قیمت باید کلید priceRial داشته باشد.';
    END IF;
    IF coalesce(jsonb_typeof(p_payload->'priceRial'), '‹نبود›')
         NOT IN ('null', 'string') THEN
      RAISE EXCEPTION 'priceRial باید رشته یا null باشد، نه %.',
                      coalesce(jsonb_typeof(p_payload->'priceRial'), '‹نبود›');
    END IF;
    IF p_payload->>'priceRial' IS NOT NULL
       AND p_payload->>'priceRial' !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'priceRial «%» یک مبلغ ریالی صحیح نیست.', p_payload->>'priceRial';
    END IF;
  END IF;

  -- ── نسخه: فقط از دنباله ────────────────────────────────────────
  v_payload := p_payload || jsonb_build_object(
                 'version', nextval('platform.web_push_version'));

  INSERT INTO platform.outbox_message (topic, payload)
  VALUES (p_topic, v_payload)
  ON CONFLICT (topic, (payload->>'variationId'))
    WHERE status = 'pending' AND payload ? 'variationId'
  DO UPDATE SET
        payload         = EXCLUDED.payload,
        attempts        = 0,
        next_attempt_at = now(),
        last_error      = NULL
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

COMMENT ON FUNCTION platform.enqueue_web_push(text, jsonb) IS
  'صف Push سایت — موضوع بسته، Payload سنجیده، نسخه از دنبالهٔ platform.web_push_version.';

-- ۰۶۰ خودش تابع را بازتعریف کرد، پس ACLاش به پیش‌فرض برگشت.
REVOKE ALL ON FUNCTION platform.enqueue_web_push(text, jsonb) FROM PUBLIC;

-- ═══════════════════════════════════════════════════════════════════
-- ۳. دو فراخوان، بی `version`
-- ═══════════════════════════════════════════════════════════════════
--
-- تنها تفاوت با ۰۵۷: `version` از Payload برداشته شد چون
-- `enqueue_web_push` خودش می‌گذاردش. گذاشتنش در هر دو جا یعنی یک
-- `nextval` اضافه در هر Push و دو تعریف از «نسخه».
CREATE OR REPLACE FUNCTION inventory.push_web_stock(
  p_variation uuid,
  p_warehouse uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, inventory, platform, catalog
AS $$
DECLARE
  v_sku text;
BEGIN
  IF NOT platform.setting_bool('web.push_enabled', false) THEN RETURN; END IF;
  IF p_warehouse IS DISTINCT FROM platform.web_warehouse_id() THEN RETURN; END IF;

  SELECT sku INTO v_sku FROM catalog.variation WHERE id = p_variation;

  PERFORM platform.enqueue_web_push(
    'web.stock_push',
    jsonb_build_object(
      'variationId', p_variation::text,
      'sku',         v_sku,
      'onHand',      trim_scale(inventory.web_stock_qty(p_variation, p_warehouse)),
      'at',          to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    ));
END $$;

REVOKE ALL ON FUNCTION inventory.push_web_stock(uuid, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION catalog.push_web_price(
  p_variation uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, catalog, platform
AS $$
DECLARE
  v_sku    text;
  v_amount platform.money;
  v_list   text := platform.setting_text('web.price_list', 'default');
BEGIN
  IF NOT platform.setting_bool('web.push_enabled', false) THEN RETURN; END IF;

  SELECT sku INTO v_sku FROM catalog.variation WHERE id = p_variation;

  SELECT amount INTO v_amount
    FROM catalog.price
   WHERE variation_id = p_variation
     AND price_list   = v_list
     AND valid_to IS NULL
   LIMIT 1;

  PERFORM platform.enqueue_web_push(
    'web.price_push',
    jsonb_build_object(
      'variationId', p_variation::text,
      'sku',         v_sku,
      'priceRial',   CASE WHEN v_amount IS NULL THEN NULL ELSE v_amount::text END,
      'at',          to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    ));
END $$;

REVOKE ALL ON FUNCTION catalog.push_web_price(uuid) FROM PUBLIC;

-- ═══════════════════════════════════════════════════════════════════
-- ۴. `catalog.set_price()` هم دروازه است — پس باید DEFINER باشد
-- ═══════════════════════════════════════════════════════════════════
--
-- ⚠️ **این بند از یک شکست واقعی آمد، نه از یک فهرست.** بند ۱ و ۳ بالا
--    `EXECUTE` را از `catalog.push_web_price()` گرفتند و
--    `ops/db-roles.sh` هم از نقش برنامه گرفتش. نتیجه:
--
--        LMC_TEST_DB_ROLE=app pnpm --filter @labelmod/api test
--        → permission denied for function push_web_price
--
--    چون `catalog.set_price()` — تنها راه مجاز تغییر قیمت — **خودش
--    DEFINER نبود**. یعنی با نقش برنامه، `current_user` همان نقش
--    برنامه می‌ماند و فراخوانِ کمکیِ بسته‌شده رد می‌شود. **هر تغییر
--    قیمتی در تولید ۵۰۰ می‌داد.**
--
--    این دقیقاً همان کلاسی است که بند ۳ SECURITY.md می‌گوید: قفلی که
--    دروازه را هم می‌بندد. و دقیقاً همان دلیلی که آن اجرای زیر نقش
--    محدود در CI هست.
--
-- ⚠️ راه‌حلِ دیگر — `GRANT EXECUTE` دادنِ `push_web_price` به نقش
--    برنامه — انتخاب **نشد**: آن‌وقت یکی از سه کمکی باز می‌ماند و
--    فهرست «بسته‌ها» یک استثنا پیدا می‌کرد که فردا توضیحش فراموش
--    می‌شود. `set_price` از قبل **معماراً** یک دروازه است (یک Trigger
--    روی `catalog.price` هر نوشتن دیگری را رد می‌کند)، پس DEFINER
--    کردنش وضع موجود را رسمی می‌کند، نه چیز تازه‌ای می‌دهد.
--
-- ⚠️ `ALTER FUNCTION`، نه بازنویسی بدنه — مثل مهاجرت ۰۵۸. بدنه‌ای که
--    دوباره تایپ شود، جایی برای یک اختلاف بی‌صدا باز می‌کند.
--
-- ⚠️ و `set_price` به `current_user` تکیه نمی‌کند: کاربر عامل را از
--    `platform.current_actor()` (یک GUC) می‌خواند. اگر تکیه می‌کرد،
--    DEFINER کردنش ردّ حسابرسی را به نام مالک می‌نوشت.
DO $$
DECLARE v_sig text;
BEGIN
  SELECT 'catalog.' || p.proname || '(' ||
         pg_get_function_identity_arguments(p.oid) || ')'
    INTO v_sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'catalog' AND p.proname = 'set_price' AND p.prokind = 'f';

  IF v_sig IS NULL THEN
    RAISE EXCEPTION 'catalog.set_price پیدا نشد — مهاجرت ۰۵۷ اجرا نشده است؟';
  END IF;

  EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER
    SET search_path = pg_catalog, public, catalog, platform, inventory', v_sig);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_sig);

  RAISE NOTICE '% به SECURITY DEFINER با search_path پین‌شده تبدیل شد.', v_sig;
END $$;
