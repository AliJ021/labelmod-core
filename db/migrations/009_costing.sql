-- =====================================================================
-- ۰۰۹ — روش قیمت تمام‌شده «آخرین قیمت خرید» و تجدید ارزیابی موجودی
-- =====================================================================
-- تا امروز سیستم فقط یک روش داشت: **میانگین متحرک موزون**. مالک روش
-- دیگری خواسته — همان که هلو و دشت به کار می‌برند و در بازار پوشاک
-- ایران رایج است:
--
--   خرداد  ۱۰ عدد × ۲۰۰٬۰۰۰  →  انبار ۱۰ تا، ارزش ۲٬۰۰۰٬۰۰۰
--   شهریور ۱۰ عدد × ۳۰۰٬۰۰۰  →  انبار ۲۰ تا، ارزش ۶٬۰۰۰٬۰۰۰
--
-- با میانگین موزون ارزش ۵٬۰۰۰٬۰۰۰ می‌شد. با «آخرین قیمت خرید»، **همه**
-- موجودی به نرخ آخرین خرید ارزیابی می‌شود: ۲۰ × ۳۰۰٬۰۰۰.
--
-- ## آن یک میلیون از کجا می‌آید — و چرا نمی‌شود نادیده‌اش گرفت
--
-- تفاوت ۱٬۰۰۰٬۰۰۰ ریالی، ارزشِ ده عدد قدیمی است که ۱۰۰٬۰۰۰ گران‌تر
-- ارزیابی شده‌اند. دارایی بدون طرف حساب زیاد نمی‌شود؛ سند باید متوازن
-- بماند. پس این مبلغ یک **سطر تعدیل** می‌خورد:
--
--   بدهکار  موجودی کالا            ۱٬۰۰۰٬۰۰۰
--   بستانکار تعدیل بهای تمام‌شده   ۱٬۰۰۰٬۰۰۰
--
-- نتیجه عملی: سود در **لحظه خرید** شناسایی می‌شود، نه لحظه فروش.
-- جمع سود در طول عمر کالا با هر دو روش یکی است؛ فقط زمان‌بندی‌اش فرق
-- می‌کند. این ذاتِ همین روش است، نه یک عارضه — و همان کاری است که
-- نرم‌افزارهای ایرانی می‌کنند.
--
-- ⚠️ حساب ۵۱۰۲ «تعدیل بهای تمام‌شده» از قبل در کدینگ بود و دقیقاً برای
--    همین ساخته شده. حساب تازه‌ای اضافه نشد.
--
-- ## چرا تجدید ارزیابی یک حرکت جداست
--
-- `sales.finalize_invoice` بهای تمام‌شده را از `value_delta` واقعی
-- حرکت انبار می‌خواند، نه از `unit_cost × qty` — تنها راهی که سند COGS
-- همیشه با انبار بخواند. اگر تجدید ارزیابی را داخل همان حرکت رسید
-- می‌ریختیم، `value_delta` رسید دیگر با مبلغ فاکتور تأمین‌کننده یکی
-- نبود و سند خرید نامتوازن می‌شد.
--
-- پس یک حرکت `revaluation` مستقل با `qty = 0` ثبت می‌شود: انبار
-- می‌داند ارزشش چرا عوض شده، و حرکت رسید دست‌نخورده می‌ماند.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- ۱. حرکت با تعداد صفر — فقط برای تجدید ارزیابی
-- ---------------------------------------------------------------------
-- `qty <> 0` از روز اول درست بود: حرکتی که نه چیزی می‌آورد نه می‌برد،
-- تقریباً همیشه یک باگ است. تجدید ارزیابی تنها استثنای واقعی است —
-- ارزش عوض می‌شود، تعداد نه — و استثنا صریح نوشته می‌شود، نه با
-- برداشتن قید.

ALTER TABLE inventory.stock_movement
  DROP CONSTRAINT stock_movement_qty_check;

ALTER TABLE inventory.stock_movement
  DROP CONSTRAINT stock_movement_kind_check,
  ADD  CONSTRAINT stock_movement_kind_check CHECK (kind IN (
         'opening','purchase_receipt','purchase_return',
         'sale','sale_return','transfer_in','transfer_out',
         'count_adjust','defective','lost','correction','revaluation')),
  ADD  CONSTRAINT stock_movement_qty_check CHECK (
         (qty <> 0 AND kind <> 'revaluation')
      OR (qty  = 0 AND kind  = 'revaluation'));

COMMENT ON CONSTRAINT stock_movement_qty_check ON inventory.stock_movement IS
  'تعداد صفر فقط برای تجدید ارزیابی — تنها حرکتی که ارزش را عوض می‌کند و تعداد را نه.';

-- ---------------------------------------------------------------------
-- ۲. تجدید ارزیابی یک تنوع به نرخ داده‌شده
-- ---------------------------------------------------------------------
-- برمی‌گرداند: تفاوت ارزش (مثبت یعنی موجودی گران‌تر شد). صفر یعنی
-- کاری لازم نبود — و آن‌وقت هیچ حرکتی هم ثبت نمی‌شود.
--
-- عمداً **خودش تصمیم نمی‌گیرد** که روش قیمت‌گذاری چیست؛ فراخوان
-- تصمیم می‌گیرد. این تابع فقط «موجودی را به این نرخ ببر» را انجام
-- می‌دهد، پس برای شمارش انبار و اصلاح دستی هم قابل استفاده است.

CREATE OR REPLACE FUNCTION inventory.revalue_to_cost(
  p_variation   uuid,
  p_warehouse   uuid,
  p_unit_cost   platform.money,
  p_user        uuid        DEFAULT NULL,
  p_ref_type    text        DEFAULT NULL,
  p_ref_id      uuid        DEFAULT NULL,
  p_occurred_at timestamptz DEFAULT NULL,
  p_note        text        DEFAULT NULL
) RETURNS platform.money
LANGUAGE plpgsql AS $$
DECLARE
  v_on_hand platform.qty;
  v_value   platform.money;
  v_target  platform.money;
  v_delta   platform.money;
BEGIN
  IF p_unit_cost IS NULL OR p_unit_cost < 0 THEN
    RAISE EXCEPTION 'نرخ تجدید ارزیابی نمی‌تواند منفی یا تهی باشد (تنوع %)', p_variation;
  END IF;

  SELECT on_hand, total_value INTO v_on_hand, v_value
    FROM inventory.stock_balance
   WHERE variation_id = p_variation AND warehouse_id = p_warehouse
     FOR UPDATE;

  -- موجودی منفی ارزیابی نمی‌شود: ارزشش یک بدهی است، نه یک دارایی، و
  -- ضرب‌کردنش در نرخ تازه فقط عدد بی‌معنا می‌سازد.
  IF NOT FOUND OR v_on_hand <= 0 THEN
    RETURN 0;
  END IF;

  v_target := round(v_on_hand * p_unit_cost);
  v_delta  := v_target - v_value;
  IF v_delta = 0 THEN
    RETURN 0;
  END IF;

  UPDATE inventory.stock_balance
     SET total_value = v_target,
         row_version = row_version + 1,
         updated_at  = now()
   WHERE variation_id = p_variation AND warehouse_id = p_warehouse;

  INSERT INTO inventory.stock_movement
    (variation_id, warehouse_id, qty, unit_cost, value_delta,
     kind, ref_type, ref_id, user_id, occurred_at, note)
  VALUES
    (p_variation, p_warehouse, 0, p_unit_cost, v_delta,
     'revaluation', p_ref_type, p_ref_id, p_user, coalesce(p_occurred_at, now()),
     coalesce(p_note, 'تجدید ارزیابی به نرخ آخرین خرید'));

  RETURN v_delta;
END $$;

COMMENT ON FUNCTION inventory.revalue_to_cost IS
  'ارزش موجودی یک تنوع را به نرخ داده‌شده می‌برد و تفاوت را برمی‌گرداند. حرکت revaluation با تعداد صفر ثبت می‌کند.';

-- ---------------------------------------------------------------------
-- ۳. رسید خرید: تجدید ارزیابی وقتی روش «آخرین قیمت خرید» است
-- ---------------------------------------------------------------------
-- تنها تفاوت با نسخه ۰۰۴: پس از ثبت حرکت‌های ورود، اگر
-- `costing.method = 'last_purchase'` باشد، موجودی هر تنوع به نرخ
-- همان رسید برده می‌شود و تفاوتِ جمع‌شده یک سطر تعدیل در سند خرید
-- می‌گیرد.
--
-- ترتیب اهمیت دارد و عمدی است: **اول ورود، بعد تجدید ارزیابی.**
-- برعکسش یعنی کالای تازه به نرخ قدیم وارد شود و بعد همه‌اش دوباره
-- ارزیابی شود — همان نتیجه، ولی حرکت ورود دیگر با فاکتور تأمین‌کننده
-- نمی‌خواند.

CREATE OR REPLACE FUNCTION purchasing.post_receipt(
  p_receipt uuid, p_user uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  r              purchasing.receipt%ROWTYPE;
  v_goods        platform.money := 0;
  v_charges      platform.money := 0;
  v_charge_alloc platform.money;
  v_qty_total    platform.qty := 0;
  v_line         record;
  v_alloc_sum    platform.money := 0;
  v_last_line    uuid;
  v_by_value     platform.money := 0;
  v_by_qty       platform.money := 0;
  v_sup_payable  platform.money := 0;   -- هزینه جانبیِ بدهی به تأمین‌کننده
  v_other_payable platform.money := 0;  -- هزینه جانبیِ بدهی به شخص ثالث
  v_treasury_legs jsonb := '[]'::jsonb;
  v_entry        uuid;
  v_legs         jsonb;
  v_reval        platform.money := 0;  -- تفاوت تجدید ارزیابی این رسید
  v_last_cost    boolean;              -- روش «آخرین قیمت خرید» روشن است؟
BEGIN
  SELECT * INTO r FROM purchasing.receipt WHERE id = p_receipt FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'رسید خرید یافت نشد'; END IF;
  IF r.status <> 'draft' THEN
    RAISE EXCEPTION 'رسید خرید % قبلاً ثبت شده است', r.number;
  END IF;

  SELECT coalesce(sum(qty * unit_price),0), coalesce(sum(qty),0)
    INTO v_goods, v_qty_total
    FROM purchasing.receipt_line WHERE receipt_id = p_receipt;

  IF v_qty_total = 0 THEN
    RAISE EXCEPTION 'رسید خرید بدون قلم قابل ثبت نیست';
  END IF;

  SELECT coalesce(sum(amount) FILTER (WHERE allocation = 'by_value'), 0),
         coalesce(sum(amount) FILTER (WHERE allocation = 'by_qty'), 0),
         coalesce(sum(amount), 0),
         coalesce(sum(amount) FILTER (WHERE paid_from = 'payable' AND payee_type = 'supplier'), 0),
         coalesce(sum(amount) FILTER (WHERE paid_from = 'payable' AND payee_type = 'other'), 0)
    INTO v_by_value, v_by_qty, v_charges, v_sup_payable, v_other_payable
    FROM purchasing.receipt_charge WHERE receipt_id = p_receipt;

  -- هزینه‌های پرداخت‌شده از خزانه، به تفکیک حسابِ پرداخت‌کننده
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'leg','from_account', 'amount', amt, 'account_code', acc)), '[]'::jsonb)
    INTO v_treasury_legs
    FROM (SELECT a.ledger_account_code AS acc, sum(c.amount) AS amt
            FROM purchasing.receipt_charge c
            JOIN treasury.account a ON a.id = c.paid_account_id
           WHERE c.receipt_id = p_receipt AND c.paid_from = 'treasury'
           GROUP BY a.ledger_account_code) x;

  -- تخصیص هزینه جانبی. باقی‌مانده گرد کردن به آخرین سطر می‌رود تا جمع
  -- تخصیص دقیقاً برابر کل هزینه باشد.
  FOR v_line IN
    SELECT id, variation_id, qty, unit_price, qty * unit_price AS line_amount
      FROM purchasing.receipt_line WHERE receipt_id = p_receipt ORDER BY id
  LOOP
    v_charge_alloc :=
        round(CASE WHEN v_goods > 0 THEN v_by_value * v_line.line_amount / v_goods ELSE 0 END)
      + round(v_by_qty * v_line.qty / v_qty_total);
    v_alloc_sum := v_alloc_sum + v_charge_alloc;
    v_last_line := v_line.id;

    UPDATE purchasing.receipt_line
       SET line_amount      = v_line.line_amount,
           charge_alloc     = v_charge_alloc,
           landed_unit_cost = round((v_line.line_amount + v_charge_alloc) / v_line.qty)
     WHERE id = v_line.id;
  END LOOP;

  IF v_alloc_sum <> v_charges AND v_last_line IS NOT NULL THEN
    UPDATE purchasing.receipt_line
       SET charge_alloc     = charge_alloc + (v_charges - v_alloc_sum),
           landed_unit_cost = round((line_amount + charge_alloc + (v_charges - v_alloc_sum)) / qty)
     WHERE id = v_last_line;
  END IF;

  -- روش قیمت‌گذاری **داده** است، نه شرطی در کد. یک بار خوانده می‌شود تا
  -- در میانه یک رسید عوض نشود.
  v_last_cost := platform.setting_text('costing.method', 'moving_weighted_average')
                 = 'last_purchase';

  FOR v_line IN
    SELECT variation_id, qty, landed_unit_cost
      FROM purchasing.receipt_line WHERE receipt_id = p_receipt
  LOOP
    PERFORM inventory.apply_movement(
      v_line.variation_id, r.warehouse_id, v_line.qty,
      'purchase_receipt', 'purchase_receipt', p_receipt, p_user,
      v_line.landed_unit_cost, false, r.occurred_at);

    -- ترتیب عمدی است: **اول ورود، بعد تجدید ارزیابی.** برعکسش همان
    -- ارزش نهایی را می‌دهد ولی حرکت ورود دیگر با فاکتور تأمین‌کننده
    -- نمی‌خواند — و همان جایی است که انبار و دفتر از هم جدا می‌افتند.
    IF v_last_cost THEN
      v_reval := v_reval + inventory.revalue_to_cost(
        v_line.variation_id, r.warehouse_id, v_line.landed_unit_cost,
        p_user, 'purchase_receipt', p_receipt, r.occurred_at,
        'تجدید ارزیابی به نرخ رسید ' || r.number);
    END IF;
  END LOOP;

  UPDATE purchasing.receipt
     SET goods_amount        = v_goods,
         charges_amount      = v_charges,
         total_payable       = v_goods + r.tax_amount + v_sup_payable,
         third_party_payable = v_other_payable,
         status              = 'posted',
         posted_at           = now()
   WHERE id = p_receipt;

  v_legs := jsonb_build_array(
              jsonb_build_object('leg','inventory','amount', v_goods + v_charges),
              jsonb_build_object('leg','input_tax','amount', r.tax_amount),
              jsonb_build_object('leg','payable',
                                 'amount', v_goods + r.tax_amount + v_sup_payable,
                                 'party_type','supplier','party_id', r.supplier_id),
              jsonb_build_object('leg','other_payable','amount', v_other_payable),
              -- دو سطر با **همان مبلغ علامت‌دار**: اگر نرخ تازه پایین‌تر از
              -- میانگین قبلی باشد مبلغ منفی می‌شود و post_entry خودش هر دو
              -- را برعکس می‌کند — یعنی زیانِ تعدیل، بدهکارِ ۵۱۰۲ می‌شود.
              -- مبلغ صفر اصلاً سطر نمی‌سازد، پس در روش میانگین موزون سند
              -- خرید دقیقاً همان قبلی می‌ماند.
              jsonb_build_object('leg','revaluation',        'amount', v_reval),
              jsonb_build_object('leg','revaluation_offset', 'amount', v_reval))
            || v_treasury_legs;

  v_entry := ledger.post_entry(
    'purchase_receipt', r.branch_id, r.occurred_at::date,
    'رسید خرید ' || r.number, v_legs,
    'purchase_receipt', p_receipt, p_user);

  PERFORM platform.audit('purchase.post', 'purchase_receipt', p_receipt::text,
    jsonb_build_object('number', r.number, 'goods', v_goods, 'charges', v_charges,
                       'tax', r.tax_amount, 'supplier_payable', v_goods + r.tax_amount + v_sup_payable,
                       'third_party_payable', v_other_payable,
                       'costing_method', CASE WHEN v_last_cost THEN 'last_purchase'
                                              ELSE 'moving_weighted_average' END,
                       'revaluation', v_reval, 'entry', v_entry),
    p_user);

  RETURN v_entry;
END $$;

COMMIT;
