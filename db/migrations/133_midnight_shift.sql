BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE sales.cash_shift ADD COLUMN sale_cutoff_at timestamptz,
  ADD COLUMN sale_ended_at timestamptz, ADD COLUMN close_review text;
-- Existing open tills may trade until the next local midnight after installation.
ALTER TABLE sales.cash_shift ALTER COLUMN sale_cutoff_at SET DEFAULT
  ((((now() AT TIME ZONE 'Asia/Tehran')::date + 1)::timestamp) AT TIME ZONE 'Asia/Tehran');
UPDATE sales.cash_shift SET sale_cutoff_at=DEFAULT WHERE status='open';
DROP INDEX sales.one_open_shift_per_user;
CREATE UNIQUE INDEX one_open_shift_per_user ON sales.cash_shift(branch_id,user_id)
  WHERE status='open' AND sale_ended_at IS NULL;
CREATE INDEX shift_cutoff_due ON sales.cash_shift(sale_cutoff_at)
  WHERE status='open' AND sale_ended_at IS NULL;

CREATE OR REPLACE FUNCTION sales.close_shift(p_shift uuid, p_counted_cash platform.money, p_user uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text)
 RETURNS TABLE(sale_entry uuid, cogs_entry uuid, variance platform.money)
 LANGUAGE plpgsql
AS $function$
DECLARE
  s          sales.cash_shift%ROWTYPE;
  v_batch    uuid;
  v_sale     uuid;
  v_cogs_e   uuid;
  v_cash_in  platform.money := 0;
  v_cash_out platform.money := 0;
  v_tx_in    platform.money := 0;
  v_tx_out   platform.money := 0;
  v_expected platform.money;
  v_variance platform.money;
  v_date     date;
BEGIN
  SELECT * INTO s FROM sales.cash_shift WHERE id = p_shift FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'شیفت یافت نشد'; END IF;
  IF s.status <> 'open' THEN RAISE EXCEPTION 'شیفت قبلاً بسته شده است'; END IF;

  IF EXISTS (SELECT 1 FROM sales.invoice
              WHERE shift_id = p_shift
                AND status IN ('confirmed','partially_paid')) THEN
    RAISE EXCEPTION 'شیفت با فاکتور نهایی‌نشده بسته نمی‌شود';
  END IF;

  IF EXISTS (SELECT 1 FROM treasury.transaction
              WHERE shift_id = p_shift AND status = 'draft') THEN
    RAISE EXCEPTION 'شیفت با تراکنش خزانه‌ی ثبت‌نشده بسته نمی‌شود';
  END IF;

  IF s.sale_ended_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM treasury.payment p LEFT JOIN sales.invoice i ON i.id=p.invoice_id
    WHERE (p.shift_id=s.id OR i.shift_id=s.id) AND p.status IN ('initiated','pending','unknown')
  ) THEN RAISE EXCEPTION 'نتیجهٔ پرداخت شیفت هنوز مشخص نیست؛ ابتدا آن را تطبیق دهید'; END IF;
  v_date := platform.business_date(s.opened_at);

  SELECT id INTO v_batch FROM ledger.posting_batch
   WHERE kind = 'shift' AND shift_id = p_shift;
  IF v_batch IS NULL THEN
    INSERT INTO ledger.posting_batch (branch_id, kind, shift_id, business_date)
    VALUES (s.branch_id, 'shift', p_shift, v_date)
    ON CONFLICT DO NOTHING RETURNING id INTO v_batch;
    IF v_batch IS NULL THEN
      SELECT id INTO v_batch FROM ledger.posting_batch
       WHERE kind = 'shift' AND shift_id = p_shift;
    END IF;
  END IF;

  SELECT r.sale_entry, r.cogs_entry INTO v_sale, v_cogs_e
    FROM sales.post_batch(v_batch, p_user) r;

  -- ۱) نقد فروش و بازپرداخت مرجوعی
  SELECT coalesce(sum(p.amount) FILTER (WHERE p.direction = 'in'),  0),
         coalesce(sum(p.amount) FILTER (WHERE p.direction = 'out'), 0)
    INTO v_cash_in, v_cash_out
    FROM treasury.payment p
    JOIN treasury.payment_method m ON m.code = p.method_code
   WHERE p.shift_id = p_shift AND m.kind = 'cash'
     AND p.status IN ('succeeded','settled','reconciled');

  -- ۲) هر حرکت نقد غیرفروشی که به همین شیفت نسبت داده شده
  SELECT coalesce(sum(t.amount) FILTER (WHERE ta.kind = 'cash_box'), 0),
         coalesce(sum(t.amount) FILTER (WHERE fa.kind = 'cash_box'), 0)
    INTO v_tx_in, v_tx_out
    FROM treasury.transaction t
    LEFT JOIN treasury.account ta ON ta.id = t.to_account_id
    LEFT JOIN treasury.account fa ON fa.id = t.from_account_id
   WHERE t.shift_id = p_shift AND t.status = 'posted';

  v_expected := s.opening_cash + v_cash_in + v_tx_in - v_cash_out - v_tx_out;
  v_variance := p_counted_cash - v_expected;

  IF v_variance <> 0 THEN
    PERFORM ledger.post_entry(
      'shift_variance', s.branch_id, v_date,
      'مغایرت صندوق — شیفت ' || to_char(s.opened_at, 'YYYY-MM-DD HH24:MI'),
      jsonb_build_array(
        jsonb_build_object('leg','cash',    'amount', v_variance),
        jsonb_build_object('leg','variance','amount', v_variance)),
      'cash_shift', p_shift, p_user);
  END IF;

  UPDATE sales.cash_shift
     SET closed_at = now(), counted_cash = p_counted_cash,
         expected_cash = v_expected, variance = v_variance,
         variance_note = p_note, close_review = NULL, status = 'closed'
   WHERE id = p_shift;

  PERFORM platform.audit('shift.close', 'cash_shift', p_shift::text,
    jsonb_build_object('opening', s.opening_cash,
                       'sale_cash_in', v_cash_in, 'refund_cash_out', v_cash_out,
                       'treasury_in', v_tx_in,    'treasury_out', v_tx_out,
                       'expected', v_expected, 'counted', p_counted_cash,
                       'variance', v_variance),
    p_user, p_note);

  RETURN QUERY SELECT v_sale, v_cogs_e, v_variance;
END $function$;

-- Even with a paid draft a legitimate closing count includes its cash payment by shift_id.
-- Keep the guard against uncounted raw status updates.
DROP TRIGGER cash_shift_open_draft_cash_guard ON sales.cash_shift;
CREATE TRIGGER cash_shift_open_draft_cash_guard BEFORE UPDATE OF status ON sales.cash_shift
  FOR EACH ROW WHEN (NEW.counted_cash IS NULL) EXECUTE FUNCTION sales.cash_shift_open_draft_cash_guard();

CREATE FUNCTION sales.auto_close_due_shifts(p_actor uuid, p_user uuid DEFAULT NULL, p_branch uuid DEFAULT NULL) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE s sales.cash_shift%ROWTYPE; issue text; ended integer := 0;
BEGIN
  FOR s IN SELECT * FROM sales.cash_shift WHERE status='open' AND sale_ended_at IS NULL
    AND (p_user IS NULL OR user_id=p_user) AND (p_branch IS NULL OR branch_id=p_branch)
    AND sale_cutoff_at<=clock_timestamp() ORDER BY sale_cutoff_at,id FOR UPDATE SKIP LOCKED
  LOOP
    issue := NULL;
    IF s.opening_cash<>0 OR EXISTS (SELECT 1 FROM sales.shift_cash_flows(s.id) f
      WHERE f.cash_in<>0 OR f.cash_out<>0 OR f.tx_in<>0 OR f.tx_out<>0) THEN
      issue := 'گردش نقد یا تنخواه ثبت شده؛ شمارش واقعی کشو لازم است.';
    ELSIF EXISTS (SELECT 1 FROM treasury.payment p LEFT JOIN sales.invoice i ON i.id=p.invoice_id
      WHERE (p.shift_id=s.id OR i.shift_id=s.id) AND p.status IN ('initiated','pending','unknown')) THEN
      issue := 'نتیجهٔ دریافت وجه مشخص نیست؛ با مرجع پرداخت تطبیق دهید.';
    ELSE
      BEGIN
        PERFORM sales.close_shift(s.id,0,p_actor,'بستن خودکار شیفت بدون نقد در پایان روز تهران');
      EXCEPTION WHEN OTHERS THEN
        issue := 'بستن مالی انجام نشد؛ پرداخت، خزانه و دورهٔ دفتر را بررسی کنید.';
      END;
    END IF;
    UPDATE sales.cash_shift SET sale_ended_at=s.sale_cutoff_at,close_review=issue WHERE id=s.id;
    PERFORM platform.audit('shift.midnight','cash_shift',s.id::text,jsonb_build_object('review',issue),p_actor);
    ended := ended+1;
  END LOOP;
  RETURN ended;
END $$;

CREATE FUNCTION sales.require_trading_shift() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cutoff timestamptz; ended timestamptz;
BEGIN
  IF NEW.shift_id IS NOT NULL THEN
    SELECT sale_cutoff_at,sale_ended_at INTO cutoff,ended FROM sales.cash_shift WHERE id=NEW.shift_id FOR SHARE;
    IF ended IS NOT NULL OR cutoff<=clock_timestamp() THEN
      RAISE EXCEPTION 'زمان فروش این شیفت به پایان رسیده است؛ شیفت امروز را باز کنید';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_trading_shift BEFORE INSERT OR UPDATE OF shift_id,status ON sales.invoice
  FOR EACH ROW WHEN (NEW.channel='pos' AND NEW.status IN ('draft','finalized','paid'))
  EXECUTE FUNCTION sales.require_trading_shift();
CREATE TRIGGER payment_trading_shift BEFORE INSERT ON treasury.payment
  FOR EACH ROW WHEN (NEW.shift_id IS NOT NULL) EXECUTE FUNCTION sales.require_trading_shift();

COMMIT;
