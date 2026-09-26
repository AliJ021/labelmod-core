BEGIN;
-- پیام سایت در صف تأیید می‌ماند؛ این جدول برگ مالی مرجوعی نیست.
CREATE TABLE sales.web_refund_request (
  id uuid PRIMARY KEY REFERENCES identity.approval_request(id),
  invoice_id uuid NOT NULL REFERENCES sales.invoice(id),
  branch_id uuid NOT NULL REFERENCES platform.branch(id),
  payment_method text NOT NULL REFERENCES treasury.payment_method(code),
  return_id uuid UNIQUE REFERENCES sales.sale_return(id),
  reviewer_session_id uuid,
  decision_note text
);
CREATE INDEX ON sales.web_refund_request(branch_id,id);
INSERT INTO identity.permission_rule(role_code,operation,allowed,max_amount,max_percent,needs_approval_from)
SELECT code,'web.refund.review',true,NULL,NULL,NULL FROM identity.role WHERE code IN ('admin','accountant')
ON CONFLICT(role_code,operation) DO NOTHING;
COMMIT;
