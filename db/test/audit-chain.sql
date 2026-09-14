-- =====================================================================
-- دفتر حسابرسی: زنجیره هش واقعاً دست‌کاری را می‌گیرد؟
-- =====================================================================
--
-- ── چرا این پرونده هست ──────────────────────────────────────────────
--
-- زنجیره هش از روز اول بود و دو نگاه‌کننده داشت — ادعای CI و بند ۶
-- `ops/restore-drill.sh` — ولی **هر دو فقط پیوندها را می‌سنجیدند**:
--
--     prev_hash هر سطر = hash سطر پیشین
--
-- که درج و حذف سطر را می‌گیرد و **تغییر محتوای سطر را نه**. اندازه‌گیری
-- شد، نه حدس: با خاموش‌کردن Trigger و عوض‌کردن `after` یک سطر،
--
--     نگهبان CI              → ۰ گسست
--     نگهبان restore-drill   → ۰ گسست
--     بازمحاسبهٔ واقعی هش    → ۱ سطر دست‌کاری‌شده
--
-- و بدتر: فرمول نسخه ۱ `before` و `reason` را نمی‌پوشاند، پس حتی
-- بازمحاسبه هم جعلِ «قبلاً چه بود و چرا عوض شد» را نمی‌دید. رکورد زیر
-- هر سه نگاه‌کننده **و لنگرِ شبِ بند ۳ SECURITY.md** را رد می‌کرد:
--
--     setting.change · return.window_hours
--       before 999999 · after 72 · reason «تأیید مدیر مالی (جعلی)»
--
-- مهاجرت ۰۵۱ هر دو را بست. این پرونده اثبات می‌کند آشکارساز **واقعاً
-- می‌گیرد** — وگرنه یک نمای همیشه‌خالی هم «پاس» می‌شد.
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

CREATE OR REPLACE FUNCTION pg_temp.assert_txt(
  p_label text, p_actual text, p_expected text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: %\n      واقعی : %', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE '  ✓ % = %', p_label, p_actual;
END $$;

DO $test$
DECLARE
  BR uuid := '00000000-0000-7000-8000-000000000001';
  u  uuid;
  n  bigint;
  t  text;
  v_id bigint;
  v_before jsonb;
  v_after  jsonb;
  v_reason text;
  v_actor  uuid;
  v_at     timestamptz;
  v_action text;
  v_entity_id text;
BEGIN
RAISE NOTICE E'\n── آماده‌سازی: چند رکورد حسابرسی واقعی ─────────────────────';

  INSERT INTO identity.app_user (username, full_name, password_hash, is_active)
  VALUES ('audit_chain_probe', 'کاربر آزمون زنجیره', 'x', true) RETURNING id INTO u;
  INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES (u, 'admin', BR);
  PERFORM platform.set_actor(u);

  -- سه تغییر تنظیم = سه رکورد حسابرسی با before و after و reason
  PERFORM platform.set_setting('return.window_hours', '72'::jsonb,  'آزمون زنجیره ۱');
  PERFORM platform.set_setting('return.window_hours', '96'::jsonb,  'آزمون زنجیره ۲');
  PERFORM platform.set_setting('return.window_hours', '48'::jsonb,  'آزمون زنجیره ۳');

  SELECT count(*) INTO n FROM platform.audit_log;
  IF n < 3 THEN
    RAISE EXCEPTION E'\n  ✗ آماده‌سازی: انتظار دست‌کم ۳ رکورد حسابرسی، واقعی %', n;
  END IF;
  RAISE NOTICE '  ✓ رکورد حسابرسی = % (≥ 3)', n;

RAISE NOTICE E'\n── ۱. کنترل مثبت: دفتر دست‌نخورده، آشکارساز خالی ───────────';

  -- ⚠️ **اجباری است.** بی این بند، نمایی که همیشه خالی باشد هم «پاس»
  --    می‌شد و هیچ‌کدام از بندهای زیر معنا نداشتند.
  SELECT count(*) INTO n FROM platform.audit_check;
  PERFORM pg_temp.assert_eq('دست‌کاری روی دفتر سالم', n, 0);

  -- و رکوردهای تازه باید **آخرین** نسخهٔ فرمول را داشته باشند، وگرنه
  -- میدانی بیرون از پوشش هش می‌ماند و جعلش دیده نمی‌شود:
  --
  --   نسخه ۲ (مهاجرت ۰۵۱)  before و reason را پوشاند
  --   نسخه ۳ (مهاجرت ۰۵۶)  correlation_id را پوشاند
  --
  -- ⚠️ عدد صریح نوشته می‌شود، نه «بیشترین نسخهٔ موجود»: بالا بردن نسخه
  --    باید یک **ویرایش عمدی** در همین خط باشد. اگر این ادعا خودش را با
  --    فرمول هم‌راستا می‌کرد، مهاجرتی که میدان تازه‌ای اضافه کند و
  --    پوشش ندهد، بی‌صدا سبز می‌ماند.
  SELECT count(*) INTO n FROM platform.audit_log WHERE hash_version <> 3;
  PERFORM pg_temp.assert_eq('رکورد تازه با فرمول قدیمی', n, 0);

RAISE NOTICE E'\n── ۲. دست‌کاری محتوا، میدان به میدان ───────────────────────';

  SELECT id, before, after, reason, actor_id, at, action, entity_id
    INTO v_id, v_before, v_after, v_reason, v_actor, v_at, v_action, v_entity_id
    FROM platform.audit_log ORDER BY id DESC LIMIT 1;

  -- مهاجمی که دسترسی کامل DB دارد Trigger تغییرناپذیری را خاموش می‌کند.
  -- همان مهاجمی که بند ۳ SECURITY.md صریح درباره‌اش حرف می‌زند.
  ALTER TABLE platform.audit_log DISABLE TRIGGER USER;

  -- الف) «after» — مقدار جدید
  UPDATE platform.audit_log SET after = '{"key":"return.window_hours","value":99999}'::jsonb
   WHERE id = v_id;
  SELECT count(*) INTO n FROM platform.audit_check WHERE id = v_id;
  PERFORM pg_temp.assert_eq('دست‌کاری «after» گرفته شد', n, 1);
  SELECT problem INTO t FROM platform.audit_check WHERE id = v_id;
  PERFORM pg_temp.assert_txt('نوع مشکل «after»', t, 'content_changed');
  UPDATE platform.audit_log SET after = v_after WHERE id = v_id;

  -- ب) «before» — مقدار قبلی. تا مهاجرت ۰۵۱ **پوشش نداشت**.
  UPDATE platform.audit_log SET before = '{"key":"return.window_hours","value":999999}'::jsonb
   WHERE id = v_id;
  SELECT count(*) INTO n FROM platform.audit_check WHERE id = v_id;
  PERFORM pg_temp.assert_eq('دست‌کاری «before» گرفته شد', n, 1);
  UPDATE platform.audit_log SET before = v_before WHERE id = v_id;

  -- پ) «reason» — دلیل. تا مهاجرت ۰۵۱ **پوشش نداشت**.
  UPDATE platform.audit_log SET reason = 'تأیید مدیر مالی (جعلی)' WHERE id = v_id;
  SELECT count(*) INTO n FROM platform.audit_check WHERE id = v_id;
  PERFORM pg_temp.assert_eq('دست‌کاری «reason» گرفته شد', n, 1);
  UPDATE platform.audit_log SET reason = v_reason WHERE id = v_id;

  -- ت) «actor_id» — چه کسی کرد
  UPDATE platform.audit_log SET actor_id = u WHERE id = v_id AND actor_id IS DISTINCT FROM u;
  UPDATE platform.audit_log SET actor_id = NULL WHERE id = v_id;
  SELECT count(*) INTO n FROM platform.audit_check WHERE id = v_id;
  PERFORM pg_temp.assert_eq('دست‌کاری «actor_id» گرفته شد', n, 1);
  UPDATE platform.audit_log SET actor_id = v_actor WHERE id = v_id;

  -- ث) «at» — چه زمانی
  UPDATE platform.audit_log SET at = v_at - interval '10 days' WHERE id = v_id;
  SELECT count(*) INTO n FROM platform.audit_check WHERE id = v_id;
  PERFORM pg_temp.assert_eq('دست‌کاری «at» گرفته شد', n, 1);
  UPDATE platform.audit_log SET at = v_at WHERE id = v_id;

  -- ج) «action» — چه کاری
  UPDATE platform.audit_log SET action = 'setting.read' WHERE id = v_id;
  SELECT count(*) INTO n FROM platform.audit_check WHERE id = v_id;
  PERFORM pg_temp.assert_eq('دست‌کاری «action» گرفته شد', n, 1);
  UPDATE platform.audit_log SET action = v_action WHERE id = v_id;

  -- چ) «entity_id» — روی چه چیزی
  UPDATE platform.audit_log SET entity_id = 'sale.discount' WHERE id = v_id;
  SELECT count(*) INTO n FROM platform.audit_check WHERE id = v_id;
  PERFORM pg_temp.assert_eq('دست‌کاری «entity_id» گرفته شد', n, 1);
  UPDATE platform.audit_log SET entity_id = v_entity_id WHERE id = v_id;

  -- و پس از برگرداندن همه، دفتر باید دوباره سالم شود — وگرنه یکی از
  -- بندهای بالا چیزی را دائمی خراب کرده و بندهای بعدی بی‌معنا بودند.
  SELECT count(*) INTO n FROM platform.audit_check;
  PERFORM pg_temp.assert_eq('پس از برگرداندن، دفتر سالم', n, 0);

RAISE NOTICE E'\n── ۳. گسست پیوند: حذف یک سطر میانی ────────────────────────';

  -- این همان چیزی است که نگهبان قبلی **می‌گرفت**؛ باید همچنان بگیرد.
  DELETE FROM platform.audit_log
   WHERE id = (SELECT min(id) + 1 FROM platform.audit_log);
  SELECT count(*) INTO n FROM platform.audit_check WHERE problem = 'broken_link';
  PERFORM pg_temp.assert_eq('حذف سطر میانی گرفته شد', n, 1);

  ALTER TABLE platform.audit_log ENABLE TRIGGER USER;

RAISE NOTICE E'\n── ۴. نگهبان تغییرناپذیری هنوز کار می‌کند ──────────────────';

  -- Trigger روشن است: حالا UPDATE باید رد شود. اگر بند ۲ فراموش کرده
  -- بود Trigger را روشن کند، این بند می‌گرفتش.
  BEGIN
    UPDATE platform.audit_log SET reason = 'x' WHERE id = v_id;
    RAISE EXCEPTION E'\n  ✗ UPDATE روی audit_log باید رد شود';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE '%باید رد شود%' THEN RAISE; END IF;
    RAISE NOTICE '  ✓ UPDATE رد شد → %', left(SQLERRM, 60);
  END;

RAISE NOTICE E'\n═══ زنجیره حسابرسی: همه بندها پاس ═════════════════════════\n';
END $test$;

ROLLBACK;
