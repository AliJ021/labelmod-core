-- شعبه‌ای که پرونده مشتری را ساخته است.
--
-- خود مشتری در کل کسب‌وکار با موبایل یکتا می‌ماند، اما این رابطه تعیین
-- می‌کند کدام شعبه حق دیدن و ویرایش اطلاعات حساس پرونده را دارد. مشتریان
-- قدیمی از شعبه فاکتورهایشان پر می‌شوند؛ مشتری بدون هیچ رابطه یا فاکتور
-- فقط برای نقش سراسری قابل دسترس است.
CREATE TABLE sales.customer_branch (
  customer_id uuid NOT NULL REFERENCES sales.customer(id),
  branch_id   uuid NOT NULL REFERENCES platform.branch(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, branch_id)
);

INSERT INTO sales.customer_branch (customer_id, branch_id)
SELECT DISTINCT customer_id, branch_id
  FROM sales.invoice
 WHERE customer_id IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE INDEX customer_branch_branch_idx
  ON sales.customer_branch (branch_id, customer_id);
