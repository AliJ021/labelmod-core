-- =====================================================================
-- حرکت انبار بی سند مرجع ثبت نمی‌شود (مهاجرت ۰۵۹، معیار پذیرش ۲)
-- =====================================================================
-- ⚠️ **کنترل منفی مهم‌تر از کنترل مثبت است.** یک `CHECK` بیش از حد
--    سخت‌گیر — مثلاً بی استثنای `opening` — هر ادعای «رد شد» را سبز
--    می‌کرد و **واردات دادهٔ اولیه را می‌شکست**؛ چیزی که فقط روز
--    مهاجرت داده دیده می‌شد، نه در CI. پس بند ۳ عمداً ادعا می‌کند که
--    `opening` بی مرجع **باید قبول شود**.
--
-- ⚠️ حمله‌ها با **درج مستقیم** زده می‌شوند، نه از راه `apply_movement`:
--    دروازه خودش مرجع را پر می‌کند، پس عبور از آن دربارهٔ **قید**
--    هیچ‌چیز ثابت نمی‌کرد. چیزی که سنجیده می‌شود، لایه‌ای است که جلوی
--    مسیرِ دور‌زننده را می‌گیرد.
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

-- دادهٔ حداقلی: یک تنوع و یک انبار واقعی، تا درج به FK نخورد و
-- شکستش با شکستِ قید اشتباه نشود.
--
-- ⚠️ درج و ساختِ جدول موقت جدا هستند: پستگرس CTEی داده‌نویس را داخل
--    یک زیرپرسمانِ اسکالر نمی‌پذیرد.
WITH p AS (
  INSERT INTO catalog.product (code, name_internal)
  VALUES ('MREF-1', 'کالای تست مرجع حرکت') RETURNING id
)
INSERT INTO catalog.variation (product_id, sku, color, size)
SELECT id, 'MREF-1-M', 'آبی', 'M' FROM p;

CREATE TEMP TABLE t AS
SELECT (SELECT id FROM inventory.warehouse WHERE code = 'STORE') AS wh,
       (SELECT id FROM catalog.variation WHERE sku = 'MREF-1-M')  AS var;

-- ضدپوچی: اگر هیچ‌کدام پیدا نشد، هر ادعای بعدی روی NULL بی‌معنا
-- «پاس» می‌شد.
DO $$
BEGIN
  IF (SELECT wh FROM t) IS NULL OR (SELECT var FROM t) IS NULL THEN
    RAISE EXCEPTION '  ✗ آماده‌سازی نشد — انبار STORE یا تنوع تست پیدا نشد';
  END IF;
END $$;

\echo '── ۱. حرکت بی مرجع رد می‌شود ──'
DO $$
DECLARE r record; v_bad int := 0; v_ok int := 0; v_msg text;
BEGIN
  -- هر نوعِ غیر از opening، با هر سه شکلِ «ناقص».
  FOR r IN
    SELECT k.kind, m.rt, m.ri, m.label
      FROM unnest(ARRAY['sale','sale_return','purchase_receipt','purchase_return',
                        'transfer_in','transfer_out','count_adjust',
                        'defective','lost','correction']) AS k(kind)
      CROSS JOIN (VALUES (NULL::text, NULL::uuid, 'هر دو تهی'),
                         ('invoice',  NULL::uuid, 'شناسه تهی'),
                         (NULL::text, '00000000-0000-7000-8000-0000000000aa'::uuid, 'نوع تهی')
                 ) AS m(rt, ri, label)
  LOOP
    BEGIN
      INSERT INTO inventory.stock_movement
        (variation_id, warehouse_id, qty, value_delta, kind, ref_type, ref_id)
      SELECT var, wh, 1, 0, r.kind, r.rt, r.ri FROM t;
      RAISE WARNING '  ✗ % (%) قبول شد — راه باز است', r.kind, r.label;
      v_bad := v_bad + 1;
    EXCEPTION
      -- ⚠️ `raise_exception` (P0001) است نه `check_violation`: Trigger
      --    زودتر از `CHECK` شلیک می‌کند و پیام فارسی می‌دهد. همین هم
      --    مطلوب است — `errors.ts` فقط P0001 را به ۴۰۹ ترجمه می‌کند و
      --    یک ۲۳۵۱۴ خام به کاربر «خرابی سرور» نشان می‌داد. بند ۶ ثابت
      --    می‌کند لایهٔ دوم هم مستقلاً کار می‌کند.
      WHEN raise_exception OR check_violation THEN
        v_ok := v_ok + 1;
      WHEN others THEN
        -- شکستِ نامربوط (FK، نوع، …) یعنی ادعا چیزی را نسنجیده.
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
        RAISE EXCEPTION '  ✗ % (%) نه از بابت نگهبان شکست: %', r.kind, r.label, v_msg;
    END;
  END LOOP;

  IF v_bad > 0 THEN
    RAISE EXCEPTION E'\n  ✗ % درجِ بی‌مرجع قبول شد', v_bad;
  END IF;
  RAISE NOTICE '  ✓ هر % ترکیبِ بی‌مرجع رد شد', v_ok;
END $$;

\echo '── ۲. حرکت با مرجع کامل قبول می‌شود (کنترل مثبت) ──'
-- بی این بند، قیدی که **همیشه** خطا بدهد هم «پاس» می‌شد و کل فروش را
-- می‌شکست.
INSERT INTO inventory.stock_movement
  (variation_id, warehouse_id, qty, value_delta, kind, ref_type, ref_id)
SELECT var, wh, 5, 5000, 'purchase_receipt', 'receipt',
       '00000000-0000-7000-8000-0000000000bb'
  FROM t;

SELECT pg_temp.assert_eq('حرکت با مرجع کامل ثبت شد',
  (SELECT count(*) FROM inventory.stock_movement m JOIN t ON t.var = m.variation_id
    WHERE m.kind = 'purchase_receipt'), 1);

\echo '── ۳. کنترل منفی: opening بی مرجع باید قبول شود ──'
-- ⚠️ این بند حذف نمی‌شود. واردات اولیه عمداً `NULL, NULL` می‌فرستد
--    (`apps/api/src/import/run.ts`) چون سند افتتاحیهٔ دفتر **پس از**
--    حرکت‌ها ساخته می‌شود و شناسه‌اش هنوز وجود ندارد. اگر روزی کسی
--    استثنا را بردارد، مهاجرت دادهٔ واقعی می‌شکست — و این تنها جایی
--    است که پیش از آن روز خبر می‌دهد.
INSERT INTO inventory.stock_movement
  (variation_id, warehouse_id, qty, value_delta, kind, ref_type, ref_id)
SELECT var, wh, 10, 10000, 'opening', NULL, NULL FROM t;

SELECT pg_temp.assert_eq('opening بی مرجع قبول شد',
  (SELECT count(*) FROM inventory.stock_movement m JOIN t ON t.var = m.variation_id
    WHERE m.kind = 'opening'), 1);

\echo '── ۴. قید در کاتالوگ هست و NOT VALID نیست ──'
-- `NOT VALID` یعنی سطرهای گذشته سنجیده نشده‌اند — یعنی همان چیزی که
-- قید قرار بود بگیرد، در تاریخچه می‌ماند و کسی خبردار نمی‌شود.
SELECT pg_temp.assert_eq('قید موجود و معتبر (convalidated)',
  (SELECT count(*) FROM pg_constraint
    WHERE conname = 'stock_movement_ref_required' AND convalidated), 1);

\echo '── ۵. دروازهٔ قانونی همچنان مرجع را خودش پر می‌کند ──'
-- ادعای رفتاری، نه ساختاری: `apply_movement` نباید برای عبور از قید
-- تازه، به فراخوانِ بیرونی تکیه کند.
SELECT inventory.apply_movement(
  (SELECT var FROM t), (SELECT wh FROM t), 2, 'purchase_receipt',
  'receipt', '00000000-0000-7000-8000-0000000000cc'::uuid,
  NULL, 1000);

SELECT pg_temp.assert_eq('حرکتِ ساختهٔ دروازه، مرجع دارد',
  (SELECT count(*) FROM inventory.stock_movement m JOIN t ON t.var = m.variation_id
    WHERE m.ref_id = '00000000-0000-7000-8000-0000000000cc'
      AND m.ref_type IS NOT NULL), 1);

\echo '── ۶. لایهٔ دوم: با Trigger خاموش، CHECK هنوز می‌گیرد ──'
-- ⚠️ بی این بند، `CHECK` یک تزئین بود: Trigger همیشه زودتر شلیک می‌کند،
--    پس هیچ ادعایی هرگز به آن نمی‌رسید و یک `DROP CONSTRAINT` سهوی
--    **بی‌صدا** از همهٔ تست‌ها رد می‌شد. Trigger را می‌شود خاموش کرد،
--    `CHECK` را نه — و همین تفاوت، دلیل وجود هر دو است.
ALTER TABLE inventory.stock_movement DISABLE TRIGGER movement_ref_guard_t;
DO $$
DECLARE v_state text;
BEGIN
  BEGIN
    INSERT INTO inventory.stock_movement
      (variation_id, warehouse_id, qty, value_delta, kind, ref_type, ref_id)
    SELECT var, wh, 1, 0, 'sale', NULL, NULL FROM t;
    RAISE EXCEPTION '  ✗ با Trigger خاموش، درج بی‌مرجع قبول شد — CHECK کار نمی‌کند';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '  ✓ CHECK مستقل از Trigger، درج بی‌مرجع را رد کرد';
  END;
END $$;
ALTER TABLE inventory.stock_movement ENABLE TRIGGER movement_ref_guard_t;

\echo ''
\echo '╔══════════════════════════════════════╗'
\echo '║   مرجع حرکت انبار پاس شد            ║'
\echo '╚══════════════════════════════════════╝'

ROLLBACK;
