-- دامنه شعبه در پیشنهاد سایز باید پیش از جمع موجودی و محدودکردن نتیجه اعمال شود.
BEGIN;

CREATE OR REPLACE FUNCTION catalog.fitting_variations(
  p_customer uuid, p_warehouse uuid, p_min_score numeric, p_limit int,
  p_branches uuid[]
) RETURNS TABLE (
  variation_id uuid, sku text, product_name text, color text, size text,
  season text, on_hand platform.qty, match_score numeric, matched_keys int
) LANGUAGE sql STABLE AS $$
  WITH avail AS (
    SELECT b.variation_id, sum(b.on_hand) AS qty
      FROM inventory.stock_balance b
      JOIN inventory.warehouse w ON w.id = b.warehouse_id
     WHERE (p_warehouse IS NULL OR b.warehouse_id = p_warehouse)
       AND (p_branches IS NULL OR w.branch_id = ANY(p_branches))
     GROUP BY b.variation_id
    HAVING sum(b.on_hand) > 0
  )
  SELECT v.id, v.sku, p.name_internal, v.color, v.size, p.season,
         a.qty, f.score, f.matched_keys
    FROM avail a
    JOIN catalog.variation v ON v.id = a.variation_id AND v.status = 'active'
    JOIN catalog.product p ON p.id = v.product_id AND p.status = 'active'
    LEFT JOIN LATERAL catalog.fit_score(v.id, p_customer) f ON true
   WHERE p_min_score IS NULL OR f.score >= p_min_score
   ORDER BY f.score DESC NULLS LAST, p.name_internal, v.size
   LIMIT p_limit;
$$;

COMMENT ON FUNCTION catalog.fitting_variations(uuid,uuid,numeric,int,uuid[]) IS
  'دامنه را API از نقش معتبر می‌گیرد؛ NULL همه شعب، آرایه خالی هیچ شعبه. فیلتر پیش از جمع و LIMIT است.';

-- قرارداد فراخوان‌های داخلی قبلی حفظ می‌شود؛ API نسخه دارای دامنه را فراخوانی می‌کند.
CREATE OR REPLACE FUNCTION catalog.fitting_variations(
  p_customer uuid, p_warehouse uuid DEFAULT NULL,
  p_min_score numeric DEFAULT NULL, p_limit int DEFAULT 50
) RETURNS TABLE (
  variation_id uuid, sku text, product_name text, color text, size text,
  season text, on_hand platform.qty, match_score numeric, matched_keys int
) LANGUAGE sql STABLE AS $$
  SELECT * FROM catalog.fitting_variations(p_customer,p_warehouse,p_min_score,p_limit,NULL::uuid[]);
$$;

COMMIT;
