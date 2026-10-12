\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE v_id uuid; v_number text; v_before numeric;
BEGIN
  SELECT last_value INTO v_before FROM sales.invoice_number_counter;
  INSERT INTO sales.invoice(branch_id,warehouse_id)
  VALUES('00000000-0000-7000-8000-000000000001','00000000-0000-7000-8000-000000000101') RETURNING id INTO v_id;
  IF sales.invoice_display_number(v_id) IS NOT NULL THEN RAISE EXCEPTION 'پیش‌نویس شمارهٔ قطعی گرفت'; END IF;
  BEGIN
    UPDATE sales.invoice SET number='123' WHERE id=v_id;
    RAISE EXCEPTION 'شمارهٔ پیش‌نویس پذیرفته شد' USING ERRCODE='check_violation';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'شمارهٔ فروش فقط هنگام نهایی‌سازی تخصیص می‌یابد' THEN RAISE; END IF;
  END;
  UPDATE sales.invoice SET number='',status='finalized' WHERE id=v_id RETURNING number INTO v_number;
  IF v_number IS DISTINCT FROM (v_before+1)::text OR sales.invoice_display_number(v_id) IS DISTINCT FROM v_number THEN
    RAISE EXCEPTION 'شمارهٔ سراسری با سند یکسان نیست';
  END IF;
  IF sales.finalize_invoice(v_id) IS DISTINCT FROM v_number THEN RAISE EXCEPTION 'تکرار شماره را تغییر داد'; END IF;
  BEGIN
    UPDATE sales.invoice_number SET number='999' WHERE invoice_id=v_id;
    RAISE EXCEPTION 'نگاشت بازنویسی شد' USING ERRCODE='check_violation';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'شمارهٔ قطعی فاکتور تغییرپذیر نیست' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE sales.invoice SET number='999' WHERE id=v_id;
    RAISE EXCEPTION 'شمارهٔ سند بازنویسی شد' USING ERRCODE='check_violation';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'شمارهٔ قطعی فاکتور تغییرپذیر نیست' THEN RAISE; END IF;
  END;
  RAISE NOTICE '✓ شمارهٔ عددی، پیش‌نویس، تکرار و تغییرناپذیری';
END $$;
ROLLBACK;
