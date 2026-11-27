BEGIN;
SET LOCAL lock_timeout='5s';

INSERT INTO platform.setting(key,value,description,kind,label,group_key,help,sort_order,permission,is_editable)
VALUES ('report.shared_accounts','""','کد حساب‌های هزینهٔ مشترک','text','حساب‌های هزینهٔ مشترک','reports','کد حساب‌های هزینه مثل اجاره را با ویرگول جدا کنید. خالی یعنی هزینه‌ها فقط در جمع فروشگاه دیده شوند.',80,'settings.manage',true),
('report.shared_weights','""','تقسیم نمایشی هزینهٔ مشترک','text','درصد حضوری، سایت، اینستاگرام','reports','مثلاً ۵۰،۳۰،۲۰. جمع باید صد باشد. خالی یعنی تقسیم خاموش است.',81,'settings.manage',true);

CREATE FUNCTION ledger.check_shared_cost_settings() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cleaned text; weights int[];
BEGIN
  cleaned := regexp_replace(translate(NEW.value#>>'{}','۰۱۲۳۴۵۶۷۸۹،','0123456789,'),'[[:space:]]','','g');
  IF cleaned='' THEN RETURN NEW; END IF;
  IF NEW.key='report.shared_weights' THEN
    IF cleaned !~ '^[0-9]{1,3},[0-9]{1,3},[0-9]{1,3}$' THEN RAISE EXCEPTION 'سه درصد را با ویرگول وارد کنید'; END IF;
    weights:=string_to_array(cleaned,',')::int[];
    IF weights[1]+weights[2]+weights[3]<>100 THEN RAISE EXCEPTION 'جمع سه درصد باید صد باشد'; END IF;
  ELSIF EXISTS(SELECT FROM unnest(string_to_array(cleaned,',')) c
    WHERE NOT EXISTS (SELECT FROM ledger.account a WHERE a.code=c AND a.type='expense' AND a.is_postable))
    THEN RAISE EXCEPTION 'هر کد باید یک حساب هزینهٔ قابل ثبت باشد'; END IF;
  NEW.value:=to_jsonb(cleaned); RETURN NEW;
END $$;
CREATE TRIGGER validate_shared_cost BEFORE UPDATE OF value ON platform.setting FOR EACH ROW
WHEN (NEW.key IN ('report.shared_weights','report.shared_accounts')) EXECUTE FUNCTION ledger.check_shared_cost_settings();

CREATE FUNCTION ledger.financial_statements(p_from date,p_to date,p_branch uuid)
RETURNS TABLE(section text,label text,amount numeric) LANGUAGE sql STABLE AS $$
 WITH trial AS (SELECT * FROM ledger.report_trial_balance(p_from,p_to,p_branch)),
 balance AS (SELECT coalesce(sum(closing_balance) FILTER(WHERE account_type='asset'),0) assets,
  -coalesce(sum(closing_balance) FILTER(WHERE account_type='liability'),0) liabilities,
  -coalesce(sum(closing_balance) FILTER(WHERE account_type='equity'),0) equity,
  -coalesce(sum(closing_balance) FILTER(WHERE account_type IN ('revenue','contra_revenue','expense')),0) retained FROM trial),
 flow AS (SELECT a.type,a.code,sum(l.credit-l.debit) AS net FROM ledger.journal_line l
  JOIN ledger.journal_entry e ON e.id=l.entry_id JOIN ledger.account a ON a.code=l.account_code
  WHERE e.entry_date BETWEEN p_from AND p_to AND e.status IN ('confirmed','final') AND e.kind NOT IN ('opening','closing')
  AND (p_branch IS NULL OR e.branch_id=p_branch) AND a.type IN ('revenue','contra_revenue','expense') GROUP BY a.type,a.code),
 totals AS (SELECT coalesce(sum(net) FILTER(WHERE type IN ('revenue','contra_revenue')),0) revenue,
  -coalesce(sum(net) FILTER(WHERE type='expense'),0) expenses,
  -coalesce(sum(net) FILTER(WHERE type='expense' AND code=ANY(string_to_array(platform.setting_text('report.shared_accounts',''),','))),0) shared FROM flow),
 config AS (SELECT string_to_array(nullif(platform.setting_text('report.shared_weights',''),''),',')::int[] AS w),
 shares AS (SELECT shared,trunc(shared*w[1]/100) pos,trunc(shared*w[2]/100) web FROM totals,config WHERE w IS NOT NULL AND platform.setting_text('report.shared_accounts','')<>'')
 SELECT v.* FROM balance,totals CROSS JOIN LATERAL (VALUES
  ('سود و زیان','درآمد خالص',revenue),('سود و زیان','هزینه‌ها و بهای تمام‌شده',expenses),('سود و زیان','سود یا زیان دوره',revenue-expenses)) v
 UNION ALL SELECT v.* FROM balance CROSS JOIN LATERAL (VALUES ('ترازنامه','دارایی‌ها',assets),('ترازنامه','بدهی‌ها',liabilities),
  ('ترازنامه','حقوق مالکانهٔ ثبت‌شده',equity),('ترازنامه','نتیجهٔ انتقال‌نیافته به حقوق مالکانه',retained),('ترازنامه','اختلاف تراز',assets-liabilities-equity-retained)) v
 UNION ALL SELECT v.* FROM shares CROSS JOIN LATERAL (VALUES('سهم هزینهٔ مشترک','حضوری',pos),('سهم هزینهٔ مشترک','سایت',web),
  ('سهم هزینهٔ مشترک','اینستاگرام',shared-pos-web)) v
$$;
COMMIT;
