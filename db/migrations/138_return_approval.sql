BEGIN;
SET LOCAL lock_timeout = '5s';
INSERT INTO platform.setting(key,value,description,kind,label,group_key,min_value,max_value,unit,help,sort_order,permission,is_editable)
VALUES ('return.full_review','false','تأیید مستقل ابطال کامل','bool','تأیید مدیر برای برگشت همهٔ اقلام','sales',NULL,NULL,NULL,'با روشن کردن، فروشنده ابتدا درخواست می‌دهد. مدیر دیگری در بخش مرجوعی آن را بررسی می‌کند.',91,'settings.security',true),
('return.full_review_min','0','حداقل وجه برگشتی مشمول تأیید','int','حداقل بازپرداخت برای تأیید مدیر','sales',0,2147483647,'تومان','صفر یعنی هر ابطال کامل، حتی اگر مشتری بدهکار بوده است.',92,'settings.security',true);
CREATE TABLE sales.return_approval (
 id uuid PRIMARY KEY REFERENCES identity.approval_request(id),
 actor_id uuid NOT NULL REFERENCES identity.app_user(id),
 intent text NOT NULL,
 invoice_id uuid NOT NULL REFERENCES sales.invoice(id),
 branch_id uuid NOT NULL REFERENCES platform.branch(id),
 consumed_by uuid REFERENCES sales.sale_return(id),
 UNIQUE(actor_id,intent)
);
COMMIT;
