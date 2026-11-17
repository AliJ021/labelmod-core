-- =====================================================================
-- داربست آزمون: سال‌های مالی تا «امروز» — فقط دیتابیس یک‌بارمصرف
-- =====================================================================
-- Seed فقط سال ۱۴۰۵ را می‌سازد (تا ۲۰۲۷/۰۳/۲۰). آزمون‌ها با ساعت واقعی
-- کار می‌کنند، پس از ۲۰۲۷/۰۳/۲۱ هر آزمونی که سند بزند رد می‌شد — بی‌آنکه
-- کدی خراب شده باشد. اندازه‌گیری شد (پستگرس زیر libfaketime، ۲۰۲۷/۰۴/۱۵):
-- ۲۹ پرونده از ۷۸ پروندهٔ SQL قرمز و ۱۵۳۶ ادعا از ۲۱۱۶ سبز.
--
-- این پرونده پس از `seed` سال‌های بعدی را با **همان** `ledger.open_fiscal_year`
-- تولیدی باز می‌کند تا امروز پوشیده شود. تا پایان ۱۴۰۵ هیچ کاری نمی‌کند.
--
-- ⚠️ **در تولید اجرا نمی‌شود و نباید بشود.** تاریخ سال مالی واقعی را حسابدار
--    تأیید می‌کند (`ops/open-fiscal-year.sh`)؛ اینجا طول سال از قاعدهٔ ۳۳ سالهٔ
--    کبیسه حساب می‌شود که برای آزمون کافی است، نه برای دفتر واقعی. نگهبان
--    پایین روی دیتابیسی که سند یا فاکتور دارد می‌ایستد.
-- ⚠️ عمداً در `db/test/` نیست (آن گلوب هر پرونده را آزمون می‌شمارد) و در
--    `db/seed/` هم نیست (Seed نصب تازهٔ تولیدی را هم می‌سازد).
--
-- ⚠️ بی فرمان psql (`\set` و مانند آن): آزمون‌های ارتقای تاریخی این پرونده را از راه
--    درایور Node هم اجرا می‌کنند. `ON_ERROR_STOP` را فراخوان psql می‌دهد.
-- ⚠️ روی اسکیمای **پیش از مهاجرت ۱۱۷** تابع `open_fiscal_year` وجود ندارد؛ آنجا همان
--    دو درج (سال و شمارنده‌ها) مستقیم انجام می‌شود. فقط آزمون‌های ارتقای تاریخی به این
--    شاخه می‌رسند.
--
-- مصرف‌کننده‌ها: `ops/db.sh test`، `apps/api/test/helpers/disposable-db.ts` و
-- `apps/api/test/numeric-invoice.integration.test.ts` (اسکیمای ۰۹۴).
-- =====================================================================

DO $fixture$
DECLARE
  v_last   ledger.fiscal_year%ROWTYPE;
  v_year   int;
  v_days   int;
  v_opened int := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM ledger.journal_entry) OR EXISTS (SELECT 1 FROM sales.invoice) THEN
    RAISE EXCEPTION 'این داربست فقط روی دیتابیس تازهٔ آزمون اجرا می‌شود؛ این دیتابیس سند یا فاکتور دارد.';
  END IF;

  -- کاربر «سیستم» Seed؛ `open_fiscal_year` بی کاربر عامل رد می‌کند.
  PERFORM platform.set_actor('00000000-0000-7000-8000-0000000000f1'::uuid);

  LOOP
    SELECT * INTO v_last FROM ledger.fiscal_year ORDER BY ends_on DESC LIMIT 1;
    EXIT WHEN v_last.ends_on >= platform.business_date();
    v_year := v_last.id + 1;
    -- کبیسهٔ هجری شمسی در چرخهٔ ۳۳ ساله (معتبر برای ۱۳۴۳ تا ۱۴۷۲).
    v_days := CASE WHEN v_year % 33 IN (1, 5, 9, 13, 17, 22, 26, 30) THEN 366 ELSE 365 END;
    IF to_regprocedure('ledger.open_fiscal_year(smallint, date, date)') IS NOT NULL THEN
      PERFORM ledger.open_fiscal_year(v_year::smallint, v_last.ends_on + 1, v_last.ends_on + v_days);
    ELSE
      INSERT INTO ledger.fiscal_year (id, starts_on, ends_on, status)
      VALUES (v_year, v_last.ends_on + 1, v_last.ends_on + v_days, 'open');
      INSERT INTO platform.document_counter (branch_id, doc_type, fiscal_year, prefix)
      SELECT c.branch_id, c.doc_type, v_year, replace(c.prefix, v_last.id::text, v_year::text)
        FROM platform.document_counter c WHERE c.fiscal_year = v_last.id;
    END IF;
    v_opened := v_opened + 1;
    IF v_opened > 50 THEN
      RAISE EXCEPTION 'بیش از ۵۰ سال مالی باز شد؛ ساعت دیتابیس یا Seed را بررسی کنید.';
    END IF;
  END LOOP;
END $fixture$;
