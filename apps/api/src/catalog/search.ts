/**
 * جست‌وجوی کالای فعال با نام / کد / بارکد — **یک تعریف** برای صندوق
 * (`/pos/products`) و رسید خرید (`/receipts/:id/products`).
 *
 * نرمال‌سازی (ی/ک عربی، رقم فارسی و عربی، نیم‌فاصله) و الگوی ILIKE یک بار
 * اینجا نوشته شده است؛ دو نسخه یعنی کالایی که صندوق پیدا می‌کند و انباردار نه.
 * بارکد و SKU **دقیق** جدا سنجیده می‌شوند: شناسهٔ مبهم (بیش از یک تنوع) هرگز
 * یک سطر دلخواه را برنمی‌گزیند.
 */
import { sql } from "kysely";
import type { Db } from "../db/client.ts";

export function normalizeSearchTerm(q: string): string {
  return q.normalize("NFKC").replace(/[يى]/g, "ی").replace(/ك/g, "ک")
    .replace(/[۰-۹٠-٩]/g, c => String(c.charCodeAt(0) - (c >= "۰" ? 1776 : 1632)))
    .replace(/[‌‍\s]+/g, " ").trim();
}

export interface ProductHit { id: string; name: string; code: string; variationCount: number }

export async function searchActiveProducts(db: Db, term: string): Promise<{ products: ProductHit[]; exactVariationId: string | null; exactProductId: string | null }> {
  // Human queries combine name/size/colour on one variant. Identifier fragments
  // are searched as a whole query: digits in an unrelated SKU must not supply size.
  const identifierPattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
  const predicates = term.split(/\s+/).filter(Boolean).map(token => {
    const pattern = `%${token.replace(/[\\%_]/g, "\\$&")}%`;
    return sql`regexp_replace(translate(concat_ws(' ', p.name_internal, p.name_web,
      v.color, v.size),
      'يكى۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩', 'یکی01234567890123456789'),
      '[‌‍[:space:]]+', ' ', 'g') ILIKE ${pattern}`;
  });
  const result = await sql<ProductHit>`
    SELECT p.id, p.name_internal AS name, p.code, count(all_v.id)::int AS "variationCount"
    FROM catalog.product p JOIN catalog.variation all_v ON all_v.product_id=p.id
    WHERE p.status='active' AND all_v.status='active'
      AND EXISTS (SELECT 1 FROM catalog.variation v
        WHERE v.product_id=p.id AND v.status='active' AND (
          (${predicates.length ? sql.join(predicates, sql` AND `) : sql`false`})
          OR (${term !== ''} AND regexp_replace(translate(concat_ws(' ', p.code, v.sku, v.barcode),
            'يكى۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩', 'یکی01234567890123456789'),
            '[‌‍[:space:]]+', ' ', 'g') ILIKE ${identifierPattern})
        ))
    GROUP BY p.id ORDER BY p.name_internal, p.id LIMIT 50
  `.execute(db);
  const exact = await sql<{ id: string; product_id: string }>`SELECT v.id, v.product_id FROM catalog.variation v
    JOIN catalog.product p ON p.id=v.product_id
    WHERE p.status='active' AND v.status='active' AND (v.barcode=${term} OR v.sku=${term})
    ORDER BY v.id LIMIT 2`.execute(db);
  // Ambiguous identifiers require explicit variant choice, never an arbitrary first row.
  const one = exact.rows.length === 1 ? exact.rows[0]! : null;
  return { products: result.rows, exactVariationId: one?.id ?? null, exactProductId: one?.product_id ?? null };
}
