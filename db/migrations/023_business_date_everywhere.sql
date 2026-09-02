-- =====================================================================
-- ۰۲۳ — «امروز» همه‌جا یک تعریف دارد
-- =====================================================================
-- مهاجرت ۰۱۴ تابع `platform.business_date()` را آورد و گفت: «امروز»
-- از تنظیم `platform.timezone` می‌آید، نه از منطقه زمانی سرور. ولی سه
-- جا از قلم افتاده بودند و هنوز `current_date` می‌خواندند — یعنی ساعت
-- سرور.
--
-- روی هاست ابری، ساعت سرور معمولاً UTC است. تهران +۳:۳۰ است، پس هر
-- شب از **۲۰:۳۰ تا ۲۴:۰۰ به وقت UTC** این دو یک روز اختلاف دارند.
--
-- ── سه جایی که اثر داشت ─────────────────────────────────────────────
--
-- **۱. قاعده «PIN همان روز»** (`identity.pin_allowed`)
--    صندوق‌دار ساعت ۲۳:۰۰ رمز کامل می‌زند. ساعت ۰۱:۰۰ بامدادِ **فردا**
--    با PIN باز می‌کند و سیستم قبول می‌کند، چون به وقت UTC هنوز همان
--    روز است. بند ۱ SECURITY.md می‌گوید PIN فقط پس از یک ورود کامل
--    «در همان روز» فعال است — و روز عوض شده.
--
--    در جهت عکس هم بود: ورود ۰۲:۰۰ تهران و PIN ساعت ۰۵:۰۰ همان روزِ
--    تهران، رد می‌شد. صندوق‌دار وسط شیفت بی‌دلیل بیرون می‌افتاد.
--
-- **۲. تاریخ رویداد چک** (`treasury.post_cheque_event`)
--    چکی که ساعت ۰۱:۳۰ بامداد ۳ شهریور وصول می‌شود، **۲ شهریور** ثبت
--    می‌شد. یک سند مالی با تاریخ اشتباه.
--
-- **۳. نمای سررسید چک** (`treasury.cheque_due`)
--    چکی که امروز سررسید دارد، «۱ روز مانده» نشان می‌داد.
--
-- ── چرا اصلاحش خودبه‌خود قابل تنظیم می‌شود ──────────────────────────
--
-- `platform.business_date()` منطقه زمانی را از `platform.timezone`
-- می‌خواند، و آن یک تنظیم عادی است که از صفحه عوض می‌شود و مقدارش در
-- برابر `pg_timezone_names` سنجیده می‌شود. پس اگر روزی سرور عوض شود
-- یا کسب‌وکار جای دیگری برود، یک `UPDATE` در تنظیمات کافی است — نه
-- یک مهاجرت تازه.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. PIN — «همان روز» به وقت کسب‌وکار
-- ---------------------------------------------------------------------
-- کل تابع دوباره تعریف می‌شود (نسخه معتبر همیشه آخرین تعریف است).
-- تنها تفاوت با نسخه ۰۰۷، همان یک شرط تاریخ است.

CREATE OR REPLACE FUNCTION identity.pin_allowed(
  p_user uuid, p_device uuid, p_secret_hash text
) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE d identity.device%ROWTYPE;
BEGIN
  IF p_user IS NULL OR p_device IS NULL THEN RETURN false; END IF;

  SELECT * INTO d FROM identity.device WHERE id = p_device;
  IF NOT FOUND OR NOT d.is_approved THEN RETURN false; END IF;

  -- دستگاه باید ثبت‌نام شده باشد و راز درست را ارائه کند
  IF d.secret_hash IS NULL THEN RETURN false; END IF;
  IF p_secret_hash IS NULL OR p_secret_hash <> d.secret_hash THEN RETURN false; END IF;

  IF identity.is_locked(p_user, p_device, 'pin') THEN RETURN false; END IF;

  -- ورود کامل امروز روی همین دستگاه — و «امروز» به وقت کسب‌وکار.
  --
  -- پیش از این `at::date = current_date` بود، یعنی ساعت سرور. روی
  -- سرور UTC، صندوق‌داری که ۲۳:۰۰ تهران وارد شده بود، ۰۱:۰۰ بامدادِ
  -- فردا هم با PIN باز می‌کرد.
  PERFORM 1 FROM identity.auth_attempt
   WHERE user_id = p_user AND device_id = p_device
     AND kind IN ('password','totp','webauthn') AND succeeded
     AND platform.business_date(at) = platform.business_date()
   LIMIT 1;
  RETURN FOUND;
END $$;

-- ---------------------------------------------------------------------
-- ۲. تاریخ رویداد چک
-- ---------------------------------------------------------------------
-- فقط پیش‌فرض `p_on` عوض می‌شود. فراخوانی که تاریخ صریح می‌دهد
-- دست‌نخورده می‌ماند — او خودش می‌داند چه می‌خواهد.
--
-- کل تابع کپی نمی‌شود: یک تابع پوششی هم غلط بود (دو مسیر برای یک
-- کار). به‌جایش پیش‌فرض در امضا عوض می‌شود، که تنها جای درستش است.

-- کل تابع دوباره تعریف می‌شود، عیناً مثل نسخه ۰۰۵ — تنها تفاوت،
-- `current_date` که جایش `platform.business_date()` نشسته. تابع
-- پوششی غلط بود: دو مسیر برای یک کار می‌ساخت.
--
-- فراخوانی که تاریخ صریح می‌دهد دست‌نخورده می‌ماند؛ فقط **پیش‌فرض**
-- عوض شده.

CREATE OR REPLACE FUNCTION treasury.post_cheque_event(
  p_cheque   uuid,
  p_action   text,
  p_user     uuid DEFAULT NULL,
  p_account  uuid DEFAULT NULL,   -- حساب بانکی: واگذاری، وصول، پاس‌شدن
  p_party_id uuid DEFAULT NULL,   -- تأمین‌کننده گیرنده، هنگام خرج‌کردن
  p_on       date DEFAULT NULL,   -- تاریخ رویداد، پیش‌فرض امروز
  p_note     text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  c        treasury.cheque%ROWTYPE;
  acct     treasury.account%ROWTYPE;
  v_to     text;
  v_event  text;
  v_legs   jsonb;
  v_entry  uuid;
  v_fy     smallint;
  v_seq    smallint;
  v_on     date;
  v_endorsee uuid;
  v_allow  boolean;
  v_max_days int;
  v_number text;
BEGIN
  SELECT * INTO c FROM treasury.cheque WHERE id = p_cheque FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'چک یافت نشد'; END IF;

  v_on := coalesce(p_on, platform.business_date());

  -- ---------------- ماشین وضعیت ----------------
  IF c.direction = 'received' THEN
    v_to := CASE
      WHEN p_action = 'receive' AND c.status = 'draft'                      THEN 'in_hand'
      WHEN p_action = 'deposit' AND c.status = 'in_hand'                    THEN 'deposited'
      WHEN p_action = 'clear'   AND c.status = 'deposited'                  THEN 'cleared'
      WHEN p_action = 'bounce'  AND c.status IN ('deposited','endorsed')    THEN 'bounced'
      WHEN p_action = 'endorse' AND c.status = 'in_hand'                    THEN 'endorsed'
      WHEN p_action = 'settle'  AND c.status = 'bounced'                    THEN 'settled'
      WHEN p_action = 'cancel'  AND c.status = 'draft'                      THEN 'cancelled'
    END;
  ELSE  -- issued
    v_to := CASE
      WHEN p_action = 'issue'  AND c.status = 'draft'                       THEN 'issued'
      WHEN p_action = 'pay'    AND c.status = 'issued'                      THEN 'cleared'
      WHEN p_action = 'bounce' AND c.status = 'issued'                      THEN 'bounced'
      WHEN p_action = 'cancel' AND c.status IN ('draft','issued')           THEN 'cancelled'
    END;
  END IF;

  -- Idempotency: تکرار همان عمل روی وضعیتی که قبلاً به آن رسیده،
  -- سند دوم نمی‌سازد. Retry لایه API نباید دفتر را دو بار بزند.
  IF v_to IS NULL THEN
    SELECT entry_id INTO v_entry FROM treasury.cheque_event
     WHERE cheque_id = p_cheque AND action = p_action AND to_status = c.status
     ORDER BY seq DESC LIMIT 1;
    IF FOUND THEN RETURN v_entry; END IF;

    RAISE EXCEPTION
      'عمل «%» روی چک % با وضعیت «%» مجاز نیست', p_action, c.cheque_no, c.status;
  END IF;

  -- ---------------- اعتبارسنجی ورودی ----------------
  IF p_action IN ('deposit','clear','pay') THEN
    -- وصول و پاس‌شدنِ چک پرداختی از حساب بانکی خودِ چک انجام می‌شود
    IF p_action = 'pay' AND p_account IS NULL THEN
      SELECT * INTO acct FROM treasury.account WHERE id = c.bank_account_id;
    ELSIF p_action = 'clear' AND p_account IS NULL THEN
      SELECT * INTO acct FROM treasury.account WHERE id = c.deposit_account_id;
    ELSE
      SELECT * INTO acct FROM treasury.account WHERE id = p_account;
    END IF;

    IF acct.id IS NULL THEN
      RAISE EXCEPTION 'حساب بانکی برای عمل «%» روی چک % تعیین نشده است', p_action, c.cheque_no;
    END IF;
    IF acct.kind <> 'bank' THEN
      RAISE EXCEPTION
        'چک فقط به حساب بانکی می‌نشیند، نه به % (حساب %)', acct.kind, acct.code;
    END IF;
  END IF;

  -- وعده بلند یک ریسک اعتباری است، نه یک جزئیات. سقفش داده است نه کد.
  IF p_action IN ('receive','issue') THEN
    SELECT (value)::int INTO v_max_days FROM platform.setting WHERE key = 'cheque.max_due_days';
    IF v_max_days IS NOT NULL AND (c.due_on - c.issued_on) > v_max_days THEN
      RAISE EXCEPTION
        'وعده چک % برابر % روز است و از سقف % روز می‌گذرد (تنظیم cheque.max_due_days). نیازمند تصمیم صریح مدیر.',
        c.cheque_no, c.due_on - c.issued_on, v_max_days;
    END IF;
  END IF;

  IF p_action = 'endorse' THEN
    SELECT (value)::boolean INTO v_allow FROM platform.setting WHERE key = 'cheque.allow_endorse';
    IF NOT coalesce(v_allow, false) THEN
      RAISE EXCEPTION
        'خرج‌کردن چک دریافتی خاموش است (تنظیم cheque.allow_endorse). این تصمیم حسابدار است، نه کد.';
    END IF;
    IF p_party_id IS NULL THEN
      RAISE EXCEPTION 'خرج‌کردن چک بدون تأمین‌کننده گیرنده ممکن نیست';
    END IF;
    PERFORM 1 FROM purchasing.supplier WHERE id = p_party_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'تأمین‌کننده گیرنده چک یافت نشد'; END IF;
  END IF;

  -- ---------------- ساخت سند ----------------
  v_event := NULL; v_legs := NULL;

  IF c.direction = 'received' THEN
    IF p_action = 'receive' THEN
      v_event := 'cheque_receive';
      v_legs := jsonb_build_array(
        jsonb_build_object('leg','cheque_in_hand','amount', c.amount,
                           'party_type', c.party_type, 'party_id', c.party_id),
        jsonb_build_object('leg','receivable','amount', c.amount,
                           'party_type', c.party_type, 'party_id', c.party_id));

    ELSIF p_action = 'deposit' THEN
      v_event := 'cheque_deposit';
      v_legs := jsonb_build_array(
        jsonb_build_object('leg','in_collection','amount', c.amount,
                           'party_type', c.party_type, 'party_id', c.party_id),
        jsonb_build_object('leg','cheque_in_hand','amount', c.amount,
                           'party_type', c.party_type, 'party_id', c.party_id));

    ELSIF p_action = 'clear' THEN
      v_event := 'cheque_clear';
      v_legs := jsonb_build_array(
        jsonb_build_object('leg','bank','amount', c.amount,
                           'account_code', acct.ledger_account_code),
        jsonb_build_object('leg','in_collection','amount', c.amount,
                           'party_type', c.party_type, 'party_id', c.party_id));

    ELSIF p_action = 'endorse' THEN
      v_event := 'cheque_endorse';
      v_legs := jsonb_build_array(
        jsonb_build_object('leg','payable','amount', c.amount,
                           'party_type','supplier','party_id', p_party_id),
        jsonb_build_object('leg','cheque_in_hand','amount', c.amount,
                           'party_type', c.party_type, 'party_id', c.party_id));

    ELSIF p_action = 'bounce' THEN
      v_event := 'cheque_bounce';
      IF c.status = 'deposited' THEN
        -- از جریان وصول برمی‌گردد
        v_legs := jsonb_build_array(
          jsonb_build_object('leg','returned','amount', c.amount,
                             'party_type', c.party_type, 'party_id', c.party_id),
          jsonb_build_object('leg','in_collection','amount', c.amount,
                             'party_type', c.party_type, 'party_id', c.party_id));
      ELSE
        -- خرج‌شده بود و تأمین‌کننده پسش داده: بدهی به او زنده می‌شود
        SELECT party_id INTO v_endorsee FROM treasury.cheque_event
         WHERE cheque_id = p_cheque AND action = 'endorse' ORDER BY seq DESC LIMIT 1;
        IF v_endorsee IS NULL THEN
          RAISE EXCEPTION 'چک خرج‌شده بدون رویداد خرج‌کردن — زنجیره رویداد ناقص است';
        END IF;
        v_legs := jsonb_build_array(
          jsonb_build_object('leg','returned','amount', c.amount,
                             'party_type', c.party_type, 'party_id', c.party_id),
          jsonb_build_object('leg','payable_back','amount', c.amount,
                             'party_type','supplier','party_id', v_endorsee));
      END IF;

    ELSIF p_action = 'settle' THEN
      v_event := 'cheque_bounce_settle';
      v_legs := jsonb_build_array(
        jsonb_build_object('leg','receivable','amount', c.amount,
                           'party_type', c.party_type, 'party_id', c.party_id),
        jsonb_build_object('leg','returned','amount', c.amount,
                           'party_type', c.party_type, 'party_id', c.party_id));
    END IF;
    -- cancel روی draft: سندی زده نشده که معکوس شود

  ELSE  -- issued
    IF p_action = 'issue' THEN
      v_event := 'cheque_issue';
      v_legs := jsonb_build_array(
        jsonb_build_object('leg','payable','amount', c.amount,
                           'party_type', c.party_type, 'party_id', c.party_id),
        jsonb_build_object('leg','cheque_payable','amount', c.amount,
                           'party_type', c.party_type, 'party_id', c.party_id));

    ELSIF p_action = 'pay' THEN
      v_event := 'cheque_pay';
      v_legs := jsonb_build_array(
        jsonb_build_object('leg','cheque_payable','amount', c.amount,
                           'party_type', c.party_type, 'party_id', c.party_id),
        jsonb_build_object('leg','bank','amount', c.amount,
                           'account_code', acct.ledger_account_code));

    ELSIF p_action = 'cancel' AND c.status = 'issued' THEN
      -- ابطال چک صادرشده: بدهی از «اسناد پرداختنی» به «پرداختنی تجاری» برمی‌گردد
      v_event := 'cheque_cancel_issued';
      v_legs := jsonb_build_array(
        jsonb_build_object('leg','cheque_payable','amount', c.amount,
                           'party_type', c.party_type, 'party_id', c.party_id),
        jsonb_build_object('leg','payable','amount', c.amount,
                           'party_type', c.party_type, 'party_id', c.party_id));
    END IF;
    -- bounce روی چک پرداختی: بدهی جابه‌جا نمی‌شود، پس سند ندارد
  END IF;

  IF v_event IS NOT NULL THEN
    SELECT id INTO v_fy FROM ledger.fiscal_year WHERE v_on BETWEEN starts_on AND ends_on;
    IF v_fy IS NULL THEN
      RAISE EXCEPTION 'سال مالی برای تاریخ % تعریف نشده است', v_on;
    END IF;

    v_entry := ledger.post_entry(
      v_event, c.branch_id, v_on,
      'چک ' || c.cheque_no || ' — ' || v_event || coalesce(' — ' || p_note, ''),
      v_legs, 'treasury_cheque', p_cheque, p_user);
  END IF;

  -- ---------------- ثبت رویداد و وضعیت ----------------
  SELECT coalesce(max(seq), 0) + 1 INTO v_seq FROM treasury.cheque_event WHERE cheque_id = p_cheque;

  INSERT INTO treasury.cheque_event
    (cheque_id, seq, action, from_status, to_status, occurred_on, amount,
     entry_id, account_id, party_type, party_id, note, created_by)
  VALUES
    (p_cheque, v_seq, p_action, c.status, v_to, v_on, c.amount,
     v_entry, acct.id,
     CASE WHEN p_action IN ('endorse') THEN 'supplier' ELSE c.party_type END,
     coalesce(p_party_id, c.party_id), p_note, p_user);

  -- شماره سند داخلی در اولین رویدادِ دارای سند تخصیص می‌یابد.
  -- تخصیص صریح است و نه داخل COALESCE: next_document_no یک تابع Volatile
  -- با اثر جانبی است و تکیه بر ترتیب ارزیابی COALESCE می‌تواند شمارنده
  -- را بی‌صدا جلو ببرد — یعنی همان پرش شماره‌ای که قاعده منع کرده.
  v_number := c.number;
  IF v_number IS NULL AND v_entry IS NOT NULL THEN
    v_number := platform.next_document_no(c.branch_id, 'cheque', v_fy);
  END IF;

  UPDATE treasury.cheque
     SET status = v_to,
         number = v_number,
         deposit_account_id = CASE WHEN p_action = 'deposit'
                                   THEN acct.id ELSE deposit_account_id END
   WHERE id = p_cheque;

  PERFORM platform.audit('cheque.' || p_action, 'treasury_cheque', p_cheque::text,
    jsonb_build_object('cheque_no', c.cheque_no, 'direction', c.direction,
                       'amount', c.amount, 'from', c.status, 'to', v_to,
                       'entry', v_entry),
    p_user, p_note);

  RETURN v_entry;
END $$;

-- ---------------------------------------------------------------------
-- ۳. نمای سررسید چک
-- ---------------------------------------------------------------------
-- «چند روز مانده» و «سررسید گذشته» باید از تقویم کسب‌وکار حساب شوند،
-- وگرنه هشدار شبانه یک روز جابه‌جا می‌شود.

CREATE OR REPLACE VIEW treasury.cheque_due AS
SELECT c.id, c.number, c.direction, c.cheque_no, c.sayad_id, c.bank_name,
       c.amount, c.due_on, c.status, c.party_type, c.party_id,
       coalesce(cu.full_name, sp.name, c.drawer_name) AS party_name,
       c.due_on - platform.business_date() AS days_left,
       CASE
         WHEN c.due_on < platform.business_date() THEN 'overdue'
         WHEN c.due_on <= platform.business_date()
              + ((SELECT value FROM platform.setting
                   WHERE key = 'cheque.due_warning_days')::int) THEN 'due_soon'
         ELSE 'future'
       END AS urgency
  FROM treasury.cheque c
  LEFT JOIN sales.customer      cu ON c.party_type = 'customer' AND cu.id = c.party_id
  LEFT JOIN purchasing.supplier sp ON c.party_type = 'supplier' AND sp.id = c.party_id
 WHERE c.status IN ('in_hand','deposited','issued','endorsed');

COMMIT;
