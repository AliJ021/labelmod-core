BEGIN;
INSERT INTO identity.permission_rule(role_code,operation,allowed,max_amount,max_percent,needs_approval_from)
SELECT code,'web.refund',true,NULL,NULL,NULL FROM identity.role WHERE code='web'
ON CONFLICT(role_code,operation) DO NOTHING;
COMMIT;
