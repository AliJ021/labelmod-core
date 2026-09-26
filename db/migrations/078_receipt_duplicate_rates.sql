-- 078 — نرخ متفاوت یک SKU تا تعیین قاعده ارزش‌گذاری قطعی نمی‌شود.
BEGIN;

CREATE OR REPLACE FUNCTION purchasing.post_receipt(p_receipt uuid, p_user uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
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
  v_fy           smallint;             -- سال مالی، فقط برای تخصیص شماره
  v_into_cost    platform.money := 0;  -- هزینه‌ای که به بهای کالا می‌رود
  v_expensed     platform.money := 0;  -- هزینه‌ای که مستقیم هزینه دوره است
  v_expense_legs jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO r FROM purchasing.receipt WHERE id = p_receipt FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'رسید خرید یافت نشد'; END IF;
  IF r.status <> 'draft' THEN
    RAISE EXCEPTION 'رسید خرید % قبلاً ثبت شده است', r.number;
  END IF;

  -- شماره در همین لحظه تخصیص می‌یابد، نه هنگام ساخت پیش‌نویس.
  -- پیش‌نویسی که رها می‌شود نباید یک شماره را بسوزاند: در دفتر خرید،
  -- شماره غایب سؤالی است که کسی نمی‌تواند جوابش را بدهد.
  -- سطر با FOR UPDATE قفل است، پس دو ثبت هم‌زمان یک شماره نمی‌گیرند.
  IF r.number IS NULL THEN
    SELECT id INTO v_fy FROM ledger.fiscal_year
     WHERE platform.business_date(r.occurred_at) BETWEEN starts_on AND ends_on;
    IF v_fy IS NULL THEN
      RAISE EXCEPTION 'سال مالی برای تاریخ % تعریف نشده است', platform.business_date(r.occurred_at);
    END IF;

    r.number := platform.next_document_no(r.branch_id, 'purchase', v_fy);
    UPDATE purchasing.receipt SET number = r.number WHERE id = p_receipt;
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

  -- هزینه‌ای که وارد بهای کالا می‌شود، و هزینه‌ای که نمی‌شود.
  --
  -- تا مهاجرت ۰۲۶ این دو یکی گرفته می‌شدند: باقی‌مانده گرد کردن با
  -- **کل** هزینه سنجیده می‌شد، پس هزینه‌ای با تخصیص «none» تمامش روی
  -- آخرین سطر می‌نشست. یعنی گزینه‌ای که می‌گفت «به بهای کالا نرو»، در
  -- عمل همه‌اش را روی یک قلم می‌گذاشت — و بهای تمام‌شده آن قلم را
  -- بی‌دلیل بالا می‌برد.
  v_into_cost := v_by_value + v_by_qty;

  SELECT coalesce(sum(amount) FILTER (WHERE allocation = 'none'), 0)
    INTO v_expensed
    FROM purchasing.receipt_charge WHERE receipt_id = p_receipt;

  -- هزینه دوره، به تفکیک حساب. حساب نداده = حساب پیش‌فرض قاعده ثبت.
  SELECT coalesce(jsonb_agg(jsonb_build_object('leg','expensed_charge','amount', amt)
                            || CASE WHEN acc IS NULL THEN '{}'::jsonb
                                    ELSE jsonb_build_object('account_code', acc) END),
                  '[]'::jsonb)
    INTO v_expense_legs
    FROM (SELECT expense_account_code AS acc, sum(amount) AS amt
            FROM purchasing.receipt_charge
           WHERE receipt_id = p_receipt AND allocation = 'none'
           GROUP BY expense_account_code) e;

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

  IF v_alloc_sum <> v_into_cost AND v_last_line IS NOT NULL THEN
    UPDATE purchasing.receipt_line
       SET charge_alloc     = charge_alloc + (v_into_cost - v_alloc_sum),
           landed_unit_cost = round((line_amount + charge_alloc + (v_into_cost - v_alloc_sum)) / qty)
     WHERE id = v_last_line;
  END IF;

  -- نرخ خرید و بهای پس از تخصیص هر دو باید مستقل از ترتیب سطرها باشند.
  IF EXISTS (
    SELECT 1 FROM purchasing.receipt_line WHERE receipt_id=p_receipt
    GROUP BY variation_id
    HAVING count(DISTINCT unit_price)>1 OR count(DISTINCT landed_unit_cost)>1
  ) THEN
    RAISE EXCEPTION 'یک کالا با نرخ‌های خرید یا بهای تمام‌شده متفاوت در چند سطر است؛ تا تعیین قاعده ارزش‌گذاری، رسید قطعی نمی‌شود.';
  END IF;

  -- روش قیمت‌گذاری **داده** است، نه شرطی در کد. یک بار خوانده می‌شود تا
  -- در میانه یک رسید عوض نشود.
  v_last_cost := platform.setting_text('costing.method', 'moving_weighted_average')
                 = 'last_purchase';

  FOR v_line IN
    SELECT variation_id, qty, landed_unit_cost, line_amount, charge_alloc
      FROM purchasing.receipt_line WHERE receipt_id = p_receipt
  LOOP
    -- Revalue existing stock only. Revaluing the incoming line would replace
    -- its exact extended cost with rounded unit cost * quantity, losing rials.
    PERFORM inventory.lock_stock(v_line.variation_id,r.warehouse_id);
    IF v_last_cost THEN
      v_reval := v_reval + inventory.revalue_to_cost(
        v_line.variation_id, r.warehouse_id, v_line.landed_unit_cost,
        p_user, 'purchase_receipt', p_receipt, r.occurred_at,
        'تجدید ارزیابی به نرخ رسید ' || r.number);
    END IF;
    PERFORM inventory.apply_movement(
      v_line.variation_id, r.warehouse_id, v_line.qty,
      'purchase_receipt', 'purchase_receipt', p_receipt, p_user,
      v_line.landed_unit_cost, false, r.occurred_at, NULL, v_line.line_amount+v_line.charge_alloc);
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
              jsonb_build_object('leg','inventory','amount', v_goods + v_into_cost),
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
            || v_expense_legs
            || v_treasury_legs;

  v_entry := ledger.post_entry(
    'purchase_receipt', r.branch_id, platform.business_date(r.occurred_at),
    'رسید خرید ' || r.number, v_legs,
    'purchase_receipt', p_receipt, p_user);

  PERFORM platform.audit('purchase.post', 'purchase_receipt', p_receipt::text,
    jsonb_build_object('number', r.number, 'goods', v_goods, 'charges', v_charges,
                       'charges_into_cost', v_into_cost, 'charges_expensed', v_expensed,
                       'tax', r.tax_amount, 'supplier_payable', v_goods + r.tax_amount + v_sup_payable,
                       'third_party_payable', v_other_payable,
                       'costing_method', CASE WHEN v_last_cost THEN 'last_purchase'
                                              ELSE 'moving_weighted_average' END,
                       'revaluation', v_reval, 'entry', v_entry),
    p_user);

  RETURN v_entry;
END $function$;

COMMIT;
