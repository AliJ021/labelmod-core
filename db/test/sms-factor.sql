\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE u uuid; n integer;
BEGIN
  INSERT INTO identity.app_user(username,full_name) VALUES('sms_sql_test','آزمون عامل پیامکی') RETURNING id INTO u;
  IF identity.needs_second_factor(u) THEN RAISE EXCEPTION 'عامل تأییدنشده نباید فعال باشد'; END IF;
  INSERT INTO identity.sms_challenge(user_id,purpose,binding_hash,mobile,ip,code_hash)
    VALUES(u,'enroll',repeat('a',64),'09120000000','127.0.0.1',repeat('b',64));
  IF identity.needs_second_factor(u) THEN RAISE EXCEPTION 'چالش به‌تنهایی عامل نیست'; END IF;
  SELECT extract(epoch FROM expires_at-created_at)::int INTO n FROM identity.sms_challenge WHERE user_id=u;
  IF n<>120 THEN RAISE EXCEPTION 'عمر کد باید ۱۲۰ ثانیه باشد'; END IF;
  INSERT INTO identity.sms_factor(user_id,mobile) VALUES(u,'09120000000');
  IF NOT identity.needs_second_factor(u) THEN RAISE EXCEPTION 'عامل تأییدشده باید در ورود اعمال شود'; END IF;
  DELETE FROM identity.sms_factor WHERE user_id=u;
  IF identity.needs_second_factor(u) THEN RAISE EXCEPTION 'عامل حذف‌شده نباید در ورود باشد'; END IF;
  UPDATE identity.app_user SET totp_secret='TEST-EXISTING-TOTP' WHERE id=u;
  IF NOT identity.needs_second_factor(u) THEN RAISE EXCEPTION 'TOTP قبلی باید حفظ شود'; END IF;
  RAISE NOTICE '✓ وضعیت عامل پیامکی، عمر چالش و سازگاری TOTP';
END $$;
ROLLBACK;
