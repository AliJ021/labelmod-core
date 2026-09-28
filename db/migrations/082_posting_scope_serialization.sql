-- Scope bulk posting before side effects and serialize batch closing with finalization.
BEGIN;

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

  -- Hold a shared lock until the invoice transaction commits. A closer's
  -- FOR UPDATE must wait, while concurrent finalizers remain compatible.
  SELECT status INTO v_status FROM ledger.posting_batch WHERE id = v_batch FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Posting batch disappeared'; END IF;

  IF v_status = 'posted' THEN
    RAISE EXCEPTION
      'دوره ثبت این فاکتور قبلاً بسته شده است. فاکتور با تاریخ دوره بسته نهایی نمی‌شود.';
  END IF;

  RETURN v_batch;
END $$;

CREATE OR REPLACE FUNCTION sales.close_due_channel_days(
  p_actor uuid,
  p_now   timestamptz,
  p_branches uuid[]
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
       AND (p_branches IS NULL OR pb.branch_id = ANY(p_branches))
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


-- Backward-compatible trusted scheduler entry point. HTTP callers must use
-- the explicit scoped overload; NULL is global and an empty array is none.
CREATE OR REPLACE FUNCTION sales.close_due_channel_days(
  p_actor uuid, p_now timestamptz DEFAULT now()
) RETURNS TABLE (
  batch_id uuid, branch_id uuid, channel text, business_date date,
  sale_entry uuid, cogs_entry uuid, skipped text
) LANGUAGE sql AS $$
  SELECT * FROM sales.close_due_channel_days(p_actor, p_now, NULL::uuid[]);
$$;

COMMIT;
