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
  const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
  const result = await sql<ProductHit>`
    SELECT p.id, p.name_internal AS name, p.code, count(v.id)::int AS "variationCount"
    FROM catalog.product p JOIN catalog.variation v ON v.product_id=p.id
    WHERE p.status='active' AND v.status='active'
      AND (regexp_replace(translate(p.name_internal, 'يك', 'یک'), '[‌‍[:space:]]+', ' ', 'g') ILIKE ${pattern} OR regexp_replace(translate(p.name_web, 'يك', 'یک'), '[‌‍[:space:]]+', ' ', 'g') ILIKE ${pattern} OR p.code ILIKE ${pattern})
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
