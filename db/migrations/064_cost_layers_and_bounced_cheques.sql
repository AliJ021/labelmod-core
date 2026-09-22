BEGIN;

-- اصلاح Projection لایه‌های مصرف‌نشدهٔ قدیمی، بدون تغییر حرکت یا ارزش دفتر.
DO $$
DECLARE b record; l record; extra numeric; take_qty numeric;
BEGIN
  FOR b IN SELECT s.variation_id,s.warehouse_id,s.on_hand,
      coalesce(sum(c.qty_left),0) AS layer_qty
    FROM inventory.stock_balance s LEFT JOIN inventory.cost_layer c USING(variation_id,warehouse_id)
    GROUP BY s.variation_id,s.warehouse_id,s.on_hand
  LOOP
    extra := greatest(b.layer_qty-greatest(b.on_hand,0),0);
    IF extra>0 THEN
      PERFORM platform.audit('repair.cost_layers','variation',b.variation_id::text,
        jsonb_build_object('warehouse',b.warehouse_id,'old_layer_qty',b.layer_qty,'on_hand',b.on_hand),
        (SELECT id FROM identity.app_user WHERE id='00000000-0000-7000-8000-0000000000f1'),
        'تطبیق تعداد لایه‌های فیزیکی؛ دفتر و حرکت‌های تاریخی دست‌نخورده‌اند');
    END IF;
    FOR l IN SELECT id,qty_left FROM inventory.cost_layer
      WHERE variation_id=b.variation_id AND warehouse_id=b.warehouse_id AND qty_left>0
      ORDER BY occurred_at,id FOR UPDATE
    LOOP
      EXIT WHEN extra<=0;
      take_qty:=least(l.qty_left,extra);
      UPDATE inventory.cost_layer SET qty_left=qty_left-take_qty WHERE id=l.id;
      extra:=extra-take_qty;
    END LOOP;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION inventory.apply_movement(p_variation uuid, p_warehouse uuid, p_qty platform.qty, p_kind text, p_ref_type text DEFAULT NULL::text, p_ref_id uuid DEFAULT NULL::uuid, p_user uuid DEFAULT NULL::uuid, p_unit_cost platform.money DEFAULT NULL::numeric, p_allow_negative boolean DEFAULT false, p_occurred_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_note text DEFAULT NULL::text, p_value_delta platform.money DEFAULT NULL::numeric)
 RETURNS inventory.movement_result
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'inventory', 'platform', 'catalog', 'identity', 'ledger'
AS $function$
DECLARE
  v_on_hand  platform.qty;
  v_value    platform.money;
  v_cost     platform.money;
  v_delta    platform.money;
  v_residual platform.money := 0;
  v_new_qty  platform.qty;
  v_id       uuid;
  v_at       timestamptz;
  v_fifo     boolean;
  v_need     platform.qty;
  v_take     platform.qty;
  v_taken    platform.money := 0;
  v_avg      platform.money;
  v_layer    inventory.cost_layer%ROWTYPE;
BEGIN
  IF p_qty = 0 THEN
    RAISE EXCEPTION 'حرکت با تعداد صفر مجاز نیست';
  END IF;

  v_at := coalesce(p_occurred_at, now());

  -- روش **داده** است نه شرط در کد، و یک بار خوانده می‌شود تا در میانه
  -- یک عملیات عوض نشود.

  INSERT INTO inventory.stock_balance (variation_id, warehouse_id)
  VALUES (p_variation, p_warehouse)
  ON CONFLICT (variation_id, warehouse_id) DO NOTHING;

  SELECT on_hand, total_value INTO v_on_hand, v_value
    FROM inventory.stock_balance
   WHERE variation_id = p_variation AND warehouse_id = p_warehouse
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'سطر موجودی تنوع % در انبار % در دسترس نیست (تعارض همزمانی). عملیات را دوباره اجرا کنید.',
      p_variation, p_warehouse;
  END IF;

  -- پس از قفل موجودی خوانده می‌شود تا تغییر هم‌زمان روش، نرخ کهنه را اعمال نکند.
  v_fifo := platform.setting_text('costing.method', 'last_purchase') = 'fifo';

  v_new_qty := v_on_hand + p_qty;

  IF p_qty > 0 THEN
    IF p_unit_cost IS NULL THEN
      RAISE EXCEPTION 'بهای واحد برای ورود کالا اجباری است (تنوع %)', p_variation;
    END IF;
    v_cost  := p_unit_cost;
    v_delta := coalesce(p_value_delta, p_qty * v_cost);

  ELSE
    IF NOT p_allow_negative AND v_new_qty < 0 THEN
      RAISE EXCEPTION
        'موجودی کافی نیست: تنوع %، انبار %، موجود %، درخواست %',
        p_variation, p_warehouse, v_on_hand, abs(p_qty);
    END IF;

    IF v_fifo AND p_unit_cost IS NULL AND p_value_delta IS NULL THEN
      -- ── مصرف لایه‌ها، از قدیمی‌ترین ─────────────────────────────
      --
      -- **کاشت تنبل:** اگر روش وسط عمر کالا به FIFO عوض شده باشد،
      -- موجودی هست ولی لایه نیست. به‌جای یک مهاجرت داده که فقط یک بار
      -- کار می‌کند، همان‌جا یک لایه به نرخ میانگین جاری ساخته می‌شود.
      -- هم مسیر «تازه سوییچ کرد» را می‌گیرد، هم اگر روزی لایه‌ها از
      -- موجودی عقب بیفتند خودش را ترمیم می‌کند.
      IF v_on_hand > 0 AND NOT EXISTS (
           SELECT 1 FROM inventory.cost_layer
            WHERE variation_id = p_variation AND warehouse_id = p_warehouse
              AND qty_left > 0) THEN
        INSERT INTO inventory.cost_layer
          (variation_id, warehouse_id, unit_cost, qty_in, qty_left, occurred_at)
        VALUES
          (p_variation, p_warehouse,
           round(v_value / v_on_hand), v_on_hand, v_on_hand,
           v_at - interval '1 microsecond');
      END IF;

      v_need := -p_qty;

      FOR v_layer IN
        SELECT * FROM inventory.cost_layer
         WHERE variation_id = p_variation AND warehouse_id = p_warehouse
           AND qty_left > 0
         ORDER BY occurred_at, id
         FOR UPDATE
      LOOP
        EXIT WHEN v_need <= 0;
        v_take  := least(v_layer.qty_left, v_need);
        v_taken := v_taken + round(v_take * v_layer.unit_cost);
        UPDATE inventory.cost_layer
           SET qty_left = qty_left - v_take
         WHERE id = v_layer.id;
        v_need := v_need - v_take;
      END LOOP;

      -- کسری لایه فقط وقتی ممکن است که موجودی منفی مجاز باشد. آن‌وقت
      -- نرخ میانگین جاری برداشته می‌شود — همان کاری که پیش از FIFO
      -- می‌شد.
      IF v_need > 0 THEN
        v_avg   := CASE WHEN v_on_hand > 0 THEN round(v_value / v_on_hand) ELSE 0 END;
        v_taken := v_taken + round(v_need * v_avg);
      END IF;

      v_delta := -v_taken;
      v_cost  := round(v_taken / (-p_qty));

    ELSE
      IF p_unit_cost IS NOT NULL THEN
        v_cost := p_unit_cost;
      ELSIF v_on_hand > 0 THEN
        v_cost := round(v_value / v_on_hand);
      ELSE
        v_cost := 0;
      END IF;

      v_delta := coalesce(p_value_delta, p_qty * v_cost);
      -- لایه‌ها تاریخچه موجودی فیزیکی‌اند؛ در روش میانگین یا خروج با بهای صریح هم مصرف می‌شوند.
      v_need := -p_qty;
      FOR v_layer IN SELECT * FROM inventory.cost_layer
        WHERE variation_id=p_variation AND warehouse_id=p_warehouse AND qty_left>0
        ORDER BY occurred_at,id FOR UPDATE
      LOOP
        EXIT WHEN v_need<=0;
        v_take := least(v_layer.qty_left,v_need);
        UPDATE inventory.cost_layer SET qty_left=qty_left-v_take WHERE id=v_layer.id;
        v_need := v_need-v_take;
      END LOOP;
    END IF;

    -- خالی‌شدن انبار باید ارزش را دقیقاً صفر کند، وگرنه باقی‌ماندهٔ
    -- گرد کردن روی سطری می‌نشیند که تعدادش صفر است — و آن ارزشِ بی‌کالا
    -- در `balance_check` دیده می‌شود.
    IF v_new_qty = 0 AND p_value_delta IS NULL THEN
      v_residual := (-v_value) - v_delta;
      v_delta    := -v_value;
    END IF;
  END IF;

  UPDATE inventory.stock_balance
     SET on_hand     = v_new_qty,
         total_value = v_value + v_delta,
         row_version = row_version + 1,
         updated_at  = now()
   WHERE variation_id = p_variation AND warehouse_id = p_warehouse;

  INSERT INTO inventory.stock_movement
    (variation_id, warehouse_id, qty, unit_cost, value_delta,
     kind, ref_type, ref_id, user_id, occurred_at, note)
  VALUES
    (p_variation, p_warehouse, p_qty, v_cost, v_delta,
     p_kind, p_ref_type, p_ref_id, p_user, v_at, p_note)
  RETURNING id INTO v_id;

  -- هر ورود یک لایه می‌سازد — حتی وقتی روش FIFO نیست. دلیلش این است
  -- که اگر فردا مالک روش را عوض کند، تاریخچه‌اش از همان روز موجود
  -- باشد و لازم نباشد کل موجودی به یک نرخ میانگین تخت شود.
  IF p_qty > 0 THEN
    INSERT INTO inventory.cost_layer
      (variation_id, warehouse_id, unit_cost, qty_in, qty_left, occurred_at, movement_id)
    VALUES
      (p_variation, p_warehouse, v_cost, p_qty, p_qty, v_at, v_id);
  END IF;

  -- ── Push لحظه‌ای به سایت (ADR-007) ─────────────────────────────
  --
  -- ⚠️ **داخل همان تراکنش** — الگوی Transactional Outbox. اگر فروش
  --    Rollback شود، پیام هم نمی‌رود؛ و اگر Commit شود، پیام قطعاً در
  --    صف است. یک `fetch` داخل تراکنش هیچ‌کدام را نمی‌داد و بودجهٔ
  --    ۱۰۰ms صندوق را هم می‌شکست (بند «چرا نه HTTP همگام» ADR-007).
  --
  -- ⚠️ نسخه از دنبالهٔ `platform.web_push_version` می‌آید، نه از شناسهٔ
  --    حرکت (که `uuid` است، نه شمارنده — تصحیح ADR-007 بند ۴). افزونه
  --    پیام با نسخهٔ مساوی یا قدیمی‌تر را دور می‌اندازد، پس دو پیام
  --    خارج از ترتیب عدد کهنه را نمی‌نشانند.
  --
  -- ⚠️ `push_web_stock` خودش خاموش‌بودن و «انبارِ سایت نیست» را
  --    می‌سنجد و بی‌صدا برمی‌گردد. اینجا شرط نوشتن یعنی دو تعریف.
  PERFORM inventory.push_web_stock(p_variation, p_warehouse);

  RETURN (v_id, v_cost, v_delta, v_residual)::inventory.movement_result;
END $function$;
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
      WHEN p_action = 'pay'    AND c.status IN ('issued','bounced')                      THEN 'cleared'
      WHEN p_action = 'bounce' AND c.status = 'issued'                      THEN 'bounced'
      WHEN p_action = 'cancel' AND c.status IN ('draft','issued','bounced')           THEN 'cancelled'
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

    ELSIF p_action = 'cancel' AND c.status IN ('issued','bounced') THEN
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
 WHERE c.status IN ('in_hand','deposited','issued','endorsed','bounced');
-- تغییر روش نباید ارزش دفتریِ موجودی باقی‌مانده را بی‌سند عوض کند.
CREATE OR REPLACE FUNCTION inventory.guard_fifo_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,public,inventory,platform AS $$
BEGIN
  IF NEW.key='costing.method' AND NEW.value='"fifo"'::jsonb AND NEW.value IS DISTINCT FROM OLD.value THEN
    PERFORM 1 FROM inventory.stock_balance ORDER BY variation_id,warehouse_id FOR UPDATE;
    IF EXISTS(SELECT 1 FROM inventory.stock_balance s WHERE s.on_hand>0 AND (
      (SELECT coalesce(sum(c.qty_left),0) FROM inventory.cost_layer c
        WHERE c.variation_id=s.variation_id AND c.warehouse_id=s.warehouse_id)<>s.on_hand OR
      (SELECT coalesce(sum(round(c.qty_left*c.unit_cost)),0) FROM inventory.cost_layer c
        WHERE c.variation_id=s.variation_id AND c.warehouse_id=s.warehouse_id)<>s.total_value)) THEN
      RAISE EXCEPTION 'تغییر به FIFO نیازمند تطبیق ارزش لایه‌ها با موجودی است؛ ابتدا تجدید ارزیابی مستند انجام دهید';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fifo_transition_guard BEFORE UPDATE OF value ON platform.setting
  FOR EACH ROW EXECUTE FUNCTION inventory.guard_fifo_transition();
REVOKE ALL ON FUNCTION inventory.guard_fifo_transition() FROM PUBLIC;
COMMIT;
