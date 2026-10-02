import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "kysely";
import { AuthError, type ResolvedSession } from "../auth/service.ts";
import { requireForSession } from "../auth/permission.ts";
import { requireHumanSession, requireManualReturnChannel } from "../auth/human-session.ts";
import { runOnce } from "../lib/idempotency.ts";
import { assertBranch, assertWarehouseInBranch } from "../sales/scope.ts";
import { requireInvoiceRead } from "../sales/invoice-access.ts";
import { ExchangeService, type ExchangeInput } from "../sales/exchange.ts";
import { ReturnError } from "../sales/return.ts";
import type { ReturnRouteDeps } from "./return-routes.ts";

const uuid = z.string().uuid();
const qty = z.string().regex(/^\d{1,11}(\.\d{1,3})?$/).refine(v => !/^0+(\.0+)?$/.test(v), "تعداد باید مثبت باشد");
const code = z.string().regex(/^[a-z0-9_]{1,64}$/);
const quoteBody = z.object({
  invoiceId: uuid, warehouseId: uuid, returnWarehouseId: uuid,
  lines: z.array(z.object({ invoiceLineId: uuid, qty, restock: z.boolean().optional(),
    condition: z.enum(["sellable", "defective"]).optional() })).min(1).max(200),
  replacements: z.array(z.object({ variationId: uuid, qty })).min(1).max(200),
  reasonCode: code, reasonNote: z.string().trim().max(500).optional(),
});
const postBody = quoteBody.extend({ token: z.string().regex(/^[a-f0-9]{64}$/),
  collectMethod: code.optional(), collectReference: z.string().trim().min(1).max(200).optional(),
  refundMethod: code.optional(), refundReference: z.string().trim().min(1).max(200).optional(), refundPaymentId: uuid.optional(),
  confirmed: z.literal(true),
});

export function registerExchangeRoutes(app: FastifyInstance, deps: ReturnRouteDeps): void {
  const { db, returns, shifts } = deps;
  const exchanges = new ExchangeService(db);
  const session = (value: unknown): ResolvedSession => {
    if (!value) throw new AuthError("no_session", "وارد نشده‌اید");
    return value as ResolvedSession;
  };
  async function gate(s: ResolvedSession, input: ExchangeInput) {
    await requireInvoiceRead(db, s);
    const inv = await db.selectFrom("sales.invoice").select("branch_id").where("id", "=", input.invoiceId).executeTakeFirst();
    if (!inv) throw new ReturnError("invoice_not_found", "فاکتور یافت نشد", 404);
    await assertBranch(db, s.userId, inv.branch_id);
    await assertWarehouseInBranch(db, input.warehouseId, inv.branch_id);
    await assertWarehouseInBranch(db, input.returnWarehouseId, inv.branch_id);
    const wh = await db.selectFrom("inventory.warehouse").select("kind").where("id", "=", input.warehouseId).executeTakeFirstOrThrow();
    if (["defective", "in_transit"].includes(wh.kind)) throw new ReturnError("exchange_warehouse", "جایگزین باید از انبار قابل فروش خارج شود", 422);
    await requireManualReturnChannel(db, input.invoiceId);
    await requireHumanSession(db, s);
    await requireForSession(db, s, "sale.create");
    const window = await returns.returnWindow(input.invoiceId);
    await requireForSession(db, s, window.late ? "return.late" : "return.same_day");
    return inv.branch_id;
  }
  app.post("/exchanges/quote", async req => {
    const s = session(req.session);
    const body = quoteBody.parse(req.body);
    await gate(s, body);
    await returns.assertReasonCode(body.reasonCode);
    return exchanges.quote(body);
  });
  app.get("/exchanges/variation/:id", async req => {
    const s = session(req.session);
    await requireForSession(db, s, "sale.create");
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await db.selectFrom("catalog.variation as v").innerJoin("catalog.product as p", "p.id", "v.product_id")
      .select(["v.id", "v.sku", "p.name_internal as name"]).where("v.id", "=", id).executeTakeFirst();
    if (!row) throw new ReturnError("variation_not_found", "کالا یافت نشد", 404);
    return row;
  });
  app.post("/exchanges", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async req => {
    const s = session(req.session);
    const body = postBody.parse(req.body);
    const key = uuid.parse(req.headers["idempotency-key"]);
    const branchId = await gate(s, body);
    const result = await runOnce(db, {
      key, source: `api.exchange.${s.userId}`, payload: body,
      run: async trx => {
        await requireHumanSession(trx, s);
        await requireManualReturnChannel(trx, body.invoiceId);
        const { token: _token, collectMethod: _collect, collectReference: _collectRef,
          refundMethod: _refund, refundReference: _refundRef, refundPaymentId: _payment, confirmed: _confirmed, ...quoteInput } = body;
        const q = await exchanges.quote(quoteInput, trx);
        if (q.token !== body.token) throw new ReturnError("exchange_quote_changed", "تسویه تغییر کرده؛ پیش‌نمایش تازه را تأیید کنید");
        if (BigInt(q.refundAmount)>0n) {
          await requireForSession(trx, s, "refund.cash", { amount: BigInt(q.refundAmount) });
          await returns.assertRefundMethod(body.refundMethod ?? "cash");
        }
        if (BigInt(q.collectAmount)>0n) {
          const method = await trx.selectFrom("treasury.payment_method").select("kind")
            .where("code", "=", body.collectMethod ?? "").where("is_active", "=", true).executeTakeFirst();
          if (!method || !["cash", "card_reader", "gateway", "transfer"].includes(method.kind))
            throw new ReturnError("bad_exchange_payment", "دریافت اختلاف فقط با روش دریافت وجه فعال ممکن است", 422);
        }
        const shift = await shifts.current(s.userId, branchId);
        if (!shift) throw new ReturnError("no_open_shift", "برای تعویض باید شیفت باز داشته باشید", 422);
        const id = await exchanges.postIn(trx, { ...body, actorId: s.userId, shiftId: shift.id });
        return { value: id, ref: id };
      }, replay: async ref => ref,
    });
    return { ...(await exchanges.byId(result.value)), replayed: result.replayed, status: "posted" };
  });
  // نبود رکورد ممکن است پاسخ درخواستِ در حال رسیدن باشد؛ پایان عملیات محسوب نمی‌شود.
  app.get("/exchanges/status/:key", async req => {
    const s = session(req.session);
    await requireInvoiceRead(db, s);
    const { key } = z.object({ key: uuid }).parse(req.params);
    const inbox = await db.selectFrom("platform.inbox_message").select(["result_ref", "payload"])
      .where("source", "=", `api.exchange.${s.userId}`).where("event_id", "=", key).executeTakeFirst();
    if (inbox && (inbox.payload as { abandoned?: boolean })?.abandoned) return { status: "abandoned" };
    if (!inbox?.result_ref) return { status: "not_found" };
    const value = await exchanges.byId(inbox.result_ref);
    if (!value) return { status: "not_found" };
    await assertBranch(db, s.userId, value.branchId);
    return { status: "posted", ...value };
  });
  app.post("/exchanges/status/:key/abandon", async req => {
    const s = session(req.session);
    await requireHumanSession(db, s);
    await requireForSession(db, s, "sale.create");
    const { key } = z.object({ key: uuid }).parse(req.params);
    z.object({ noExternalPayment: z.literal(true) }).parse(req.body);
    // قید Inbox با ثبت هم‌زمان مسابقه را حل می‌کند؛ درخواست دیررس دیگر اثر نمی‌گذارد.
    await db.transaction().execute(async trx => {
      await trx.insertInto("platform.inbox_message").values({ source: `api.exchange.${s.userId}`, event_id: key,
        payload: JSON.stringify({ abandoned: true }), result_ref: null })
        .onConflict(oc => oc.columns(["source", "event_id"]).doNothing()).execute();
      await sql`SELECT platform.audit('exchange.abandon','exchange_intent',${key},'{}'::jsonb,${s.userId}::uuid)`.execute(trx);
    });
    return { checked: true };
  });
}
