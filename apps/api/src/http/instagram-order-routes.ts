/**
 * «سفارش اینستاگرام» — مسیرهای HTTP. قرارداد: docs/INSTAGRAM-ORDERS.md.
 *
 * - **مجوز:** `instagram.order.manage` برای ساخت، ویرایش، رزرو، لغو و ارسال؛
 *   `instagram.payment.verify` برای تطبیق واریز. دومی در `auth.pin_forbidden_operations` است و
 *   علاوه بر آن نشست انسانیِ کامل می‌خواهد (کلید API یا نشست PIN تصمیم مالی نمی‌گیرد).
 * - **دامنه:** هر سفارش به شعبهٔ خودش؛ `assertBranch` پیش از هر خواندن و نوشتن.
 * - **جست‌وجو در بدنهٔ POST است، نه نشانی:** موبایل و نام کاربری مشتری نباید در لاگ دسترسی
 *   Caddy بنشینند (همان درس «سفارش‌های سایت»).
 * - **تأیید واریز Idempotency-Key اجباری دارد** و پاسخ گم‌شده با همان کلید حل می‌شود.
 */
import { sql, type Transaction } from "kysely";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AuthError, type ResolvedSession } from "../auth/service.ts";
import { can, requireForSession } from "../auth/permission.ts";
import { requireHumanSession } from "../auth/human-session.ts";
import type { Db } from "../db/client.ts";
import type { Database } from "../db/types.ts";
import { parseMoney } from "../lib/money.ts";
import { runOnce } from "../lib/idempotency.ts";
import { hasControlChars, CONTROL_CHARS_MESSAGE } from "../lib/text.ts";
import { InvoiceError, type InvoiceService } from "../sales/invoice.ts";
import { assertBranch, assertWarehouseInBranch } from "../sales/scope.ts";
import { assertMarkdownAllowed as markdownGate } from "../sales/markdown-gate.ts";
import { InstagramOrderService, ORDER_STATUSES, SHIPPING_STATES, type OrderRow } from "../sales/instagram-order.ts";

const uuid = z.string().uuid("شناسه نامعتبر");
const money = z.string().regex(/^\d{1,18}$/, "مبلغ باید رشتهٔ عددی ریالی باشد");
const text = (max: number, min = 0) => z.string().min(min).max(max).refine((v) => !hasControlChars(v), CONTROL_CHARS_MESSAGE);

const createBody = z.object({
  branchId: uuid,
  warehouseId: uuid,
  customerMobile: z.string().min(1).max(32),
  customerName: text(120).optional(),
  instagramUsername: text(40).nullable().optional(),
  shipAddress: text(500).optional(),
  shipMethod: text(80).optional(),
  shippingAmount: money.optional(),
  receivingAccountId: uuid.nullable().optional(),
}).strict();

const headerBody = z.object({
  shipAddress: text(500).optional(),
  shipMethod: text(80).optional(),
  instagramUsername: text(40).nullable().optional(),
  receivingAccountId: uuid.nullable().optional(),
  shippingAmount: money.optional(),
}).strict();

const lineBody = z.object({
  variationId: uuid,
  qty: z.number().int().min(1).max(999),
  discountAmount: money.optional(),
  discountReason: text(200).optional(),
}).strict();

const confirmBody = z.object({
  version: z.number().int().positive(),
  accountId: uuid,
  amount: money,
  refNo: text(64, 1),
  paidAt: z.string().datetime({ offset: true }),
}).strict();

const listQuery = z.object({
  branchId: uuid.optional(),
  status: z.enum(ORDER_STATUSES).optional(),
  attention: z.enum(["1"]).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
}).strict();

const searchBody = z.object({
  q: text(64, 2),
  branchId: uuid.optional(),
}).strict();

const PAGE = 30;

export function registerInstagramOrderRoutes(app: FastifyInstance, deps: { db: Db; invoices: InvoiceService }): void {
  const { db, invoices } = deps;
  const orders = new InstagramOrderService(db, invoices);

  const session = (req: { session: unknown }) => {
    const s = req.session as (ResolvedSession & { userId: string; pinUnlocked: boolean }) | null;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    return s;
  };
  const idem = (req: { headers: Record<string, unknown> }) => {
    const raw = req.headers["idempotency-key"];
    return typeof raw === "string" && raw.length > 0 && raw.length <= 200 ? raw : undefined;
  };

  /**
   * هر ویرایش Idempotency-Key می‌پذیرد (قاعدهٔ CLAUDE.md): پاسخ گم‌شدهٔ «افزودن قلم» با همان کلید
   * Replay است، نه قلم دوم. بی کلید همان یک تراکنش است. `replayed` از Replay کلید یا از خودِ عملیات.
   */
  async function edit(req: { headers: Record<string, unknown> }, s: { userId: string }, op: string, orderId: string,
    payload: unknown, run: (trx: Transaction<Database>) => Promise<boolean | void>): Promise<boolean> {
    let inner = false;
    const out = await runOnce<string>(db, {
      key: idem(req),
      source: `api.instagram_order.${op}`,
      payload: { actorId: s.userId, orderId, body: payload ?? null },
      run: async (trx) => { inner = (await run(trx)) === true; return { value: orderId, ref: orderId }; },
      replay: async (ref) => ref,
    });
    return out.replayed || inner;
  }

  /** خواندن: دارندهٔ هر یک از دو مجوز. */
  async function requireRead(s: { userId: string; pinUnlocked: boolean }) {
    const manage = await can(db, { userId: s.userId, operation: "instagram.order.manage", viaPin: s.pinUnlocked });
    if (manage.verdict === "allow") return;
    await requireForSession(db, s, "instagram.payment.verify");
  }
  async function scoped(s: { userId: string }, id: string): Promise<OrderRow> {
    const o = await orders.byId(id);
    if (!o) throw new InvoiceError("order_not_found", "سفارش اینستاگرام یافت نشد", 404);
    await assertBranch(db, s.userId, o.branch_id);
    return o;
  }
  async function branchFilter(userId: string, branchId: string | undefined): Promise<string[] | null> {
    if (branchId) { await assertBranch(db, userId, branchId); return [branchId]; }
    const rows = await db.selectFrom("identity.user_role").select("branch_id").where("user_id", "=", userId).execute();
    if (rows.some((r) => r.branch_id === null)) return null;
    return rows.map((r) => r.branch_id as string);
  }

  app.get("/instagram-orders/accounts", async (req) => {
    const s = session(req);
    await requireRead(s);
    const { branchId } = z.object({ branchId: uuid }).strict().parse(req.query);
    await assertBranch(db, s.userId, branchId);
    const r = await sql<{ id: string; code: string; name: string; bank_name: string | null; account_no: string | null }>`
      SELECT id, code, name, bank_name, account_no FROM treasury.account
       WHERE kind = 'bank' AND is_active AND (branch_id IS NULL OR branch_id = ${branchId}::uuid)
       ORDER BY code`.execute(db);
    return { accounts: r.rows.map((a) => ({ id: a.id, code: a.code, name: a.name, bankName: a.bank_name, accountNo: a.account_no })) };
  });

  app.get("/instagram-orders", async (req) => {
    const s = session(req);
    await requireRead(s);
    const q = listQuery.parse(req.query);
    const branches = await branchFilter(s.userId, q.branchId);
    return listOrders(db, { branches, status: q.status ?? null, attention: q.attention === "1", page: q.page, search: null });
  });

  app.post("/instagram-orders/search", async (req) => {
    const s = session(req);
    await requireRead(s);
    const body = searchBody.parse(req.body ?? {});
    const branches = await branchFilter(s.userId, body.branchId);
    return listOrders(db, { branches, status: null, attention: false, page: 1, search: body.q.trim() });
  });

  app.get("/instagram-orders/receipts", async (req) => {
    const s = session(req);
    await requireRead(s);
    const q = z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), branchId: uuid.optional(),
    }).strict().parse(req.query);
    const branches = await branchFilter(s.userId, q.branchId);
    const r = await sql<{ paid_date: string; account_id: string; code: string; name: string; n: string; total: string }>`
      SELECT ip.paid_date::text, a.id AS account_id, a.code, a.name, count(*)::text AS n, sum(ip.amount)::text AS total
        FROM sales.instagram_payment ip
        JOIN sales.instagram_order io ON io.id = ip.order_id
        JOIN treasury.account a ON a.id = ip.account_id
       WHERE ip.payment_id IS NOT NULL AND ip.paid_date BETWEEN ${q.from}::date AND ${q.to}::date
         AND (${branches === null} OR io.branch_id = ANY(${branches ?? []}::uuid[]))
       GROUP BY 1, 2, 3, 4 ORDER BY 1, 3`.execute(db);
    return {
      receipts: r.rows.map((x) => ({ paidDate: x.paid_date, accountId: x.account_id, accountCode: x.code, accountName: x.name,
        count: Number(x.n), total: x.total })),
    };
  });

  app.get("/instagram-orders/:id", async (req) => {
    const s = session(req);
    await requireRead(s);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await scoped(s, id);
    return orderDetail(db, id);
  });

  app.post("/instagram-orders", async (req, reply) => {
    const s = session(req);
    await requireForSession(db, s, "instagram.order.manage");
    const body = createBody.parse(req.body);
    await assertBranch(db, s.userId, body.branchId);
    await assertWarehouseInBranch(db, body.warehouseId, body.branchId);
    const out = await runOnce<string>(db, {
      key: idem(req),
      source: "api.instagram_order.create",
      payload: { actorId: s.userId, ...body },
      run: async (trx) => {
        const { shippingAmount, ...rest } = body;
        const id = await orders.createIn(trx, {
          ...rest, actorId: s.userId,
          ...(shippingAmount === undefined ? {} : { shippingAmount: parseMoney(shippingAmount) }),
        });
        return { value: id, ref: id };
      },
      replay: async (ref) => ref,
    });
    return reply.code(out.replayed ? 200 : 201).send({ ...(await orderDetail(db, out.value)), replayed: out.replayed });
  });

  app.patch("/instagram-orders/:id", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "instagram.order.manage");
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = headerBody.parse(req.body ?? {});
    await scoped(s, id);
    const replayed = await edit(req, s, "update", id, body, (trx) => orders.updateHeader(id, {
      ...body, actorId: s.userId,
      shippingAmount: body.shippingAmount === undefined ? undefined : parseMoney(body.shippingAmount),
    }, trx));
    return { ...(await orderDetail(db, id)), replayed };
  });

  app.post("/instagram-orders/:id/lines", async (req, reply) => {
    const s = session(req);
    await requireForSession(db, s, "instagram.order.manage");
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = lineBody.parse(req.body);
    await scoped(s, id);
    const discount = body.discountAmount ? parseMoney(body.discountAmount) : 0n;
    const replayed = await edit(req, s, "line.add", id, body, (trx) => orders.addLine(id, {
      variationId: body.variationId, qty: body.qty, actorId: s.userId,
      ...(discount > 0n ? { discountAmount: discount, discountReason: body.discountReason } : {}),
    }, (t, line) => markdownGate(t, invoices, s, {
      variationId: line.variationId, qty: line.qty, discount: line.discountAmount,
      settingPrice: line.unitPrice, listPrice: line.listPrice,
    }), trx));
    return reply.code(replayed ? 200 : 201).send({ ...(await orderDetail(db, id)), replayed });
  });

  app.patch("/instagram-orders/:id/lines/:lineId", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "instagram.order.manage");
    const { id, lineId } = z.object({ id: uuid, lineId: uuid }).parse(req.params);
    const { qty } = z.object({ qty: z.number().int().min(1).max(999) }).strict().parse(req.body);
    await scoped(s, id);
    const replayed = await edit(req, s, "line.qty", id, { lineId, qty }, (trx) => orders.setLineQty(id, lineId, qty, s.userId, trx));
    return { ...(await orderDetail(db, id)), replayed };
  });

  app.delete("/instagram-orders/:id/lines/:lineId", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "instagram.order.manage");
    const { id, lineId } = z.object({ id: uuid, lineId: uuid }).parse(req.params);
    await scoped(s, id);
    const replayed = await edit(req, s, "line.remove", id, { lineId }, (trx) => orders.removeLine(id, lineId, s.userId, trx));
    return { ...(await orderDetail(db, id)), replayed };
  });

  app.post("/instagram-orders/:id/reserve", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "instagram.order.manage");
    const { id } = z.object({ id: uuid }).parse(req.params);
    await scoped(s, id);
    const replayed = await edit(req, s, "reserve", id, null, async (trx) => (await orders.reserve(id, s.userId, trx)).replayed);
    return { ...(await orderDetail(db, id)), replayed };
  });

  app.post("/instagram-orders/:id/unreserve", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "instagram.order.manage");
    const { id } = z.object({ id: uuid }).parse(req.params);
    await scoped(s, id);
    const replayed = await edit(req, s, "unreserve", id, null, async (trx) => (await orders.release(id, s.userId, "draft", undefined, trx)).replayed);
    return { ...(await orderDetail(db, id)), replayed };
  });

  app.post("/instagram-orders/:id/cancel", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "instagram.order.manage");
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { reason } = z.object({ reason: text(300).refine((v) => v.trim().length > 0, "دلیل لغو لازم است") }).strict().parse(req.body);
    await scoped(s, id);
    const replayed = await edit(req, s, "cancel", id, { reason }, async (trx) => (await orders.release(id, s.userId, "cancelled", reason.trim(), trx)).replayed);
    return { ...(await orderDetail(db, id)), replayed };
  });

  app.post("/instagram-orders/:id/payment-state", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "instagram.order.manage");
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ state: z.enum(["none", "claimed", "review"]), note: text(300).nullable().optional() }).strict().parse(req.body);
    await scoped(s, id);
    const replayed = await edit(req, s, "payment_state", id, body, (trx) => orders.markPayment(id, s.userId, body.state, body.note?.trim() || null, trx));
    return { ...(await orderDetail(db, id)), replayed };
  });

  app.post("/instagram-orders/:id/shipping", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "instagram.order.manage");
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ state: z.enum(SHIPPING_STATES), trackingCode: text(80).nullable().optional() }).strict().parse(req.body);
    await scoped(s, id);
    const replayed = await edit(req, s, "shipping", id, body, (trx) => orders.setShipping(id, s.userId, body.state, body.trackingCode?.trim() || null, trx));
    return { ...(await orderDetail(db, id)), replayed };
  });

  /**
   * تطبیق واریز و نهایی‌سازی. کلید اجباری است: پاسخی که گم شود با همان کلید حل می‌شود و
   * هرگز دریافت یا فاکتور دوم نمی‌سازد. سنجش نشست انسانی **داخل همان تراکنش** است.
   */
  app.post("/instagram-orders/:id/confirm", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "instagram.payment.verify");
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = confirmBody.parse(req.body);
    const key = idem(req);
    if (!key) throw new InvoiceError("idempotency_required", "شناسه یکتای درخواست لازم است.", 400);
    await scoped(s, id);
    const out = await runOnce<string>(db, {
      key,
      source: "api.instagram_order.confirm",
      payload: { actorId: s.userId, orderId: id, ...body },
      run: async (trx) => {
        await requireHumanSession(trx, s);
        const r = await orders.confirmIn(trx, id, {
          version: body.version, accountId: body.accountId, amount: parseMoney(body.amount),
          refNo: body.refNo, paidAt: new Date(body.paidAt), actorId: s.userId,
        });
        return { value: r.invoiceId, ref: r.invoiceId };
      },
      replay: async (ref) => ref,
    });
    return { ...(await orderDetail(db, id)), replayed: out.replayed };
  });
}

// ─────────────────────────────────────────────────────────────────────
// خواندن
// ─────────────────────────────────────────────────────────────────────

interface ListOpts { branches: string[] | null; status: string | null; attention: boolean; page: number; search: string | null }

async function listOrders(db: Db, o: ListOpts) {
  const offset = (o.page - 1) * PAGE;
  // «نیازمند رسیدگی»: واریز ادعاشده یا مشکوک، یا رزرو سررسیده‌ای که به‌خاطر واریزِ در جریان آزاد نشده.
  const r = await sql<{
    id: string; order_no: string; status: string; payment_state: string; shipping_state: string;
    instagram_username: string | null; customer_name: string | null; mobile: string | null;
    payable: string; reserved_until: Date | null; created_at: Date; branch_id: string; total: string;
  }>`
    SELECT io.id, io.order_no, io.status, io.payment_state, io.shipping_state, io.instagram_username,
           c.full_name AS customer_name, c.mobile_normalized AS mobile, i.payable_amount::text AS payable,
           io.reserved_until, io.created_at, io.branch_id, count(*) OVER ()::text AS total
      FROM sales.instagram_order io
      JOIN sales.invoice i ON i.id = io.invoice_id
      JOIN sales.customer c ON c.id = io.customer_id
     WHERE (${o.branches === null} OR io.branch_id = ANY(${o.branches ?? []}::uuid[]))
       AND (${o.status}::text IS NULL OR io.status = ${o.status})
       AND (NOT ${o.attention} OR io.payment_state IN ('claimed','review')
            OR (io.status = 'reserved' AND io.reserved_until <= now()))
       AND (${o.search}::text IS NULL
            OR io.order_no ILIKE ${o.search} || '%'
            OR c.mobile_normalized = nullif(sales.normalize_mobile(${o.search ?? ""}), '')
            OR io.instagram_username = lower(ltrim(${o.search ?? ""}, '@'))
            OR c.full_name ILIKE '%' || ${o.search} || '%')
     ORDER BY io.created_at DESC, io.id DESC
     LIMIT ${PAGE} OFFSET ${offset}`.execute(db);
  const total = Number(r.rows[0]?.total ?? 0);
  return {
    page: o.page, perPage: PAGE, total, pages: Math.max(1, Math.ceil(total / PAGE)),
    orders: r.rows.map((x) => ({
      id: x.id, orderNo: x.order_no, status: x.status, paymentState: x.payment_state, shippingState: x.shipping_state,
      instagramUsername: x.instagram_username, customerName: x.customer_name, mobile: x.mobile,
      payable: x.payable, reservedUntil: x.reserved_until?.toISOString() ?? null,
      createdAt: x.created_at.toISOString(), branchId: x.branch_id,
    })),
  };
}

type SyncState = "off" | "not_site_warehouse" | "none" | "queued" | "sent" | "error" | "unknown";

/** وضعیت صادقانهٔ Push موجودی هر کالا به سایت؛ خواندن ناموفق «نامعلوم» است، نه «سالم». */
async function syncStates(db: Db, warehouseId: string, variationIds: string[]): Promise<Map<string, { state: SyncState; at: string | null; error: string | null }>> {
  const out = new Map<string, { state: SyncState; at: string | null; error: string | null }>();
  if (variationIds.length === 0) return out;
  try {
    const cfg = await sql<{ enabled: boolean; wh: string | null }>`
      SELECT platform.setting_bool('web.push_enabled', false) AS enabled, platform.web_warehouse_id()::text AS wh`.execute(db);
    const c = cfg.rows[0]!;
    if (!c.enabled || c.wh !== warehouseId) {
      for (const v of variationIds) out.set(v, { state: c.enabled ? "not_site_warehouse" : "off", at: null, error: null });
      return out;
    }
    const r = await sql<{ variation_id: string; status: string; sent_at: Date | null; attempts: number; last_error: string | null; created_at: Date }>`
      SELECT DISTINCT ON (payload->>'variationId') payload->>'variationId' AS variation_id,
             status, sent_at, attempts, last_error, created_at
        FROM platform.outbox_message
       WHERE topic = 'web.stock_push' AND payload->>'variationId' = ANY(${variationIds}::text[])
       ORDER BY payload->>'variationId', created_at DESC, id DESC`.execute(db);
    for (const v of variationIds) out.set(v, { state: "none", at: null, error: null });
    for (const row of r.rows) {
      const state: SyncState = row.status === "sent" ? "sent"
        : row.status === "dead" ? "error"
        : row.last_error && row.attempts > 0 ? "error"
        : "queued";
      out.set(row.variation_id, {
        state, at: (row.sent_at ?? row.created_at).toISOString(),
        error: state === "error" ? (row.last_error ?? "ارسال ناموفق") : null,
      });
    }
  } catch {
    for (const v of variationIds) out.set(v, { state: "unknown", at: null, error: null });
  }
  return out;
}

export async function orderDetail(db: Db, id: string) {
  const r = await sql<OrderRow & {
    customer_name: string | null; mobile: string | null; invoice_number: string | null; invoice_status: string;
    gross: string; discount: string; shipping: string; payable: string; branch_name: string; warehouse_name: string;
    account_name: string | null;
  }>`
    SELECT io.*, c.full_name AS customer_name, c.mobile_normalized AS mobile, i.number AS invoice_number,
           i.status AS invoice_status, i.gross_amount::text AS gross, i.discount_amount::text AS discount,
           i.shipping_amount::text AS shipping, i.payable_amount::text AS payable,
           b.name AS branch_name, w.name AS warehouse_name, a.name AS account_name
      FROM sales.instagram_order io
      JOIN sales.invoice i ON i.id = io.invoice_id
      JOIN sales.customer c ON c.id = io.customer_id
      JOIN platform.branch b ON b.id = io.branch_id
      JOIN inventory.warehouse w ON w.id = io.warehouse_id
      LEFT JOIN treasury.account a ON a.id = io.receiving_account_id
     WHERE io.id = ${id}::uuid`.execute(db);
  const o = r.rows[0];
  if (!o) throw new InvoiceError("order_not_found", "سفارش اینستاگرام یافت نشد", 404);

  const lines = await sql<{
    id: string; variation_id: string; sku: string; product: string; color: string | null; size: string | null;
    qty: string; unit_price: string; discount_amount: string; net_amount: string; available: string | null;
  }>`
    SELECT l.id, l.variation_id, v.sku, p.name_internal AS product, v.color, v.size, trim_scale(l.qty)::text AS qty,
           l.unit_price::text, l.discount_amount::text, l.net_amount::text,
           trim_scale(greatest(coalesce(b.on_hand, 0) - coalesce(b.reserved, 0), 0))::text AS available
      FROM sales.invoice_line l
      JOIN catalog.variation v ON v.id = l.variation_id
      JOIN catalog.product p ON p.id = v.product_id
      LEFT JOIN inventory.stock_balance b ON b.variation_id = l.variation_id AND b.warehouse_id = ${o.warehouse_id}::uuid
     WHERE l.invoice_id = ${o.invoice_id}::uuid
     ORDER BY l.line_no`.execute(db);

  const holds = await sql<{ variation_id: string; qty: string; expires_at: Date }>`
    SELECT variation_id, trim_scale(qty)::text AS qty, expires_at FROM inventory.stock_reservation
     WHERE source = 'instagram' AND source_ref = ${id} AND released_at IS NULL`.execute(db);
  const pay = await sql<{ account_id: string; account_name: string; amount: string; ref_no: string; paid_at: Date;
                          verified_by: string; verified_at: Date; payment_id: string | null; verifier: string | null }>`
    SELECT ip.account_id, a.name AS account_name, ip.amount::text, ip.ref_no, ip.paid_at, ip.verified_by, ip.verified_at,
           ip.payment_id, u.full_name AS verifier
      FROM sales.instagram_payment ip
      JOIN treasury.account a ON a.id = ip.account_id
      LEFT JOIN identity.app_user u ON u.id = ip.verified_by
     WHERE ip.order_id = ${id}::uuid AND ip.payment_id IS NOT NULL`.execute(db);
  // هشدار، نه منع: یک مشتری چند خرید معتبر دارد.
  const similar = await sql<{ id: string; order_no: string; status: string; created_at: Date }>`
    SELECT id, order_no, status, created_at FROM sales.instagram_order
     WHERE id <> ${id}::uuid AND status IN ('draft','reserved','expired')
       AND branch_id = ${o.branch_id}::uuid
       AND (customer_id = ${o.customer_id}::uuid
            OR (${o.instagram_username}::text IS NOT NULL AND instagram_username = ${o.instagram_username}))
     ORDER BY created_at DESC LIMIT 5`.execute(db);
  const sync = await syncStates(db, o.warehouse_id, lines.rows.map((l) => l.variation_id));
  // مرجوعی همان مسیر رسمی فاکتور است؛ اینجا فقط دیده می‌شود. برگشت پول ≠ برگشت کالا: هر برگ جداست.
  const returns = await sql<{ id: string; number: string | null; status: string; kind: string; refund: string }>`
    SELECT id, number, status, kind, refund_amount::text AS refund FROM sales.sale_return
     WHERE invoice_id = ${o.invoice_id}::uuid ORDER BY occurred_at, id`.execute(db);

  return {
    id: o.id, orderNo: o.order_no, status: o.status, paymentState: o.payment_state, paymentNote: o.payment_note,
    shippingState: o.shipping_state, trackingCode: o.tracking_code, version: o.version,
    reservedUntil: o.reserved_until?.toISOString() ?? null, cancelReason: o.cancel_reason,
    createdAt: o.created_at.toISOString(), updatedAt: o.updated_at.toISOString(),
    branch: { id: o.branch_id, name: o.branch_name }, warehouse: { id: o.warehouse_id, name: o.warehouse_name },
    customer: { id: o.customer_id, name: o.customer_name, mobile: o.mobile, instagramUsername: o.instagram_username },
    shipping: { address: o.ship_address, method: o.ship_method },
    receivingAccount: o.receiving_account_id ? { id: o.receiving_account_id, name: o.account_name } : null,
    invoice: {
      id: o.invoice_id, number: o.invoice_number, status: o.invoice_status,
      gross: o.gross, discount: o.discount, shipping: o.shipping, payable: o.payable,
    },
    lines: lines.rows.map((l) => ({
      id: l.id, variationId: l.variation_id, sku: l.sku, product: l.product, color: l.color, size: l.size,
      qty: Number(l.qty), unitPrice: l.unit_price, discountAmount: l.discount_amount, netAmount: l.net_amount,
      available: l.available ?? "0", sync: sync.get(l.variation_id) ?? { state: "unknown", at: null, error: null },
    })),
    holds: holds.rows.map((h) => ({ variationId: h.variation_id, qty: h.qty, expiresAt: h.expires_at.toISOString() })),
    payment: pay.rows[0] ? {
      accountId: pay.rows[0].account_id, accountName: pay.rows[0].account_name, amount: pay.rows[0].amount,
      refNo: pay.rows[0].ref_no, paidAt: pay.rows[0].paid_at.toISOString(), verifiedBy: pay.rows[0].verifier,
      verifiedAt: pay.rows[0].verified_at.toISOString(), paymentId: pay.rows[0].payment_id,
    } : null,
    returns: returns.rows.map((x) => ({ id: x.id, number: x.number, status: x.status, kind: x.kind, refundAmount: x.refund })),
    similarOpen: similar.rows.map((x) => ({ id: x.id, orderNo: x.order_no, status: x.status, createdAt: x.created_at.toISOString() })),
  };
}
