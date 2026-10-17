-- =====================================================================
-- تست دفتر پاداش پرسنل — مهاجرت ۰۹۸
-- =====================================================================
-- ادعاها:
--   ۱. درخواست: ذی‌نفع و ثبت‌کننده = عامل؛ شعبه و زمان از سرور؛ INSERT
--      مستقیم به نام دیگری رد می‌شود.
--   ۲. اعطا: فقط با `bonus.manage`، در دامنه، به کارمند فعال، نه به خود.
--   ۳. تصمیم: فقط درخواستِ در انتظار، یک بار، نه درخواست خود؛ رد بی دلیل نه.
--   ۴. تسویه: فقط تأییدشده، یک بار، نه پاداش خود، در دامنه.
--   ۵. هر سه جدول فقط درج‌شدنی‌اند؛ هر گذار یک سطر حسابرسی پیش/پس دارد.
--   ۶. **هیچ اثری** بر دفتر، انبار، خزانه، صف پیام یا شیفت — شمارش پیش و پس.
--   کنترل مثبت: هر دو مسیر واقعاً تا «تسویه‌شده» می‌روند.
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

CREATE OR REPLACE FUNCTION pg_temp.status(p uuid) RETURNS text
LANGUAGE sql AS $$ SELECT status FROM identity.staff_bonus_current WHERE id = p $$;

DO $test$
DECLARE
  A  uuid := '00000000-0000-7000-8000-000000000001';
  B  uuid;
  v_cash uuid; v_cash_b uuid; v_gm uuid; v_gm2 uuid; v_gm_a uuid; v_acc uuid; v_off uuid; v_norole uuid;
  v_r uuid; v_r2 uuid; v_rb uuid; v_rg uuid; v_aw uuid; v_aw_self uuid; v_n int; v_before text;
BEGIN
  v_before := pg_temp.financial_footprint();

  INSERT INTO platform.branch (code, name) VALUES ('bn-b', 'شعبهٔ دوم آزمون پاداش') RETURNING id INTO B;
  INSERT INTO identity.app_user (username, full_name) VALUES ('bn_cash','صندوق‌دار پاداش') RETURNING id INTO v_cash;
  INSERT INTO identity.app_user (username, full_name) VALUES ('bn_cash_b','صندوق‌دار شعبهٔ دوم') RETURNING id INTO v_cash_b;
  INSERT INTO identity.app_user (username, full_name) VALUES ('bn_gm','مدیر کل همهٔ شعب') RETURNING id INTO v_gm;
  INSERT INTO identity.app_user (username, full_name) VALUES ('bn_gm2','مدیر کل دوم') RETURNING id INTO v_gm2;
  INSERT INTO identity.app_user (username, full_name) VALUES ('bn_gm_a','مدیر کل شعبهٔ اصلی') RETURNING id INTO v_gm_a;
  INSERT INTO identity.app_user (username, full_name) VALUES ('bn_acc','حسابدار پاداش') RETURNING id INTO v_acc;
  INSERT INTO identity.app_user (username, full_name, is_active) VALUES ('bn_off','کاربر غیرفعال', false) RETURNING id INTO v_off;
  INSERT INTO identity.app_user (username, full_name) VALUES ('bn_norole','بی نقش') RETURNING id INTO v_norole;
  INSERT INTO identity.user_role (user_id, role_code, branch_id) VALUES
    (v_cash,'cashier',A), (v_cash_b,'cashier',B), (v_gm,'admin',NULL), (v_gm2,'admin',NULL), (v_gm_a,'admin',A),
    (v_acc,'accountant',NULL), (v_off,'cashier',A);

  -- ═══════════════════════════════════════════════════════════════════
  RAISE NOTICE E'\n═══ ۱. درخواست: ذی‌نفع، شعبه و زمان از سرور ═══';
  -- ═══════════════════════════════════════════════════════════════════
  PERFORM platform.set_actor(v_cash);
  v_r := identity.request_bonus(500000, '  فروش بالای ماه  ');
  PERFORM pg_temp.assert_eq('درخواست: مالک/ثبت‌کننده/شعبه/وضعیت',
    (SELECT concat_ws('/', owner_id = v_cash, created_by = v_cash, branch_id, origin, status, amount, reason)
       FROM identity.staff_bonus_current WHERE id = v_r),
    concat_ws('/', true, true, A, 'request', 'pending', 500000, 'فروش بالای ماه'));
  PERFORM pg_temp.assert_eq('حسابرسی درخواست',
    (SELECT count(*)::text FROM platform.audit_log WHERE action='bonus.request' AND entity_id=v_r::text
        AND actor_id=v_cash AND before IS NULL AND after->>'status'='pending' AND after->>'amount'='500000'), '1');
  v_r2 := identity.request_bonus(70000, 'اضافه‌کار');

  PERFORM platform.set_actor(v_cash_b);
  v_rb := identity.request_bonus(200000, 'شعبهٔ دوم');
  PERFORM pg_temp.assert_eq('شعبهٔ دوم از نقش', (SELECT branch_id::text FROM identity.staff_bonus WHERE id=v_rb), B::text);
  PERFORM platform.set_actor(v_acc);
  v_rg := identity.request_bonus(300000, 'حسابدار سراسری');
  PERFORM pg_temp.assert_eq('نقش همهٔ شعب → سراسری', (SELECT coalesce(branch_id::text,'NULL') FROM identity.staff_bonus WHERE id=v_rg), 'NULL');

  PERFORM platform.set_actor(v_cash);
  PERFORM pg_temp.assert_raises('مبلغ صفر', 'SELECT identity.request_bonus(0, ''x'')', 'بیشتر از صفر');
  PERFORM pg_temp.assert_raises('مبلغ منفی', 'SELECT identity.request_bonus(-1, ''x'')', 'بیشتر از صفر');
  PERFORM pg_temp.assert_raises('دلیل خالی', 'SELECT identity.request_bonus(10, ''  '')', 'دلیل');
  PERFORM pg_temp.assert_raises('INSERT مستقیم درخواست به نام دیگری',
    format('INSERT INTO identity.staff_bonus(owner_id,branch_id,origin,amount,reason,created_by) VALUES (%L,%L,''request'',5,''x'',%L)', v_gm, NULL, v_gm),
    'ثبت‌کنندهٔ');
  PERFORM pg_temp.assert_raises('INSERT مستقیم با شعبهٔ دلخواه',
    format('INSERT INTO identity.staff_bonus(owner_id,branch_id,origin,amount,reason,created_by) VALUES (%L,%L,''request'',5,''x'',%L)', v_cash, B, v_cash),
    'شعبهٔ پاداش');
  PERFORM platform.set_actor(v_off);
  PERFORM pg_temp.assert_raises('کاربر غیرفعال', 'SELECT identity.request_bonus(10, ''x'')', 'غیرفعال');
  PERFORM set_config('labelmod.actor_id', '', true);
  PERFORM pg_temp.assert_raises('بی کاربر عامل', 'SELECT identity.request_bonus(10, ''x'')', 'عامل');

  -- ═══════════════════════════════════════════════════════════════════
  RAISE NOTICE E'\n═══ ۲. اعطای مستقیم ═══';
  -- ═══════════════════════════════════════════════════════════════════
  PERFORM platform.set_actor(v_cash);
  PERFORM pg_temp.assert_raises('کارمند بی‌مجوز اعطا نمی‌کند',
    format('SELECT identity.award_bonus(%L, 10, ''x'')', v_cash_b), 'bonus.manage');
  PERFORM pg_temp.assert_raises('کارمند با INSERT مستقیم اعطا نمی‌کند',
    format('INSERT INTO identity.staff_bonus(owner_id,branch_id,origin,amount,reason,created_by) VALUES (%L,%L,''award'',5,''x'',%L)', v_cash_b, B, v_cash),
    'bonus.manage');
  PERFORM platform.set_actor(v_acc);
  PERFORM pg_temp.assert_raises('حسابدار (مجوز پهن) اعطا نمی‌کند',
    format('SELECT identity.award_bonus(%L, 10, ''x'')', v_cash), 'bonus.manage');
  PERFORM platform.set_actor(v_gm);
  PERFORM pg_temp.assert_raises('اعطا به خود', format('SELECT identity.award_bonus(%L, 10, ''x'')', v_gm), 'به خودش');
  PERFORM pg_temp.assert_raises('اعطا به کاربر غیرفعال', format('SELECT identity.award_bonus(%L, 10, ''x'')', v_off), 'فعال');
  PERFORM pg_temp.assert_raises('اعطا به کاربر بی نقش', format('SELECT identity.award_bonus(%L, 10, ''x'')', v_norole), 'فعال');
  PERFORM pg_temp.assert_raises('اعطا بی دلیل', format('SELECT identity.award_bonus(%L, 10, '' '')', v_cash), 'دلیل');
  v_aw := identity.award_bonus(v_cash, 250000, 'رضایت مشتری');
  PERFORM pg_temp.assert_eq('اعطا: تأییدشده از ابتدا',
    (SELECT concat_ws('/', origin, status, owner_id = v_cash, created_by = v_gm, decided_by = v_gm, branch_id)
       FROM identity.staff_bonus_current WHERE id = v_aw), concat_ws('/', 'award', 'approved', true, true, true, A));
  PERFORM pg_temp.assert_eq('حسابرسی اعطا',
    (SELECT count(*)::text FROM platform.audit_log WHERE action='bonus.award' AND entity_id=v_aw::text
        AND actor_id=v_gm AND after->>'ownerId'=v_cash::text AND after->>'status'='approved'), '1');
  PERFORM platform.set_actor(v_gm_a);
  PERFORM pg_temp.assert_raises('مدیر شعبه‌ای به کارمند شعبهٔ دیگر اعطا نمی‌کند',
    format('SELECT identity.award_bonus(%L, 10, ''x'')', v_cash_b), 'دامنهٔ شعبه');
  PERFORM pg_temp.assert_raises('مدیر شعبه‌ای به کارمند سراسری اعطا نمی‌کند',
    format('SELECT identity.award_bonus(%L, 10, ''x'')', v_acc), 'دامنهٔ شعبه');
  PERFORM platform.set_actor(v_gm2);
  v_aw_self := identity.award_bonus(v_gm, 90000, 'پاداش مدیر'); -- اعطای مدیر دیگر به v_gm

  -- ═══════════════════════════════════════════════════════════════════
  RAISE NOTICE E'\n═══ ۳. تصمیم ═══';
  -- ═══════════════════════════════════════════════════════════════════
  PERFORM platform.set_actor(v_cash_b);
  PERFORM pg_temp.assert_raises('کارمند بررسی نمی‌کند',
    format('SELECT identity.decide_bonus(%L,''approved'',NULL)', v_r), 'bonus.manage');
  PERFORM platform.set_actor(v_acc);
  PERFORM pg_temp.assert_raises('حسابدار بررسی نمی‌کند',
    format('SELECT identity.decide_bonus(%L,''approved'',NULL)', v_r), 'bonus.manage');
  PERFORM platform.set_actor(v_gm_a);
  PERFORM pg_temp.assert_raises('مدیر شعبه‌ای، درخواست شعبهٔ دیگر',
    format('SELECT identity.decide_bonus(%L,''approved'',NULL)', v_rb), 'دامنهٔ شما');
  PERFORM platform.set_actor(v_gm);
  PERFORM pg_temp.assert_raises('رد بی دلیل', format('SELECT identity.decide_bonus(%L,''rejected'',''  '')', v_r2), 'دلیل رد');
  PERFORM pg_temp.assert_raises('تصمیم ناشناخته', format('SELECT identity.decide_bonus(%L,''paid'',NULL)', v_r2), 'تأیید یا رد');
  PERFORM pg_temp.assert_raises('بررسی پاداش اعطایی', format('SELECT identity.decide_bonus(%L,''rejected'',''x'')', v_aw), 'بررسی ندارد');
  PERFORM pg_temp.assert_eq('تأیید (کنترل مثبت)', identity.decide_bonus(v_r, 'approved', NULL), 'approved');
  PERFORM pg_temp.assert_eq('وضعیت پس از تأیید', pg_temp.status(v_r), 'approved');
  PERFORM pg_temp.assert_raises('تصمیم دوم', format('SELECT identity.decide_bonus(%L,''rejected'',''x'')', v_r), 'پیش‌تر بررسی');
  PERFORM pg_temp.assert_eq('رد با دلیل', identity.decide_bonus(v_r2, 'rejected', 'خارج از سیاست'), 'rejected');
  PERFORM pg_temp.assert_eq('حسابرسی تصمیم: پیش pending، پس approved/rejected',
    (SELECT string_agg(action||':'||(before->>'status')||'>'||(after->>'status')||':'||coalesce(reason,'-'), ',' ORDER BY action)
       FROM platform.audit_log WHERE entity_id IN (v_r::text, v_r2::text) AND action IN ('bonus.approve','bonus.reject') AND actor_id=v_gm),
    'bonus.approve:pending>approved:-,bonus.reject:pending>rejected:خارج از سیاست');
  -- درخواست خود مدیر: خودش بررسی نمی‌کند، مدیر دیگر می‌کند.
  PERFORM platform.set_actor(v_gm_a);
  v_rg := identity.request_bonus(40000, 'درخواست مدیر شعبه');
  PERFORM pg_temp.assert_raises('بررسی درخواست خود',
    format('SELECT identity.decide_bonus(%L,''approved'',NULL)', v_rg), 'خود را');
  PERFORM platform.set_actor(v_gm);
  PERFORM pg_temp.assert_eq('مدیر دیگر درخواست مدیر را تأیید می‌کند', identity.decide_bonus(v_rg, 'approved', 'تأیید'), 'approved');

  -- ═══════════════════════════════════════════════════════════════════
  RAISE NOTICE E'\n═══ ۴. تسویه ═══';
  -- ═══════════════════════════════════════════════════════════════════
  PERFORM platform.set_actor(v_cash);
  PERFORM pg_temp.assert_raises('کارمند تسویه نمی‌کند',
    format('INSERT INTO identity.staff_bonus_settlement(bonus_id,batch_id,actor_id,note) VALUES (%L,%L,%L,''x'')', v_r, gen_random_uuid(), v_cash),
    'bonus.manage');
  PERFORM platform.set_actor(v_gm);
  PERFORM pg_temp.assert_raises('تسویهٔ درخواست ردشده',
    format('INSERT INTO identity.staff_bonus_settlement(bonus_id,batch_id,actor_id,note) VALUES (%L,%L,%L,''x'')', v_r2, gen_random_uuid(), v_gm),
    'تأییدشده');
  PERFORM pg_temp.assert_raises('تسویهٔ درخواست در انتظار',
    format('INSERT INTO identity.staff_bonus_settlement(bonus_id,batch_id,actor_id,note) VALUES (%L,%L,%L,''x'')', v_rb, gen_random_uuid(), v_gm),
    'تأییدشده');
  PERFORM pg_temp.assert_raises('تسویهٔ پاداش خود',
    format('INSERT INTO identity.staff_bonus_settlement(bonus_id,batch_id,actor_id,note) VALUES (%L,%L,%L,''x'')', v_aw_self, gen_random_uuid(), v_gm),
    'خود را');
  PERFORM pg_temp.assert_raises('عامل جعلی در تسویه',
    format('INSERT INTO identity.staff_bonus_settlement(bonus_id,batch_id,actor_id,note) VALUES (%L,%L,%L,''x'')', v_r, gen_random_uuid(), v_gm2),
    'عامل');
  INSERT INTO identity.staff_bonus_settlement(bonus_id,batch_id,actor_id,note)
  VALUES (v_r, '00000000-0000-7000-8000-00000000b001', v_gm, 'تسویهٔ مهر'),
         (v_aw, '00000000-0000-7000-8000-00000000b001', v_gm, 'تسویهٔ مهر');
  PERFORM pg_temp.assert_eq('هر دو مسیر تسویه‌شده (کنترل مثبت)', pg_temp.status(v_r)||'/'||pg_temp.status(v_aw), 'settled/settled');
  PERFORM pg_temp.assert_raises('تسویهٔ دوباره',
    format('INSERT INTO identity.staff_bonus_settlement(bonus_id,batch_id,actor_id,note) VALUES (%L,%L,%L,''x'')', v_r, gen_random_uuid(), v_gm),
    'پیش‌تر تسویه');
  PERFORM pg_temp.assert_raises('تسویهٔ بعد از تصمیم: تصمیم دوم هم بسته',
    format('SELECT identity.decide_bonus(%L,''rejected'',''x'')', v_r), 'پیش‌تر بررسی');
  PERFORM pg_temp.assert_eq('حسابرسی تسویه',
    (SELECT count(*)::text FROM platform.audit_log WHERE action='bonus.settle' AND entity_id IN (v_r::text, v_aw::text)
        AND before->>'status'='approved' AND after->>'status'='settled' AND reason='تسویهٔ مهر'), '2');
  PERFORM platform.set_actor(v_gm_a);
  PERFORM pg_temp.assert_raises('مدیر شعبه‌ای، تسویهٔ شعبهٔ دیگر',
    format('INSERT INTO identity.staff_bonus_settlement(bonus_id,batch_id,actor_id,note) VALUES (%L,%L,%L,''x'')', v_rb, gen_random_uuid(), v_gm_a),
    'دامنهٔ شما');

  -- ═══════════════════════════════════════════════════════════════════
  RAISE NOTICE E'\n═══ ۵. تغییرناپذیری ═══';
  -- ═══════════════════════════════════════════════════════════════════
  PERFORM platform.set_actor(v_gm);
  PERFORM pg_temp.assert_raises('UPDATE مبلغ', format('UPDATE identity.staff_bonus SET amount=1 WHERE id=%L', v_r), 'فقط قابل درج');
  PERFORM pg_temp.assert_raises('DELETE سرآیند', format('DELETE FROM identity.staff_bonus WHERE id=%L', v_r), 'فقط قابل درج');
  PERFORM pg_temp.assert_raises('UPDATE تصمیم', format('UPDATE identity.staff_bonus_decision SET decision=''rejected'' WHERE bonus_id=%L', v_r), 'فقط قابل درج');
  PERFORM pg_temp.assert_raises('DELETE تصمیم', format('DELETE FROM identity.staff_bonus_decision WHERE bonus_id=%L', v_r), 'فقط قابل درج');
  PERFORM pg_temp.assert_raises('DELETE تسویه', format('DELETE FROM identity.staff_bonus_settlement WHERE bonus_id=%L', v_r), 'فقط قابل درج');
  PERFORM pg_temp.assert_raises('TRUNCATE تسویه', 'TRUNCATE identity.staff_bonus_settlement', 'فقط قابل درج');
  PERFORM pg_temp.assert_raises('TRUNCATE سرآیند', 'TRUNCATE identity.staff_bonus CASCADE', 'فقط قابل درج');

  -- ═══════════════════════════════════════════════════════════════════
  RAISE NOTICE E'\n═══ ۶. مجوزها و هیچ اثر مالی ═══';
  -- ═══════════════════════════════════════════════════════════════════
  PERFORM pg_temp.assert_eq('نقش‌های مجاز view_all',
    (SELECT string_agg(role_code, ',' ORDER BY role_code) FROM identity.permission_rule WHERE operation='bonus.view_all' AND allowed), 'admin');
  PERFORM pg_temp.assert_eq('نقش‌های مجاز manage',
    (SELECT string_agg(role_code, ',' ORDER BY role_code) FROM identity.permission_rule WHERE operation='bonus.manage' AND allowed), 'admin');
  PERFORM pg_temp.assert_eq('ردیف صریح برای هر نقش',
    (SELECT (count(*) = 2 * (SELECT count(*) FROM identity.role))::text FROM identity.permission_rule WHERE operation IN ('bonus.view_all','bonus.manage')), 'true');
  PERFORM pg_temp.assert_eq('دفتر، انبار، خزانه، شیفت و صف دست‌نخورده', pg_temp.financial_footprint(), v_before);
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='identity' AND p.proname LIKE '%bonus%'
     AND p.prosrc ~* '(post_entry|apply_movement|treasury\.|ledger\.|inventory\.|outbox|sales\.)';
  PERFORM pg_temp.assert_eq('هیچ تابع پاداشی به دفتر/انبار/خزانه/فروش/صف اشاره نمی‌کند', v_n::text, '0');
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='identity' AND p.proname LIKE '%bonus%';
  IF v_n < 12 THEN
    RAISE EXCEPTION 'کنترل مثبت: انتظار دست‌کم ۱۲ تابع پاداش، دیدم %', v_n;
  END IF;
  RAISE NOTICE '  ✓ کنترل مثبت: % تابع پاداش بررسی شد', v_n;
  SELECT count(*) INTO v_n FROM ledger.posting_rule WHERE event_type ILIKE '%bonus%' OR event_type ILIKE '%reward%';
  PERFORM pg_temp.assert_eq('هیچ قاعدهٔ ثبت پاداشی', v_n::text, '0');
END $test$;

ROLLBACK;
