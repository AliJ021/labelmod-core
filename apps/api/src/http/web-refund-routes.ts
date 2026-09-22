import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { AuthError } from "../auth/service.ts";
import { requireForSession } from "../auth/permission.ts";
import type { Db } from "../db/client.ts";
import { runOnce, setActor } from "../lib/idempotency.ts";
import { assertBranch } from "../sales/scope.ts";
import { ReturnError } from "../sales/return.ts";

const money = z.string().regex(/^\d+$/);
const bodySchema = z.object({
  orderId: z.string().trim().min(1).max(64),
  refundId: z.string().trim().min(1).max(64),
  amount: money.refine((x) => BigInt(x) > 0n),
  shippingAmount: money.default("0"),
  lines: z.array(z.object({
    lineNo: z.number().int().positive(),
    qty: z.string().regex(/^\d+(\.\d{1,3})?$/).refine((x) => Number(x) > 0),
    restock: z.boolean(),
  })).min(1).max(200),
});

/** Records a refund already performed in WooCommerce; never contacts a PSP. */
export function registerWebRefundRoutes(app: FastifyInstance, db: Db): void {
  app.post("/web/refunds", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const s = req.session;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    const body = bodySchema.parse(req.body);
    await requireForSession(db, s, "web.refund");
    if (new Set(body.lines.map((x) => x.lineNo)).size !== body.lines.length) {
      throw new ReturnError("duplicate_line", "قلم مرجوعی تکراری است", 422);
    }
    // A site may only return an order ingested by that same API identity.
    // A guessed invoice UUID or another site's external order ID is insufficient.
    const original = await sql<{ invoice_id: string; branch_id: string; payment_method: string }>`
      SELECT i.id AS invoice_id,i.branch_id,m.payload->>'paymentMethod' AS payment_method
      FROM platform.inbox_message m JOIN sales.invoice i ON i.id::text=m.result_ref
      WHERE m.source='api.web.order' AND m.event_id=${`woo-order:${body.orderId}`}
        AND m.payload->>'actorId'=${s.userId} AND i.channel='web'
    `.execute(db);
    const order = original.rows[0];
    if (!order) throw new ReturnError("web_order_not_found", "سفارش متعلق به این اتصال یافت نشد", 404);
    await assertBranch(db, s.userId, order.branch_id);
    const method = await db.selectFrom("treasury.payment_method").select(["kind", "is_active"])
      .where("code", "=", order.payment_method).executeTakeFirst();
    if (!method?.is_active || !["gateway", "card_reader", "transfer"].includes(method.kind)) {
      throw new ReturnError("manual_refund_required", "بازپرداخت این روش باید با صندوق مشخص در حسابداری ثبت شود", 422);
    }
    const result = await runOnce<string>(db, {
      key: `woo-refund:${s.userId}:${body.refundId}`, source: "api.web.refund",
      payload: { actorId: s.userId, ...body },
      run: async (trx) => {
        await setActor(trx, s.userId);
        const inv = await trx.selectFrom("sales.invoice").select(["id", "warehouse_id", "status"])
          .where("id", "=", order.invoice_id).forUpdate().executeTakeFirstOrThrow();
        if (!["finalized", "paid", "partially_returned"].includes(inv.status)) {
          throw new ReturnError("invoice_not_returnable", "فاکتور قابل مرجوعی نیست", 409);
        }
        const inserted = await sql<{ id: string }>`
          INSERT INTO sales.sale_return(branch_id,invoice_id,warehouse_id,reason_code,reason_note,
             refund_amount,refund_method,shipping_amount,created_by)
          VALUES(${order.branch_id}::uuid,${inv.id}::uuid,${inv.warehouse_id}::uuid,'web_refund',
            ${`Woo refund ${body.refundId}`},${body.amount}::numeric,${order.payment_method},
            ${body.shippingAmount}::numeric,${s.userId}::uuid) RETURNING id
        `.execute(trx);
        const id = inserted.rows[0]!.id;
        for (const line of body.lines) {
          const found = await trx.selectFrom("sales.invoice_line").select("id")
            .where("invoice_id", "=", inv.id).where("line_no", "=", line.lineNo).executeTakeFirst();
          if (!found) throw new ReturnError("line_not_found", "قلم سفارش یافت نشد", 422);
          await sql`INSERT INTO sales.sale_return_line(return_id,invoice_line_id,qty,restock,unit_price,net_amount,unit_cost,cogs_amount)
            VALUES(${id}::uuid,${found.id}::uuid,${line.qty}::numeric,${line.restock},0,0,0,0)`.execute(trx);
        }
        await sql`SELECT sales.post_return(${id}::uuid,${s.userId}::uuid)`.execute(trx);
        const checked = await sql<{ matches: boolean }>`SELECT net_amount+tax_amount+shipping_amount=refund_amount AS matches
          FROM sales.sale_return WHERE id=${id}::uuid`.execute(trx);
        if (!checked.rows[0]?.matches) {
          throw new ReturnError("refund_amount_mismatch", "مبلغ مرجوعی سایت با ارزش اقلام و مالیات حسابداری برابر نیست؛ هیچ سندی ثبت نشد", 422);
        }
        return { value: id, ref: id };
      },
      replay: async (id) => id,
    });
    const row = await db.selectFrom("sales.sale_return").select(["id", "number", "status", "refund_amount"])
      .where("id", "=", result.value).executeTakeFirstOrThrow();
    return reply.code(result.replayed ? 200 : 201).send({ returnId: row.id, number: row.number,
      status: row.status, refundAmount: row.refund_amount, replayed: result.replayed });
  });
}
