import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { AuthError } from "../auth/service.ts";
import { requireForSession } from "../auth/permission.ts";
import type { Db } from "../db/client.ts";
import { runOnce, setActor } from "../lib/idempotency.ts";
import { assertBranch } from "../sales/scope.ts";
import { ReturnError } from "../sales/return.ts";
import { registerWebRefundReviewRoutes, webRefundResponse } from "./web-refund-review-routes.ts";
import { wooRefundBodySchema } from "./web-refund-body.ts";

/** پیام سایت فقط در صف بررسی ذخیره می‌شود؛ هیچ PSP یا سند مالی اینجا تغییر نمی‌کند. */
export function registerWebRefundRoutes(app: FastifyInstance, db: Db): void {
  app.post("/web/refunds", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const s = req.session;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    const body = wooRefundBodySchema.parse(req.body);
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
    const result = await runOnce<string>(db, {
      key: `woo-refund:${s.userId}:${body.refundId}`, source: "api.web.refund",
      payload: { actorId: s.userId, ...body },
      run: async (trx) => {
        await setActor(trx, s.userId);
        const request = await sql<{ id: string }>`
          INSERT INTO identity.approval_request(operation,requested_by,reason,context)
          VALUES('web.refund.review',${s.userId}::uuid,'بررسی مستقل مرجوعی اعلام‌شده توسط سایت',${JSON.stringify(body)}::jsonb)
          RETURNING id`.execute(trx);
        const id = request.rows[0]!.id;
        await sql`INSERT INTO sales.web_refund_request(id,invoice_id,branch_id,payment_method)
          VALUES(${id}::uuid,${order.invoice_id}::uuid,${order.branch_id}::uuid,${order.payment_method})`.execute(trx);
        await sql`SELECT platform.audit('web.refund.request','approval_request',${id},NULL,${s.userId}::uuid)`.execute(trx);
        return { value: id, ref: id };
      },
      replay: async (id) => id,
    });
    return reply.code(result.replayed ? 200 : 201).send({
      ...await webRefundResponse(db, result.value), replayed: result.replayed });
  });
  registerWebRefundReviewRoutes(app, db);
}
