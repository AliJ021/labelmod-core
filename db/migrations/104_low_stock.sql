-- ═══════════════════════════════════════════════════════════════════
-- ۱۰۴ — کمبود موجودی (R04، بند ۶ گسترش داشبورد): یک آستانه و یک تعریف
-- ═══════════════════════════════════════════════════════════════════
--
-- میان‌بر داشبورد و گزارش «کمبود موجودی» هر دو از همین تابع می‌خوانند؛
-- دو تعریف یعنی شمار داشبورد با فهرستی که پیوندش باز می‌کند نخواند.
--
-- تعریف — هر سطر یک (تنوع، انبار) است، نه یک تنوع:
--   • انبار فعال و قابل‌فروش: store، stock، outlet — همان مرز ستون
--     «قابل‌فروش» گزارش ارزش موجودی. معیوب و در راه فروختنی نیستند.
--   • کالا و تنوع هر دو `active`. تنوعِ متوقف، پیش‌سفارش یا بایگانی و کالای بایگانی کمبود نیستند.
--   • فقط تنوعی که در همان انبار سطر موجودی دارد («ردیابی‌شده»). تنوعی که
--     هرگز به این انبار نیامده، صفرِ آن انبار شمرده نمی‌شود — وگرنه هر
--     انبار تازه هر کالای فروشگاه را «کمبود» نشان می‌داد.
--   • قابل‌فروش = on_hand − reserved، کف صفر؛ و کمبود یعنی ≤ آستانه.
--     ناموجود (صفر) هم کمبود است.
--
-- آستانه داده است، نه کد: `inventory.low_stock_threshold`. نبودِ آن
-- (NULL) یعنی «نامعلوم» — تابع با آستانهٔ NULL هیچ سطری نمی‌دهد و
-- مصرف‌کننده باید NULL را جدا گزارش کند، نه صفر.
--
-- فقط‌خواندنی: نه جدولی، نه تغییری در داده.

INSERT INTO platform.setting(key, value, description, requires_approval, kind, label, group_key,
                             min_value, max_value, unit, help, sort_order, permission, is_editable)
VALUES ('inventory.low_stock_threshold', '2'::jsonb,
  'آستانهٔ کمبود موجودی برای داشبورد و گزارش «کمبود موجودی».', false,
  'int', 'آستانهٔ کمبود موجودی', 'inventory', 0, 9999, 'عدد',
  'تنوعی که موجودی قابل‌فروشش در یک انبار فروش به این عدد یا کمتر برسد، «کمبود» شمرده می‌شود (ناموجود هم). فقط تنوع‌هایی که در همان انبار سابقهٔ موجودی دارند شمرده می‌شوند. این عدد فقط هشدار است و فروش یا موجودی را تغییر نمی‌دهد.',
  60, 'settings.manage', true)
ON CONFLICT (key) DO NOTHING;

CREATE FUNCTION inventory.low_stock(p_threshold numeric)
RETURNS TABLE (warehouse_id uuid, branch_id uuid, variation_id uuid,
               on_hand platform.qty, reserved platform.qty, available platform.qty)
LANGUAGE sql STABLE
SET search_path = pg_catalog, platform, inventory, catalog
AS $$
  SELECT w.id, w.branch_id, b.variation_id, b.on_hand, b.reserved,
         greatest(b.on_hand - b.reserved, 0)::platform.qty
    FROM inventory.stock_balance b
    JOIN inventory.warehouse w ON w.id = b.warehouse_id
    JOIN catalog.variation v ON v.id = b.variation_id
    JOIN catalog.product p ON p.id = v.product_id
   WHERE p_threshold IS NOT NULL
     AND w.is_active AND w.kind IN ('store', 'stock', 'outlet')
     AND v.status = 'active' AND p.status = 'active'
     AND greatest(b.on_hand - b.reserved, 0) <= p_threshold
$$;

COMMENT ON FUNCTION inventory.low_stock(numeric) IS
  'سطرهای (تنوع، انبار) کمبود موجودی: انبار فعال فروش، کالا و تنوع فعال، ردیابی‌شده، قابل‌فروش ≤ آستانه. آستانهٔ NULL هیچ سطری نمی‌دهد.';
