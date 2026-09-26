import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { AuthError } from "../auth/service.ts";
import { requireHumanSession } from "../auth/human-session.ts";
import { requireForSession } from "../auth/permission.ts";
import type { Db } from "../db/client.ts";
import { setActor } from "../lib/idempotency.ts";
import { assertBranch, ScopeError } from "../sales/scope.ts";
import { ReturnError } from "../sales/return.ts";
import { postWooReturn } from "./web-refund-post.ts";
import { wooRefundBodySchema, type WooRefundBody } from "./web-refund-body.ts";

interface RequestRow {
  id: string; invoice_id: string; branch_id: string; payment_method: string;
  requested_by: string; status: "pending" | "approved" | "rejected";
  context: WooRefundBody; return_id: string | null; decision_note: string | null;
}

export async function webRefundResponse(db: Db, id: string) {
  const result = await sql<RequestRow>`SELECT r.*,a.requested_by,a.status,a.context
    FROM sales.web_refund_request r JOIN identity.approval_request a ON a.id=r.id WHERE r.id=${id}::uuid`.execute(db);
  const request = result.rows[0];
  // Inboxهای پیشین به برگ قطعی اشاره می‌کنند؛ retry همان نتیجهٔ تاریخی را می‌گیرد.
  const returnId = request ? request.return_id : id;
  if (returnId) {
    const row = await db.selectFrom("sales.sale_return").select(["id", "number", "status", "refund_amount"])
      .where("id", "=", returnId).executeTakeFirstOrThrow();
    return { ...(request ? { requestId: request.id } : {}), returnId: row.id,
      number: row.number, status: row.status, refundAmount: row.refund_amount };
  }
  if (!request) throw new ReturnError("request_not_found", "درخواست یافت نشد", 404);
  return { requestId: request.id, status: request.status, refundAmount: request.context.amount,
    reason: request.decision_note };
}

export function registerWebRefundReviewRoutes(app: FastifyInstance, db: Db): void {
  app.get("/web-refund-requests", async (req) => {
    const s = req.session;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    const { branchId } = z.object({ branchId: z.uuid() }).parse(req.query);
    await requireHumanSession(db, s);
    await requireForSession(db, s, "web.refund.review");
    await assertBranch(db, s.userId, branchId);
    const rows = await sql<{ id: string; invoiceId: string; number: string; payload: WooRefundBody; status: string; requestedAt: Date; requestedBy: string }>`
      SELECT r.id,r.invoice_id AS "invoiceId",i.number,a.context AS payload,a.status,
        a.requested_at AS "requestedAt",u.full_name AS "requestedBy"
      FROM sales.web_refund_request r JOIN identity.approval_request a ON a.id=r.id
      JOIN sales.invoice i ON i.id=r.invoice_id JOIN identity.app_user u ON u.id=a.requested_by
      WHERE r.branch_id=${branchId}::uuid AND a.status='pending' ORDER BY a.requested_at,r.id LIMIT 200
    `.execute(db);
    return { items: rows.rows };
  });

  app.post("/web-refund-requests/:id/decision", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const s = req.session;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const decision = z.object({ decision: z.enum(["approved", "rejected"]), reason: z.string().trim().min(3).max(500) }).strict().parse(req.body);
    await db.transaction().execute(async (trx) => {
      await requireHumanSession(trx, s);
      await requireForSession(trx, s, "web.refund.review");
      const found = await sql<RequestRow>`SELECT r.*,a.requested_by,a.status,a.context FROM sales.web_refund_request r
        JOIN identity.approval_request a ON a.id=r.id WHERE r.id=${id}::uuid FOR UPDATE OF r,a`.execute(trx);
      const request = found.rows[0];
      if (!request) throw new ReturnError("request_not_found", "درخواست یافت نشد", 404);
      await assertBranch(trx, s.userId, request.branch_id);
      if (request.requested_by === s.userId) throw new ScopeError("ارسال‌کننده نمی‌تواند مرجوعی خودش را تأیید یا رد کند");
      if (request.status !== "pending") {
        if (request.status !== decision.decision || request.decision_note !== decision.reason) {
          throw new ReturnError("request_already_decided", "برای این درخواست تصمیم نهایی ثبت شده است", 409);
        }
        return;
      }
      // تصمیم نهایی به تبدیل دادهٔ قدیمی وابسته نیست؛ رد کردن هم اثر مالی ندارد.
      const payload = decision.decision === "approved" ? wooRefundBodySchema.parse(request.context) : null;
      if (payload) {
        await requireForSession(trx, s, "web.refund.review", { amount: BigInt(payload.amount) });
      }
      await setActor(trx, s.userId);
      const returnId = payload ? await postWooReturn(trx, s, request, payload) : null;
      await sql`UPDATE identity.approval_request SET status=${decision.decision},approved_by=${s.userId}::uuid,
        decided_at=clock_timestamp() WHERE id=${id}::uuid`.execute(trx);
      await sql`UPDATE sales.web_refund_request SET return_id=${returnId}::uuid,reviewer_session_id=${s.sessionId}::uuid,
        decision_note=${decision.reason} WHERE id=${id}::uuid`.execute(trx);
      await sql`SELECT platform.audit('web.refund.decide','approval_request',${id},
        ${JSON.stringify({ ...decision, returnId })}::jsonb,${s.userId}::uuid)`.execute(trx);
    });
    return webRefundResponse(db, id);
  });
}
