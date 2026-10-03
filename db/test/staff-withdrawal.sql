-- =====================================================================
-- تست دفتر برداشت پرسنل — مهاجرت ۰۸۴
-- =====================================================================
-- ادعاها:
--   ۱. مالک و زمان از سرور می‌آیند؛ ثبت به نام دیگری حتی با INSERT
--      مستقیم رد می‌شود.
--   ۲. هر دو جدول فقط درج‌شدنی‌اند (UPDATE/DELETE/TRUNCATE).
--   ۳. اصلاح فقط با `withdrawal.correct`، در دامنهٔ
--      شعبه، با دلیل، و با شرط نسخه؛ صفر مجاز.
--   ۴. هر نسخه یک سطر حسابرسی با «پیش» و «پس» دارد.
--   ۵. **هیچ اثری** بر دفتر، انبار، خزانه، صف پیام یا شیفت ندارد —
--      شمارش پیش و پس، نه یک فرض.
--   کنترل مثبت: مسیر درست واقعاً ثبت و اصلاح می‌کند؛ بی آن، نگهبانی که
--   همه‌چیز را رد کند هم «پاس» می‌شد.
-- =====================================================================

\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_eq(
  p_label text, p_actual text, p_expected text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION E'\n  ✗ %\n      انتظار: %\n      واقعی : %', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE '  ✓ % = %', p_label, p_actual;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.assert_raises(
  p_label text, p_sql text, p_like text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    IF p_like IS NOT NULL AND SQLERRM NOT LIKE '%' || p_like || '%' THEN
      RAISE EXCEPTION E'\n  ✗ %\n      انتظار خطای شامل: %\n      واقعی : %', p_label, p_like, SQLERRM;
    END IF;
    RAISE NOTICE '  ✓ % → %', p_label, left(SQLERRM, 90);
    RETURN;
  END;
  RAISE EXCEPTION E'\n  ✗ %\n      انتظار: خطا\n      واقعی : بدون خطا اجرا شد', p_label;
END $$;

-- اثر مالی: هر جدولی که پول، کالا یا صف را حرکت می‌دهد.
CREATE OR REPLACE FUNCTION pg_temp.financial_footprint() RETURNS text
LANGUAGE sql AS $$
  SELECT concat_ws('|',
    (SELECT count(*) FROM ledger.journal_entry),
    (SELECT count(*) FROM ledger.journal_line),
    (SELECT count(*) FROM inventory.stock_movement),
    (SELECT count(*) FROM inventory.stock_balance),
    (SELECT count(*) FROM treasury.transaction),
    (SELECT count(*) FROM treasury.payment),
    (SELECT count(*) FROM sales.cash_shift),
    (SELECT count(*) FROM platform.outbox_message))
$$;

DO $test$
DECLARE
  A  uuid := '00000000-0000-7000-8000-000000000001';
  B  uuid;
  v_cash uuid; v_cash_b uuid; v_gm uuid; v_gm_a uuid; v_acc uuid; v_off uuid;
  v_w uuid; v_w2 uuid; v_wb uuid; v_wg uuid; v_n int; v_txt text; v_before text; v_ver int;
BEGIN
  v_before := pg_temp.financial_footprint();

  INSERT INTO platform.branch (code, name) VALUES ('wd-b', 'شعبهٔ دوم آزمون برداشت') RETURNING id INTO B;
  INSERT INTO identity.app_user (username, full_name) VALUES ('wd_cash','صندوق‌دار برداشت') RETURNING id INTO v_cash;
  INSERT INTO identity.app_user (username, full_name) VALUES ('wd_cash_b','صندوق‌دار شعبهٔ دوم') RETURNING id INTO v_cash_b;
  INSERT INTO identity.app_user (username, full_name) VALUES ('wd_gm','مدیر کل همهٔ شعب') RETURNING id INTO v_gm;
  INSERT INTO identity.app_user (username, full_name) VALUES ('wd_gm_a','مدیر کل شعبهٔ اصلی') RETURNING id INTO v_gm_a;
  INSERT INTO identity.app_user (username, full_name) VALUES ('wd_acc','حسابدار برداشت') RETURNING id INTO v_acc;
  INSERT INTO identity.app_user (username, full_name, is_active) VALUES ('wd_off','کاربر غیرفعال', false) RETURNING id INTO v_off;
  INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES
    (v_cash,'cashier',A), (v_cash_b,'cashier',B), (v_gm,'admin',NULL), (v_gm_a,'admin',A),
    (v_acc,'accountant',NULL), (v_off,'cashier',A);

  -- ═══════════════════════════════════════════════════════════════════
  RAISE NOTICE E'\n═══ ۱. ثبت: مالک، شعبه و زمان از سرور ═══';
  -- ═══════════════════════════════════════════════════════════════════
  PERFORM platform.set_actor(v_cash);
  v_w := identity.record_withdrawal(1500000, '  پیش‌پرداخت کرایه  ');
  PERFORM pg_temp.assert_eq('مالک = عامل', (SELECT owner_id::text FROM identity.staff_withdrawal WHERE id=v_w), v_cash::text);
  PERFORM pg_temp.assert_eq('شعبه از نقش', (SELECT branch_id::text FROM identity.staff_withdrawal WHERE id=v_w), A::text);
  PERFORM pg_temp.assert_eq('نسخهٔ نخست', (SELECT version||'/'||amount||'/'||reason FROM identity.staff_withdrawal_current WHERE id=v_w),
    '1/1500000/پیش‌پرداخت کرایه');
  PERFORM pg_temp.assert_eq('حسابرسی ثبت',
    (SELECT count(*)::text FROM platform.audit_log WHERE action='withdrawal.create' AND entity_id=v_w::text
        AND actor_id=v_cash AND before IS NULL AND after->>'amount'='1500000'), '1');

  PERFORM platform.set_actor(v_cash_b);
  v_wb := identity.record_withdrawal(200000, 'شعبهٔ دوم');
  PERFORM pg_temp.assert_eq('شعبهٔ دوم از نقش', (SELECT branch_id::text FROM identity.staff_withdrawal WHERE id=v_wb), B::text);
  PERFORM platform.set_actor(v_acc);
  v_wg := identity.record_withdrawal(300000, 'حسابدار سراسری');
  PERFORM pg_temp.assert_eq('نقش همهٔ شعب → سراسری', (SELECT coalesce(branch_id::text,'NULL') FROM identity.staff_withdrawal WHERE id=v_wg), 'NULL');

  PERFORM platform.set_actor(v_cash);
  PERFORM pg_temp.assert_raises('مبلغ صفر در ثبت', 'SELECT identity.record_withdrawal(0, ''x'')', 'بیشتر از صفر');
  PERFORM pg_temp.assert_raises('مبلغ منفی در ثبت', 'SELECT identity.record_withdrawal(-10, ''x'')', 'بیشتر از صفر');
  PERFORM pg_temp.assert_raises('دلیل خالی', 'SELECT identity.record_withdrawal(10, ''   '')', 'دلیل');
  PERFORM pg_temp.assert_raises('INSERT مستقیم به نام دیگری',
    format('INSERT INTO identity.staff_withdrawal(owner_id, branch_id) VALUES (%L, %L)', v_gm, A), 'خودِ کاربر');
  PERFORM pg_temp.assert_raises('INSERT مستقیم با شعبهٔ دلخواه',
    format('INSERT INTO identity.staff_withdrawal(owner_id, branch_id) VALUES (%L, %L)', v_cash, B), 'شعبهٔ ثبت');
  PERFORM pg_temp.assert_raises('نسخهٔ ۱ برای ثبت دیگری',
    format('INSERT INTO identity.staff_withdrawal_revision(withdrawal_id,version,amount,reason,actor_id) VALUES (%L,1,5,''x'',%L)', v_w, v_cash),
    'نسخهٔ نخست');
  PERFORM pg_temp.assert_raises('عامل جعلی در نسخه',
    format('INSERT INTO identity.staff_withdrawal_revision(withdrawal_id,version,amount,reason,note,actor_id) VALUES (%L,2,5,''x'',''y'',%L)', v_w, v_gm),
    'عامل نسخه');

  PERFORM platform.set_actor(v_off);
  PERFORM pg_temp.assert_raises('کاربر غیرفعال', 'SELECT identity.record_withdrawal(10, ''x'')', 'غیرفعال');
  PERFORM set_config('labelmod.actor_id', '', true);
  PERFORM pg_temp.assert_raises('بی کاربر عامل', 'SELECT identity.record_withdrawal(10, ''x'')', 'عامل');

  -- ═══════════════════════════════════════════════════════════════════
  RAISE NOTICE E'\n═══ ۲. تغییرناپذیری ═══';
  -- ═══════════════════════════════════════════════════════════════════
  PERFORM platform.set_actor(v_gm);
  PERFORM pg_temp.assert_raises('UPDATE سرآیند', format('UPDATE identity.staff_withdrawal SET owner_id=%L WHERE id=%L', v_gm, v_w), 'فقط قابل درج');
  PERFORM pg_temp.assert_raises('DELETE سرآیند', format('DELETE FROM identity.staff_withdrawal WHERE id=%L', v_w), 'فقط قابل درج');
  PERFORM pg_temp.assert_raises('UPDATE نسخه', format('UPDATE identity.staff_withdrawal_revision SET amount=0 WHERE withdrawal_id=%L', v_w), 'فقط قابل درج');
  PERFORM pg_temp.assert_raises('DELETE نسخه', format('DELETE FROM identity.staff_withdrawal_revision WHERE withdrawal_id=%L', v_w), 'فقط قابل درج');
  PERFORM pg_temp.assert_raises('TRUNCATE نسخه', 'TRUNCATE identity.staff_withdrawal_revision CASCADE', 'فقط قابل درج');

  -- ═══════════════════════════════════════════════════════════════════
  RAISE NOTICE E'\n═══ ۳. اصلاح مدیر کل ═══';
  -- ═══════════════════════════════════════════════════════════════════
  PERFORM platform.set_actor(v_cash);
  PERFORM pg_temp.assert_raises('مالک بی‌مجوز اصلاح نمی‌کند',
    format('SELECT identity.correct_withdrawal(%L,1,0,''x'',''y'')', v_w), 'withdrawal.correct');
  PERFORM platform.set_actor(v_acc);
  PERFORM pg_temp.assert_raises('حسابدار (مجوز پهن، نه مدیر کل)',
    format('SELECT identity.correct_withdrawal(%L,1,0,''x'',''y'')', v_w), 'withdrawal.correct');

  PERFORM platform.set_actor(v_gm);
  PERFORM pg_temp.assert_raises('اصلاح بی دلیل', format('SELECT identity.correct_withdrawal(%L,1,0,''x'',''  '')', v_w), 'دلیل اصلاح');
  PERFORM pg_temp.assert_raises('اصلاح منفی', format('SELECT identity.correct_withdrawal(%L,1,-1,''x'',''y'')', v_w), 'منفی');
  PERFORM pg_temp.assert_raises('اصلاح بی تغییر',
    format('SELECT identity.correct_withdrawal(%L,1,1500000,''پیش‌پرداخت کرایه'',''y'')', v_w), 'تغییری');
  PERFORM pg_temp.assert_raises('نسخهٔ قدیمی', format('SELECT identity.correct_withdrawal(%L,0,10,''x'',''y'')', v_w), 'قدیمی');

  v_ver := identity.correct_withdrawal(v_w, 1, 0, 'پیش‌پرداخت کرایه', 'ثبت تکراری؛ مبلغ صفر شد');
  PERFORM pg_temp.assert_eq('اصلاح تا صفر (کنترل مثبت)', v_ver::text, '2');
  PERFORM pg_temp.assert_eq('مقدار جاری',
    (SELECT version||'/'||amount||'/'||corrected_by FROM identity.staff_withdrawal_current WHERE id=v_w), '2/0/'||v_gm);
  PERFORM pg_temp.assert_eq('نسخهٔ قبلی دست‌نخورده',
    (SELECT amount||'/'||reason||'/'||actor_id FROM identity.staff_withdrawal_revision WHERE withdrawal_id=v_w AND version=1),
    '1500000/پیش‌پرداخت کرایه/'||v_cash);
  SELECT count(*) INTO v_n FROM platform.audit_log
   WHERE action='withdrawal.correct' AND entity_id=v_w::text AND actor_id=v_gm
     AND before->>'amount'='1500000' AND after->>'amount'='0'
     AND before->>'ownerId'=v_cash::text AND after->>'ownerId'=v_cash::text
     AND reason='ثبت تکراری؛ مبلغ صفر شد';
  PERFORM pg_temp.assert_eq('حسابرسی اصلاح: پیش، پس، مالک، عامل، دلیل', v_n::text, '1');
  PERFORM pg_temp.assert_raises('اصلاح دوباره با نسخهٔ کهنه',
    format('SELECT identity.correct_withdrawal(%L,1,5,''x'',''y'')', v_w), 'قدیمی');
  PERFORM pg_temp.assert_raises('درج مستقیم با پرش نسخه',
    format('INSERT INTO identity.staff_withdrawal_revision(withdrawal_id,version,amount,reason,note,actor_id) VALUES (%L,4,5,''x'',''y'',%L)', v_w, v_gm),
    'قدیمی');
  v_ver := identity.correct_withdrawal(v_w, 2, 700000, 'کرایهٔ پیک', 'مبلغ درست از رسید');
  PERFORM pg_temp.assert_eq('اصلاح دوم', v_ver::text, '3');

  -- مدیر مجاز برداشت خودش را با همان سابقهٔ حسابرسی اصلاح می‌کند.
  v_w2 := identity.record_withdrawal(100000, 'برداشت مدیر');
  PERFORM pg_temp.assert_eq('اصلاح برداشت خود توسط مدیر مجاز', identity.correct_withdrawal(v_w2,1,0,'x','y')::text, '2');

  -- دامنهٔ شعبه: مدیر کل شعبهٔ اصلی نه شعبهٔ دوم را می‌بیند نه سراسری را.
  PERFORM platform.set_actor(v_gm_a);
  PERFORM pg_temp.assert_raises('مدیر شعبه‌ای، ثبت شعبهٔ دیگر',
    format('SELECT identity.correct_withdrawal(%L,1,0,''x'',''y'')', v_wb), 'دامنهٔ شعبه');
  PERFORM pg_temp.assert_raises('مدیر شعبه‌ای، ثبت سراسری',
    format('SELECT identity.correct_withdrawal(%L,1,0,''x'',''y'')', v_wg), 'دامنهٔ شعبه');
  PERFORM pg_temp.assert_eq('مدیر شعبه‌ای، ثبت شعبهٔ خودش',
    identity.correct_withdrawal(v_w, 3, 650000, 'کرایهٔ پیک', 'رسید دوم')::text, '4');
  PERFORM pg_temp.assert_eq('دامنه: سراسری فقط برای همهٔ شعب',
    identity.withdrawal_in_scope(v_gm, NULL)::text || identity.withdrawal_in_scope(v_gm_a, NULL)::text
      || identity.withdrawal_in_scope(v_gm_a, A)::text || identity.withdrawal_in_scope(v_gm_a, B)::text,
    'truefalsetruefalse');

  -- ═══════════════════════════════════════════════════════════════════
  RAISE NOTICE E'\n═══ ۴. مجوزها: فقط مدیر کل ═══';
  -- ═══════════════════════════════════════════════════════════════════
  PERFORM pg_temp.assert_eq('نقش‌های مجاز view_all',
    (SELECT string_agg(role_code, ',' ORDER BY role_code) FROM identity.permission_rule
      WHERE operation='withdrawal.view_all' AND allowed), 'admin');
  PERFORM pg_temp.assert_eq('نقش‌های مجاز correct',
    (SELECT string_agg(role_code, ',' ORDER BY role_code) FROM identity.permission_rule
      WHERE operation='withdrawal.correct' AND allowed), 'admin');

  -- ═══════════════════════════════════════════════════════════════════
  RAISE NOTICE E'\n═══ ۵. هیچ اثر مالی ═══';
  -- ═══════════════════════════════════════════════════════════════════
  PERFORM pg_temp.assert_eq('دفتر، انبار، خزانه، شیفت و صف دست‌نخورده', pg_temp.financial_footprint(), v_before);
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='identity' AND (p.proname LIKE '%withdrawal%')
     AND p.prosrc ~* '(post_entry|apply_movement|treasury\.|ledger\.|inventory\.|outbox)';
  PERFORM pg_temp.assert_eq('هیچ تابع برداشتی به دفتر/انبار/خزانه/صف اشاره نمی‌کند', v_n::text, '0');
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='identity' AND p.proname LIKE '%withdrawal%';
  IF v_n < 7 THEN
    RAISE EXCEPTION 'کنترل مثبت: انتظار دست‌کم ۷ تابع برداشت، دیدم %', v_n;
  END IF;
  RAISE NOTICE '  ✓ کنترل مثبت: % تابع برداشت بررسی شد', v_n;
  SELECT count(*) INTO v_n FROM ledger.posting_rule WHERE event_type ILIKE '%withdraw%';
  PERFORM pg_temp.assert_eq('هیچ قاعدهٔ ثبت برداشتی', v_n::text, '0');
END $test$;

ROLLBACK;
