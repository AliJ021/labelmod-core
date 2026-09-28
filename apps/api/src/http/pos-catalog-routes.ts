import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { AuthError, type ResolvedSession } from "../auth/service.ts";
import { requireForSession } from "../auth/permission.ts";
import { assertBranch, ScopeError } from "../sales/scope.ts";

/** جست‌وجوی صندوق مجوز فروش می‌خواهد، نه مجوز تغییر کاتالوگ. */
export function registerPosCatalogRoutes(app: FastifyInstance, db: Db): void {
  async function scope(raw: unknown, warehouseId: string) {
    const s = raw as ResolvedSession | null;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    await requireForSession(db, s, "sale.create");
    const wh = await db.selectFrom("inventory.warehouse").select(["branch_id"])
      .where("id", "=", warehouseId).where("is_active", "=", true).executeTakeFirst();
    if (!wh) throw new ScopeError("انبار یافت نشد");
    await assertBranch(db, s.userId, wh.branch_id);
  }
  app.get("/pos/products", async (req) => {
    const q = z.object({ q: z.string().trim().min(2).max(80), warehouseId: z.string().uuid() }).parse(req.query);
    await scope(req.session, q.warehouseId);
    const term = q.q.normalize("NFKC").replace(/[يى]/g, "ی").replace(/ك/g, "ک").replace(/[۰-۹٠-٩]/g, c => String(c.charCodeAt(0) - (c >= "۰" ? 1776 : 1632))).replace(/[\u200c\u200d\s]+/g, " ").trim();
    const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
    const result = await sql<{ id: string; name: string; code: string; variationCount: number }>`
      SELECT p.id, p.name_internal AS name, p.code, count(v.id)::int AS "variationCount"
      FROM catalog.product p JOIN catalog.variation v ON v.product_id=p.id
      WHERE p.status='active' AND v.status='active'
        AND (regexp_replace(translate(p.name_internal, 'يك', 'یک'), '[‌‍[:space:]]+', ' ', 'g') ILIKE ${pattern} OR regexp_replace(translate(p.name_web, 'يك', 'یک'), '[‌‍[:space:]]+', ' ', 'g') ILIKE ${pattern} OR p.code ILIKE ${pattern})
      GROUP BY p.id ORDER BY p.name_internal, p.id LIMIT 50
    `.execute(db);
    const exact = await sql<{ id: string }>`SELECT v.id FROM catalog.variation v
      JOIN catalog.product p ON p.id=v.product_id
      WHERE p.status='active' AND v.status='active' AND (v.barcode=${term} OR v.sku=${term})
      ORDER BY v.id LIMIT 2`.execute(db);
    // Ambiguous identifiers require explicit variant choice, never an arbitrary first row.
    return { products: result.rows, exactVariationId: exact.rows.length === 1 ? exact.rows[0]!.id : null };
  });
  app.get("/pos/products/:id/variations", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { warehouseId } = z.object({ warehouseId: z.string().uuid() }).parse(req.query);
    await scope(req.session, warehouseId);
    const result = await sql<{
      id: string; sku: string; barcode: string | null; color: string | null; size: string | null;
      price: string | null; available: string; status: string;
    }>`SELECT v.id, v.sku, v.barcode, v.color, v.size, v.status,
        pr.amount::text AS price, (coalesce(sb.on_hand,0)-coalesce(sb.reserved,0))::text AS available
      FROM catalog.variation v JOIN catalog.product p ON p.id=v.product_id
      LEFT JOIN inventory.stock_balance sb ON sb.variation_id=v.id AND sb.warehouse_id=${warehouseId}::uuid
      LEFT JOIN LATERAL (SELECT amount FROM catalog.price WHERE variation_id=v.id
        AND price_list='default' AND valid_from<=now() AND (valid_to IS NULL OR valid_to>now())
        ORDER BY valid_from DESC LIMIT 1) pr ON true
      WHERE p.id=${id}::uuid AND p.status='active' AND v.status='active'
      ORDER BY v.color NULLS FIRST, v.size NULLS FIRST, v.sku
    `.execute(db);
    return { variations: result.rows };
  });
}
