-- =====================================================================
-- ۰۱۴ — منطقه زمانی به‌عنوان تنظیم، و کاربر «سیستم» برای کار شبانه
-- =====================================================================
-- دو شکافی که خودمان در بازبینی گفتیم و حالا بسته می‌شوند.
--
-- ## ۱. «امروز» یعنی چه؟
--
-- تا امروز تاریخ کاری از `occurred_at::date` می‌آمد — و `::date` روی
-- `timestamptz` **منطقه زمانی نشست** را به کار می‌برد. یعنی تعریف
-- «امروز» به یک متغیر محیطی سرور بند بود، نه به یک تصمیم ثبت‌شده.
--
-- برای فروشگاهی در تهران این خطرناک است: اگر سرور روی UTC بالا بیاید،
-- سفارش ساعت ۱ بامداد پنجم (= ۲۱:۳۰ UTC چهارم) در دوره **چهارم**
-- می‌افتد. فاکتور و سندش به روز قبل می‌خورد و هیچ‌کس نمی‌فهمد چرا
-- فروش دیشب در گزارش امروز نیست.
--
-- `docker-compose.yml` منطقه را روی `Asia/Tehran` می‌گذارد، ولی آن یک
-- **قرارداد استقرار** است نه یک قاعده سیستم. حالا یک تنظیم است:
-- `platform.timezone`. عوض‌کردنش یک انتخاب از فهرست است و کل سیستم
-- یک‌جا با آن جابه‌جا می‌شود.
--
-- نوع تازه `timezone` مقدار را در برابر `pg_timezone_names` می‌سنجد.
-- بدون آن، یک غلط تایپی در نام منطقه، **هر فروش** را می‌شکست.
--
-- ## ۲. کار شبانه هم باید نام داشته باشد
--
-- هر تابع مالی کاربر عامل می‌خواهد تا سند بی‌صاحب نماند. ساعت ۳
-- بامداد آدمی نیست، پس یک کاربر مخصوص لازم است. ساخته می‌شود ولی
-- **هرگز نمی‌تواند وارد شود**: نه رمز دارد، نه PIN، و `is_active`
-- خاموش است. فقط یک نام است که کنار سند شبانه می‌ماند.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. نوع تازه: منطقه زمانی
-- ---------------------------------------------------------------------

ALTER TABLE platform.setting
  DROP CONSTRAINT setting_kind_ck,
  ADD  CONSTRAINT setting_kind_ck CHECK (kind IN
    ('bool','int','money','percent','choice','multichoice','text','timezone','json'));

CREATE OR REPLACE FUNCTION platform.set_setting(
  p_key    text,
  p_value  jsonb,
  p_reason text DEFAULT NULL,
  p_actor  uuid DEFAULT NULL
) RETURNS platform.setting
LANGUAGE plpgsql AS $$
DECLARE
  s         platform.setting;
  v_actor   uuid;
  v_num     numeric;
  v_text    text;
  v_allowed text[];
  v_el      jsonb;
BEGIN
  v_actor := coalesce(p_actor, platform.current_actor());
  IF v_actor IS NULL THEN
    RAISE EXCEPTION
      'تغییر تنظیمات بدون کاربر عامل مجاز نیست. platform.set_actor() فراخوانی نشده است.';
  END IF;

  SELECT * INTO s FROM platform.setting WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'تنظیم «%» وجود ندارد. کلید تازه فقط از مسیر مهاجرت و seed ساخته می‌شود.', p_key;
  END IF;

  IF NOT s.is_editable THEN
    RAISE EXCEPTION 'تنظیم «%» از این مسیر قابل تغییر نیست.', p_key;
  END IF;

  IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
    RAISE EXCEPTION 'مقدار تنظیم «%» نمی‌تواند خالی باشد.', p_key;
  END IF;

  -- تنظیمی که تصویب حسابدار یا مشاور می‌خواهد، بی‌دلیل عوض نمی‌شود.
  -- «دلیل» تنها چیزی است که شش ماه بعد توضیح می‌دهد چرا نرخ عوض شد.
  IF s.requires_approval AND coalesce(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION
      'تغییر تنظیم «%» نیازمند ثبت دلیل است؛ این تنظیم تصویب مسئول مالی را لازم دارد.', p_key;
  END IF;

  CASE s.kind
    WHEN 'bool' THEN
      IF jsonb_typeof(p_value) <> 'boolean' THEN
        RAISE EXCEPTION 'تنظیم «%» فقط بله یا خیر می‌پذیرد.', p_key;
      END IF;

    WHEN 'int' THEN
      IF jsonb_typeof(p_value) <> 'number' THEN
        RAISE EXCEPTION 'تنظیم «%» فقط عدد صحیح می‌پذیرد.', p_key;
      END IF;
      v_num := (p_value #>> '{}')::numeric;
      IF v_num <> trunc(v_num) THEN
        RAISE EXCEPTION 'تنظیم «%» فقط عدد صحیح می‌پذیرد، نه اعشاری.', p_key;
      END IF;

    WHEN 'percent' THEN
      IF jsonb_typeof(p_value) <> 'number' THEN
        RAISE EXCEPTION 'تنظیم «%» فقط عدد می‌پذیرد (درصد).', p_key;
      END IF;
      v_num := (p_value #>> '{}')::numeric;

    -- پول در JSON **رشته** است، نه عدد. قاعده غیرقابل مذاکره پروژه؛
    -- number جاوااسکریپت مبالغ ریالی بزرگ را بی‌صدا گرد می‌کند.
    WHEN 'money' THEN
      IF jsonb_typeof(p_value) <> 'string' OR (p_value #>> '{}') !~ '^[0-9]+$' THEN
        RAISE EXCEPTION
          'تنظیم «%» مبلغ ریالی است و باید رشته‌ای از ارقام باشد، بدون اعشار.', p_key;
      END IF;
      v_num := (p_value #>> '{}')::numeric;

    WHEN 'text' THEN
      IF jsonb_typeof(p_value) <> 'string' THEN
        RAISE EXCEPTION 'تنظیم «%» فقط متن می‌پذیرد.', p_key;
      END IF;

    -- منطقه زمانی در برابر فهرست خودِ پستگرس سنجیده می‌شود، نه یک
    -- Regex. مقدار نامعتبر اینجا یعنی `AT TIME ZONE` بعداً در **هر
    -- فروش** خطا بدهد — پس باید در لحظه نوشتن گرفته شود، نه در لحظه
    -- استفاده.
    WHEN 'timezone' THEN
      IF jsonb_typeof(p_value) <> 'string' THEN
        RAISE EXCEPTION 'تنظیم «%» باید نام یک منطقه زمانی باشد.', p_key;
      END IF;
      v_text := p_value #>> '{}';
      IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = v_text) THEN
        RAISE EXCEPTION
          'منطقه زمانی «%» شناخته‌شده نیست. نمونه معتبر: Asia/Tehran', v_text;
      END IF;

    WHEN 'choice' THEN
      IF jsonb_typeof(p_value) <> 'string' THEN
        RAISE EXCEPTION 'تنظیم «%» باید یکی از گزینه‌های تعریف‌شده باشد.', p_key;
      END IF;
      SELECT array_agg(o->>'value') INTO v_allowed
        FROM jsonb_array_elements(s.options) o;
      v_text := p_value #>> '{}';
      IF NOT (v_text = ANY (v_allowed)) THEN
        RAISE EXCEPTION 'مقدار «%» برای تنظیم «%» مجاز نیست. گزینه‌های مجاز: %',
          v_text, p_key, array_to_string(v_allowed, '، ');
      END IF;

    WHEN 'multichoice' THEN
      IF jsonb_typeof(p_value) <> 'array' THEN
        RAISE EXCEPTION 'تنظیم «%» فهرستی از گزینه‌هاست.', p_key;
      END IF;
      SELECT array_agg(o->>'value') INTO v_allowed
        FROM jsonb_array_elements(s.options) o;
      FOR v_el IN SELECT jsonb_array_elements(p_value) LOOP
        IF jsonb_typeof(v_el) <> 'string' THEN
          RAISE EXCEPTION 'هر عضو تنظیم «%» باید متن باشد.', p_key;
        END IF;
        v_text := v_el #>> '{}';
        IF NOT (v_text = ANY (v_allowed)) THEN
          RAISE EXCEPTION 'مقدار «%» برای تنظیم «%» مجاز نیست. گزینه‌های مجاز: %',
            v_text, p_key, array_to_string(v_allowed, '، ');
        END IF;
      END LOOP;

    ELSE
      NULL;                                    -- json: شکل آزاد
  END CASE;

  IF v_num IS NOT NULL THEN
    IF s.min_value IS NOT NULL AND v_num < s.min_value THEN
      RAISE EXCEPTION 'تنظیم «%» نمی‌تواند کمتر از % باشد.', p_key, s.min_value;
    END IF;
    IF s.max_value IS NOT NULL AND v_num > s.max_value THEN
      RAISE EXCEPTION 'تنظیم «%» نمی‌تواند بیشتر از % باشد.', p_key, s.max_value;
    END IF;
  END IF;

  -- تغییری که چیزی را عوض نمی‌کند، رویدادی نیست. نه لاگ می‌خواهد نه
  -- مهر زمان تازه — وگرنه «آخرین تغییر» با هر بار باز و بسته‌کردن فرم
  -- جابه‌جا می‌شود و معنایش را از دست می‌دهد.
  IF s.value IS NOT DISTINCT FROM p_value THEN
    RETURN s;
  END IF;

  PERFORM platform.audit(
    'setting.change', 'platform_setting', p_key,
    jsonb_build_object('key', p_key, 'value', p_value),
    v_actor, p_reason,
    jsonb_build_object('key', p_key, 'value', s.value));

  -- پرچم فقط برای همین یک UPDATE روشن می‌شود و بلافاصله خاموش:
  -- `is_local = true` یعنی در پایان تراکنش هم خودبه‌خود پاک می‌شود، پس
  -- در Pool اشتراکی به درخواست بعدی نشت نمی‌کند.
  PERFORM set_config('labelmod.setting_write', 'on', true);

  UPDATE platform.setting
     SET value = p_value, updated_at = now(), updated_by = v_actor
   WHERE key = p_key
   RETURNING * INTO s;

  PERFORM set_config('labelmod.setting_write', '', true);

  RETURN s;
END $$;


-- ---------------------------------------------------------------------
-- ۲. تاریخ کاری — یک تعریف، نه چند تا
-- ---------------------------------------------------------------------
-- هرجا «امروز» یا «روز این فاکتور» لازم است، از اینجا می‌آید. اگر دو
-- تعریف در سیستم باشد، دیر یا زود یکی‌شان عقب می‌ماند و آن‌وقت دوره
-- ثبت و گزارش با هم نمی‌خوانند.

CREATE OR REPLACE FUNCTION platform.business_date(p_at timestamptz DEFAULT now())
RETURNS date LANGUAGE sql STABLE AS $$
  SELECT (p_at AT TIME ZONE platform.setting_text('platform.timezone', 'Asia/Tehran'))::date;
$$;

COMMENT ON FUNCTION platform.business_date IS
  'تاریخ کاری در منطقه زمانی کسب‌وکار (platform.timezone). تنها تعریف «امروز» در سیستم.';

-- ---------------------------------------------------------------------
-- ۳. دوره ثبت از همان تعریف استفاده می‌کند
-- ---------------------------------------------------------------------
-- تنها تفاوت با نسخه ۰۰۳: دو جایی که `::date` بود، حالا
-- `platform.business_date()` است. بقیه تابع دست‌نخورده کپی شده.

CREATE OR REPLACE FUNCTION sales.resolve_posting_batch(p_invoice uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  inv sales.invoice%ROWTYPE;
  v_batch uuid; v_status text; v_shift_status text; v_date date;
BEGIN
  SELECT * INTO inv FROM sales.invoice WHERE id = p_invoice;
  IF NOT FOUND THEN RAISE EXCEPTION 'فاکتور یافت نشد'; END IF;

  IF inv.shift_id IS NOT NULL THEN
    SELECT status, platform.business_date(opened_at) INTO v_shift_status, v_date
      FROM sales.cash_shift WHERE id = inv.shift_id;
    IF v_shift_status IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION
        'شیفت صندوق باز نیست (%). فاکتور روی شیفت بسته نهایی نمی‌شود.', v_shift_status;
    END IF;

    SELECT id, status INTO v_batch, v_status FROM ledger.posting_batch
     WHERE kind = 'shift' AND shift_id = inv.shift_id;

    IF v_batch IS NULL THEN
      INSERT INTO ledger.posting_batch (branch_id, kind, shift_id, business_date)
      VALUES (inv.branch_id, 'shift', inv.shift_id, v_date)
      ON CONFLICT DO NOTHING
      RETURNING id, status INTO v_batch, v_status;

      IF v_batch IS NULL THEN            -- نشست دیگری همین لحظه ساختش
        SELECT id, status INTO v_batch, v_status FROM ledger.posting_batch
         WHERE kind = 'shift' AND shift_id = inv.shift_id;
      END IF;
    END IF;

  ELSE
    v_date := platform.business_date(inv.occurred_at);

    SELECT id, status INTO v_batch, v_status FROM ledger.posting_batch
     WHERE kind = 'channel_day' AND branch_id = inv.branch_id
       AND channel = inv.channel AND business_date = v_date;

    IF v_batch IS NULL THEN
      INSERT INTO ledger.posting_batch (branch_id, kind, channel, business_date)
      VALUES (inv.branch_id, 'channel_day', inv.channel, v_date)
      ON CONFLICT DO NOTHING
      RETURNING id, status INTO v_batch, v_status;

      IF v_batch IS NULL THEN
        SELECT id, status INTO v_batch, v_status FROM ledger.posting_batch
         WHERE kind = 'channel_day' AND branch_id = inv.branch_id
           AND channel = inv.channel AND business_date = v_date;
      END IF;
    END IF;
  END IF;

  IF v_status = 'posted' THEN
    RAISE EXCEPTION
      'دوره ثبت این فاکتور قبلاً بسته شده است. فاکتور با تاریخ دوره بسته نهایی نمی‌شود.';
  END IF;

  RETURN v_batch;
END $$;


-- ---------------------------------------------------------------------
-- ۴. بستن خودکار هم از همان تعریف استفاده می‌کند
-- ---------------------------------------------------------------------
-- تنها تفاوت با نسخه ۰۱۳: `p_now::date` جایش را به
-- `platform.business_date(p_now)` داد، و مرز مهلت هم در همان منطقه
-- زمانی حساب می‌شود. اگر این دو با `resolve_posting_batch` یکی
-- نمی‌ماندند، دوره‌ای بسته می‌شد که هنوز فاکتور می‌گرفت.

CREATE OR REPLACE FUNCTION sales.close_due_channel_days(
  p_actor uuid,
  p_now   timestamptz DEFAULT now()
) RETURNS TABLE (
  batch_id      uuid,
  branch_id     uuid,
  channel       text,
  business_date date,
  sale_entry    uuid,
  cogs_entry    uuid,
  skipped       text
) LANGUAGE plpgsql AS $$
DECLARE
  b       record;
  v_grace int;
  v_today date;
  v_tz    text;
  v_sale  uuid;
  v_cogs  uuid;
  v_open  int;
  v_rows  int;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'بستن دوره ثبت بدون کاربر عامل مجاز نیست.';
  END IF;

  IF NOT platform.setting_bool('sales.auto_close_channel_day', true) THEN
    RETURN;                          -- خاموش است؛ هیچ دوره‌ای بسته نمی‌شود
  END IF;

  v_grace := platform.setting_int('sales.auto_close_after_hours', 2);
  v_today := platform.business_date(p_now);
  v_tz    := platform.setting_text('platform.timezone', 'Asia/Tehran');

  FOR b IN
    SELECT pb.id, pb.branch_id, pb.channel, pb.business_date
      FROM ledger.posting_batch pb
     WHERE pb.kind = 'channel_day'
       AND pb.status = 'open'
       AND pb.business_date < v_today
       -- مرز مهلت هم در منطقه زمانی کسب‌وکار: نیمه‌شبِ **تهران**،
       -- نه نیمه‌شبِ سرور.
       AND p_now >= ((pb.business_date + 1)::timestamp AT TIME ZONE v_tz)
                    + make_interval(hours => v_grace)
     ORDER BY pb.business_date, pb.branch_id, pb.channel
  LOOP
    -- فاکتور نیمه‌کاره: دوره را رد کن، ولی بگو چرا.
    SELECT count(*) INTO v_open FROM sales.invoice
     WHERE posting_batch_id = b.id
       AND status IN ('draft','confirmed','partially_paid');

    IF v_open > 0 THEN
      batch_id := b.id; branch_id := b.branch_id; channel := b.channel;
      business_date := b.business_date; sale_entry := NULL; cogs_entry := NULL;
      skipped := format('%s فاکتور نهایی‌نشده دارد', v_open);
      RETURN NEXT;
      CONTINUE;
    END IF;

    -- دوره‌ای که هیچ فاکتور نهایی‌شده‌ای ندارد، سندی هم ندارد. بستنش
    -- یعنی «سند بدون سطر» — پس رد می‌شود، نه اینکه خطا بدهد.
    SELECT count(*) INTO v_rows FROM sales.invoice
     WHERE posting_batch_id = b.id
       AND status IN ('finalized','paid','partially_returned','returned');

    IF v_rows = 0 THEN
      batch_id := b.id; branch_id := b.branch_id; channel := b.channel;
      business_date := b.business_date; sale_entry := NULL; cogs_entry := NULL;
      skipped := 'فاکتور نهایی‌شده‌ای ندارد';
      RETURN NEXT;
      CONTINUE;
    END IF;

    SELECT s.sale_entry, s.cogs_entry INTO v_sale, v_cogs
      FROM sales.post_batch(b.id, p_actor) s;

    batch_id := b.id; branch_id := b.branch_id; channel := b.channel;
    business_date := b.business_date;
    sale_entry := v_sale; cogs_entry := v_cogs; skipped := NULL;
    RETURN NEXT;
  END LOOP;

  RETURN;
END $$;

COMMENT ON FUNCTION sales.close_due_channel_days IS
  'دوره‌های کانال آنلاینِ روزهای گذشته را می‌بندد. موجودی را دست نمی‌زند — فقط سند حسابداری. دوره امروز هرگز بسته نمی‌شود.';

COMMIT;
