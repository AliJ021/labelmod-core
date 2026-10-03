\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.eq(label text,actual numeric,expected numeric) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION '%: % != %',label,actual,expected; END IF; END $$;
DO $$
DECLARE a record; failed boolean;
BEGIN
 SELECT * INTO a FROM sales.exchange_allocation(1000,1200,0,1000,'unset');
 PERFORM pg_temp.eq('گران‌تر: دریافت اختلاف',a.collect_amount,200);
 PERFORM pg_temp.eq('گران‌تر: پشتوانه منتقل‌شده',a.funded_transfer,1000);
 SELECT * INTO a FROM sales.exchange_allocation(1000,700,0,1000,'unset');
 PERFORM pg_temp.eq('ارزان‌تر: بازپرداخت اختلاف',a.refund_amount,300);
 PERFORM pg_temp.eq('ارزان‌تر: سقف جایگزین',a.funded_transfer,700);
 SELECT * INTO a FROM sales.exchange_allocation(1000,1200,600,400,'debt_first');
 PERFORM pg_temp.eq('ابتدا بدهی',a.debt_applied,600);
 PERFORM pg_temp.eq('ابتدا بدهی: دریافت مانده جایگزین',a.collect_amount,800);
 PERFORM pg_temp.eq('بدون اعتبار عمومی',a.transfer_amount,400);
 SELECT * INTO a FROM sales.exchange_allocation(1000,1200,600,400,'carry_debt');
 PERFORM pg_temp.eq('حفظ بدهی',a.debt_applied,0);
 PERFORM pg_temp.eq('حفظ بدهی: اختلاف',a.collect_amount,200);
 PERFORM pg_temp.eq('حفظ بدهی: پول گرفته‌نشده قابل بازپرداخت نیست',a.funded_transfer,400);
 SELECT * INTO a FROM sales.exchange_allocation(999999999999999990,999999999999999999,0,999999999999999990,'unset');
 PERFORM pg_temp.eq('پول بزرگ بدون float',a.collect_amount,9);
 failed:=false;
 BEGIN PERFORM sales.exchange_allocation(1000,700,1000,0,'carry_debt');
 EXCEPTION WHEN raise_exception THEN failed:=true; END;
 IF NOT failed THEN RAISE EXCEPTION 'تعارض بازپرداخت از وجه دریافت‌نشده پذیرفته شد'; END IF;
 failed:=false;
 BEGIN PERFORM sales.exchange_allocation(1000,1000,1,999,'unset');
 EXCEPTION WHEN raise_exception THEN failed:=true; END;
 IF NOT failed THEN RAISE EXCEPTION 'سیاست تعیین‌نشده برای بدهکار پذیرفته شد'; END IF;
END $$;
ROLLBACK;
