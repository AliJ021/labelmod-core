/**
 * سفارش اینستاگرام (نسخهٔ ۱) — ورود دستی اپراتور، پرداخت کامل کارت‌به‌کارت پیش از ارسال.
 *
 * قرارداد کامل: docs/INSTAGRAM-ORDERS.md. خلاصه‌ای که این پرونده را توضیح می‌دهد:
 *
 * - **پیش‌نویس فاکتور کانال `instagram`** همان سبد است: قیمت از `catalog.price`، تخفیف از
 *   `markdown-gate` (همان دروازهٔ صندوق) و جمع‌ها در SQL. این سرویس منطق قیمتی دوم ندارد.
 * - **هر تغییر** در یک تراکنش، زیر قفل سطر سفارش و با GUC محلیِ `lmc.instagram_order` انجام
 *   می‌شود. Triggerهای مهاجرت ۱۰۲ بی این زمینه هر نوشتنی روی فاکتور اینستاگرام را رد
 *   می‌کنند، پس مسیر عمومی `/invoices` نمی‌تواند سبد، پرداخت یا نهایی‌سازی را دور بزند.
 * - **رزرو، آزادسازی، انقضا و تأیید واریز** در توابع SQL‌اند (SECURITY DEFINER). سنجش‌های
 *   اینجا لایهٔ اول‌اند فقط برای کد و پیام دقیق؛ لایهٔ دوم همان قاعده‌ها زیر همان قفل در
 *   دیتابیس است.
 * - **تأیید واریز** یک تراکنش است: سنجش‌ها → مصرف همان رزرو → `addPaymentIn` → `finalizeIn`
 *   → بستن. شکست هر مرحله همه را برمی‌گرداند؛ قفل سطر موجودی تا Commit می‌ماند.
 */
import { sql, type Transaction } from "kysely";
import type { Database } from "../db/types.ts";
import type { Db } from "../db/client.ts";
import { setActor } from "../lib/idempotency.ts";
import { parseMoney, serializeMoney } from "../lib/money.ts";
import { InvoiceError, type InvoiceService, type LineAdditionAuthorizer } from "./invoice.ts";

export const ORDER_STATUSES = ["draft", "reserved", "expired", "confirming", "finalized", "cancelled"] as const;
export const PAYMENT_STATES = ["none", "claimed", "review", "confirmed"] as const;
export const SHIPPING_STATES = ["not_started", "packing", "ready", "shipped", "delivered"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** نام کاربری اینستاگرام: حروف کوچک، عدد، نقطه و زیرخط، تا ۳۰ نویسه — بی «@». */
export function normalizeInstagramUsername(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const v = raw.trim().replace(/^@+/, "").toLowerCase();
  if (v === "") return null;
  if (!/^[a-z0-9._]{1,30}$/.test(v)) {
    throw new InvoiceError("bad_instagram_username", "نام کاربری اینستاگرام فقط حروف انگلیسی، عدد، نقطه و زیرخط دارد (حداکثر ۳۰)", 422);
  }
  return v;
}

export interface OrderRow {
  id: string;
  order_no: string;
  invoice_id: string;
  branch_id: string;
  warehouse_id: string;
  customer_id: string;
  instagram_username: string | null;
  ship_address: string;
  ship_method: string;
  receiving_account_id: string | null;
  status: OrderStatus;
  payment_state: string;
  payment_note: string | null;
  shipping_state: string;
  tracking_code: string | null;
  version: number;
  reserved_until: Date | null;
  cancel_reason: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreateOrderInput {
  branchId: string;
  warehouseId: string;
  customerMobile: string;
  customerName?: string | undefined;
  instagramUsername?: string | null | undefined;
  shipAddress?: string | undefined;
  shipMethod?: string | undefined;
  shippingAmount?: bigint | undefined;
  receivingAccountId?: string | null | undefined;
  actorId: string;
}

export interface ConfirmInput {
  version: number;
  accountId: string;
  amount: bigint;
  refNo: string;
  paidAt: Date;
  actorId: string;
}

/** خطای سفارش اینستاگرام — همان شکل InvoiceError تا errors.ts بی تغییر ترجمه‌اش کند. */
function orderError(code: string, message: string, status = 409): InvoiceError {
  return new InvoiceError(code, message, status);
}

export class InstagramOrderService {
  readonly #db: Db;
  readonly #invoices: InvoiceService;

  constructor(db: Db, invoices: InvoiceService) {
    this.#db = db;
    this.#invoices = invoices;
  }

  /** سطر سفارش را قفل می‌کند و زمینهٔ نوشتن روی فاکتورش را در همین تراکنش باز می‌کند. */
  async lockIn(trx: Transaction<Database>, orderId: string): Promise<OrderRow> {
    const r = await sql<OrderRow>`SELECT * FROM sales.instagram_order WHERE id = ${orderId}::uuid FOR UPDATE`.execute(trx);
    const row = r.rows[0];
    if (!row) throw orderError("order_not_found", "سفارش اینستاگرام یافت نشد", 404);
    await sql`SELECT set_config('lmc.instagram_order', ${row.id}::text, true)`.execute(trx);
    return row;
  }

  async byId(orderId: string, ex: Db | Transaction<Database> = this.#db): Promise<OrderRow | null> {
    const r = await sql<OrderRow>`SELECT * FROM sales.instagram_order WHERE id = ${orderId}::uuid`.execute(ex);
    return r.rows[0] ?? null;
  }

  private requireDraft(o: OrderRow): void {
    if (o.status !== "draft") {
      throw orderError("order_not_draft",
        o.status === "reserved" || o.status === "expired"
          ? `سفارش ${o.order_no} رزرو یا منقضی است؛ برای تغییر سبد ابتدا «برگشت به پیش‌نویس» را بزنید.`
          : `سفارش ${o.order_no} در وضعیت «${o.status}» است و سبدش دیگر تغییر نمی‌کند.`);
    }
  }

  /** حساب مقصد مجاز: بانکی، فعال، سراسری یا همان شعبه. */
  async assertReceivingAccount(ex: Db | Transaction<Database>, accountId: string, branchId: string): Promise<void> {
    const r = await sql<{ ok: boolean }>`
      SELECT EXISTS (SELECT 1 FROM treasury.account
                      WHERE id = ${accountId}::uuid AND kind = 'bank' AND is_active
                        AND (branch_id IS NULL OR branch_id = ${branchId}::uuid)) AS ok`.execute(ex);
    if (!r.rows[0]?.ok) throw orderError("account_not_allowed", "حساب مقصد واریز برای این شعبه مجاز نیست", 422);
  }

  /** مشتری از موبایلِ نرمال‌شده در دیتابیس؛ نام موجود بازنویسی نمی‌شود. موبایل بی‌معنا رد می‌شود. */
  private async resolveCustomer(trx: Transaction<Database>, mobile: string, fullName: string | undefined): Promise<string> {
    const norm = await sql<{ m: string | null }>`SELECT nullif(sales.normalize_mobile(${mobile}), '') AS m`.execute(trx);
    const normalized = norm.rows[0]?.m;
    if (!normalized || !/^09\d{9}$/.test(normalized)) {
      throw orderError("bad_mobile", "شمارهٔ موبایل مشتری معتبر نیست", 422);
    }
    const existing = await trx.selectFrom("sales.customer").select("id")
      .where("mobile_normalized", "=", normalized).executeTakeFirst();
    if (existing) return existing.id;
    const row = await trx.insertInto("sales.customer")
      .values({ mobile_normalized: normalized, full_name: fullName?.trim() || null })
      .returning("id").executeTakeFirstOrThrow();
    return row.id;
  }

  async create(input: CreateOrderInput): Promise<string> {
    return this.#db.transaction().execute((trx) => this.createIn(trx, input));
  }

  async createIn(trx: Transaction<Database>, input: CreateOrderInput): Promise<string> {
    const username = normalizeInstagramUsername(input.instagramUsername);
    if (input.receivingAccountId) await this.assertReceivingAccount(trx, input.receivingAccountId, input.branchId);
    if (input.shippingAmount !== undefined && input.shippingAmount < 0n) {
      throw orderError("bad_shipping", "کرایهٔ ارسال منفی نیست", 422);
    }
    await setActor(trx, input.actorId);
    const customerId = await this.resolveCustomer(trx, input.customerMobile, input.customerName);
    await sql`SELECT set_config('lmc.instagram_order', 'new', true)`.execute(trx);
    const invoiceId = await this.#invoices.createDraftIn(trx, {
      branchId: input.branchId, warehouseId: input.warehouseId, customerId,
      channel: "instagram", actorId: input.actorId,
    });
    const r = await sql<{ id: string }>`
      INSERT INTO sales.instagram_order
        (invoice_id, branch_id, warehouse_id, customer_id, instagram_username, ship_address, ship_method,
         receiving_account_id, created_by)
      VALUES (${invoiceId}::uuid, ${input.branchId}::uuid, ${input.warehouseId}::uuid, ${customerId}::uuid,
              ${username}, ${(input.shipAddress ?? "").trim()}, ${(input.shipMethod ?? "").trim()},
              ${input.receivingAccountId ?? null}::uuid, ${input.actorId}::uuid)
      RETURNING id`.execute(trx);
    const orderId = r.rows[0]!.id;
    await sql`SELECT set_config('lmc.instagram_order', ${orderId}::text, true)`.execute(trx);
    if (input.shippingAmount && input.shippingAmount > 0n) {
      await sql`UPDATE sales.invoice SET shipping_amount = ${serializeMoney(input.shippingAmount)}::numeric
                 WHERE id = ${invoiceId}::uuid`.execute(trx);
      await sql`SELECT sales.refresh_invoice_totals(${invoiceId}::uuid)`.execute(trx);
    }
    await sql`SELECT platform.audit('instagram_order.create', 'instagram_order', ${orderId}::text,
      jsonb_build_object('invoiceId', ${invoiceId}::text, 'branchId', ${input.branchId}::text,
                         'customerId', ${customerId}::text, 'instagram', ${username}::text),
      ${input.actorId}::uuid)`.execute(trx);
    return orderId;
  }

  /**
   * سرآیند: نشانی، روش ارسال، حساب پیش‌فرض و نام کاربری هر زمانی پیش از نهایی‌سازی؛
   * کرایه فقط در پیش‌نویس (مبلغ قابل پرداخت را عوض می‌کند، پس نسخه هم بالا می‌رود).
   */
  async updateHeader(orderId: string, patch: {
    shipAddress?: string | undefined; shipMethod?: string | undefined;
    instagramUsername?: string | null | undefined; receivingAccountId?: string | null | undefined;
    shippingAmount?: bigint | undefined; actorId: string;
  }): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      const o = await this.lockIn(trx, orderId);
      if (o.status === "finalized" || o.status === "cancelled" || o.status === "confirming") {
        throw orderError("order_closed", `سفارش ${o.order_no} بسته است؛ سرآیندش تغییر نمی‌کند`);
      }
      await setActor(trx, patch.actorId);
      const username = patch.instagramUsername === undefined ? undefined : normalizeInstagramUsername(patch.instagramUsername);
      if (patch.receivingAccountId) await this.assertReceivingAccount(trx, patch.receivingAccountId, o.branch_id);
      let bump = false;
      if (patch.shippingAmount !== undefined) {
        if (patch.shippingAmount < 0n) throw orderError("bad_shipping", "کرایهٔ ارسال منفی نیست", 422);
        const cur = await sql<{ s: string }>`SELECT shipping_amount::text AS s FROM sales.invoice WHERE id = ${o.invoice_id}::uuid`.execute(trx);
        if (parseMoney(cur.rows[0]!.s) !== patch.shippingAmount) {
          this.requireDraft(o);
          await sql`UPDATE sales.invoice SET shipping_amount = ${serializeMoney(patch.shippingAmount)}::numeric
                     WHERE id = ${o.invoice_id}::uuid`.execute(trx);
          await sql`SELECT sales.refresh_invoice_totals(${o.invoice_id}::uuid)`.execute(trx);
          bump = true;
        }
      }
      await sql`
        UPDATE sales.instagram_order SET
          ship_address = coalesce(${patch.shipAddress?.trim() ?? null}, ship_address),
          ship_method = coalesce(${patch.shipMethod?.trim() ?? null}, ship_method),
          instagram_username = CASE WHEN ${username !== undefined} THEN ${username ?? null} ELSE instagram_username END,
          receiving_account_id = CASE WHEN ${patch.receivingAccountId !== undefined}
                                      THEN ${patch.receivingAccountId ?? null}::uuid ELSE receiving_account_id END,
          version = version + ${bump ? 1 : 0}, updated_at = now()
        WHERE id = ${o.id}::uuid`.execute(trx);
      await sql`SELECT platform.audit('instagram_order.update', 'instagram_order', ${o.id}::text,
        ${JSON.stringify({
          shipAddress: patch.shipAddress, shipMethod: patch.shipMethod, instagram: username,
          receivingAccountId: patch.receivingAccountId,
          shippingAmount: patch.shippingAmount === undefined ? undefined : serializeMoney(patch.shippingAmount),
        })}::jsonb, ${patch.actorId}::uuid)`.execute(trx);
    });
  }

  async addLine(orderId: string, input: {
    variationId: string; qty: number; discountAmount?: bigint | undefined; discountReason?: string | undefined; actorId: string;
  }, authorize?: LineAdditionAuthorizer): Promise<void> {
    if (!Number.isInteger(input.qty) || input.qty < 1 || input.qty > 999) {
      throw orderError("bad_qty", "تعداد باید عدد صحیح مثبت باشد", 422);
    }
    await this.#db.transaction().execute(async (trx) => {
      const o = await this.lockIn(trx, orderId);
      this.requireDraft(o);
      await this.#invoices.addLineIn(trx, {
        invoiceId: o.invoice_id, variationId: input.variationId, qty: String(input.qty), actorId: input.actorId,
        ...(input.discountAmount ? { discountAmount: input.discountAmount, discountReason: input.discountReason } : {}),
      }, authorize);
    });
  }

  async setLineQty(orderId: string, lineId: string, qty: number, actorId: string): Promise<void> {
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) throw orderError("bad_qty", "تعداد باید عدد صحیح مثبت باشد", 422);
    await this.#db.transaction().execute(async (trx) => {
      const o = await this.lockIn(trx, orderId);
      this.requireDraft(o);
      await setActor(trx, actorId);
      const line = await trx.selectFrom("sales.invoice_line").select(["discount_amount", "list_price"])
        .where("id", "=", lineId).where("invoice_id", "=", o.invoice_id).executeTakeFirst();
      if (!line) throw orderError("line_not_found", "این قلم در سفارش نیست", 404);
      if (parseMoney(line.discount_amount) > 0n || line.list_price !== null) {
        throw orderError("line_price_adjusted", "تعداد سطری که تخفیف یا قیمت دستی دارد از این مسیر عوض نمی‌شود؛ سطر را حذف و دوباره ثبت کنید.");
      }
      await sql`SELECT sales.set_line_qty(${o.invoice_id}::uuid, ${lineId}::uuid, ${String(qty)}::platform.qty)`.execute(trx);
    });
  }

  async removeLine(orderId: string, lineId: string, actorId: string): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      const o = await this.lockIn(trx, orderId);
      this.requireDraft(o);
      await setActor(trx, actorId);
      const del = await trx.deleteFrom("sales.invoice_line").where("id", "=", lineId)
        .where("invoice_id", "=", o.invoice_id).executeTakeFirst();
      if (!del.numDeletedRows) throw orderError("line_not_found", "این قلم در سفارش نیست", 404);
      await sql`SELECT sales.refresh_invoice_totals(${o.invoice_id}::uuid)`.execute(trx);
    });
  }

  async reserve(orderId: string, actorId: string): Promise<{ replayed: boolean }> {
    return this.#db.transaction().execute(async (trx) => {
      const o = await this.lockIn(trx, orderId);
      if (o.status === "reserved") return { replayed: true };
      if (o.status !== "draft" && o.status !== "expired") {
        throw orderError("order_not_reservable", `سفارش ${o.order_no} در وضعیت «${o.status}» رزرو نمی‌شود`);
      }
      const r = await sql<{ out: { replayed: boolean } }>`SELECT sales.instagram_reserve(${o.id}::uuid, ${actorId}::uuid) AS out`.execute(trx);
      return { replayed: r.rows[0]!.out.replayed };
    });
  }

  async release(orderId: string, actorId: string, to: "draft" | "cancelled", reason?: string): Promise<{ replayed: boolean }> {
    return this.#db.transaction().execute(async (trx) => {
      const o = await this.lockIn(trx, orderId);
      if (o.status === to) return { replayed: true };
      if (o.status === "finalized") {
        throw orderError("order_finalized", `سفارش ${o.order_no} نهایی شده است؛ برای برگشت کالا یا پول از مرجوعی رسمی فاکتور استفاده کنید.`);
      }
      if (o.payment_state === "claimed" || o.payment_state === "review") {
        throw orderError("payment_in_review", `واریز سفارش ${o.order_no} در حال بررسی است؛ ابتدا وضعیت پرداخت را روشن کنید.`);
      }
      const r = await sql<{ out: { replayed: boolean } }>`
        SELECT sales.instagram_release(${o.id}::uuid, ${actorId}::uuid, ${to}, ${reason ?? null}) AS out`.execute(trx);
      return { replayed: r.rows[0]!.out.replayed };
    });
  }

  async markPayment(orderId: string, actorId: string, state: "none" | "claimed" | "review", note: string | null): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      const o = await this.lockIn(trx, orderId);
      await sql`SELECT sales.instagram_mark_payment(${o.id}::uuid, ${actorId}::uuid, ${state}, ${note})`.execute(trx);
    });
  }

  async setShipping(orderId: string, actorId: string, state: string, tracking: string | null): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      const o = await this.lockIn(trx, orderId);
      await sql`SELECT sales.instagram_set_shipping(${o.id}::uuid, ${actorId}::uuid, ${state}, ${tracking})`.execute(trx);
    });
  }

  /**
   * تأیید واریز و نهایی‌سازی — در تراکنش فراخوان (runOnce). سنجش‌های اینجا کد خطای دقیق
   * می‌دهند؛ `instagram_begin_confirm` همهٔ آن‌ها را زیر همان قفل دوباره می‌سنجد.
   */
  async confirmIn(trx: Transaction<Database>, orderId: string, input: ConfirmInput): Promise<{ invoiceId: string; replayed: boolean }> {
    const o = await this.lockIn(trx, orderId);
    const ref = input.refNo.trim();
    if (o.status === "finalized") {
      const prev = await sql<{ account_id: string; ref_key: string; amount: string }>`
        SELECT account_id, ref_key, amount::text FROM sales.instagram_payment WHERE order_id = ${o.id}::uuid`.execute(trx);
      const p = prev.rows[0];
      if (p && p.account_id === input.accountId && p.ref_key === ref.toLowerCase() && parseMoney(p.amount) === input.amount) {
        return { invoiceId: o.invoice_id, replayed: true };
      }
      throw orderError("already_confirmed", `سفارش ${o.order_no} پیش‌تر با واریز دیگری تأیید شده است`);
    }
    if (o.status !== "reserved" && o.status !== "expired") {
      throw orderError("order_not_confirmable", `سفارش ${o.order_no} در وضعیت «${o.status}» قابل تأیید واریز نیست؛ ابتدا رزرو کنید.`);
    }
    if (input.version !== o.version) {
      throw orderError("stale_version", `سفارش ${o.order_no} پس از دیدن شما تغییر کرده است؛ صفحه را تازه کنید و مبلغ را دوباره ببینید.`);
    }
    await this.assertReceivingAccount(trx, input.accountId, o.branch_id);
    if (ref === "" || ref.length > 64) throw orderError("ref_required", "شمارهٔ پیگیری واریز لازم است", 422);
    const pay = await sql<{ p: string }>`SELECT payable_amount::text AS p FROM sales.invoice WHERE id = ${o.invoice_id}::uuid`.execute(trx);
    const payable = parseMoney(pay.rows[0]!.p);
    if (input.amount !== payable) {
      throw orderError("amount_mismatch",
        `مبلغ واریز با مبلغ کامل سفارش و کرایه برابر نیست؛ واریز ناقص یا اضافه تأیید نمی‌شود. سفارش را «نیازمند رسیدگی» علامت بزنید.`, 422);
    }
    const method = await sql<{ code: string }>`
      SELECT code FROM treasury.payment_method WHERE kind = 'transfer' AND is_active ORDER BY (code = 'transfer') DESC, code LIMIT 1`.execute(trx);
    const methodCode = method.rows[0]?.code;
    if (!methodCode) throw orderError("transfer_method_missing", "روش پرداخت کارت‌به‌کارت فعال نیست", 422);

    let begun: { invoiceId: string; replayed: boolean };
    try {
      const r = await sql<{ out: { invoiceId: string; replayed: boolean } }>`
        SELECT sales.instagram_begin_confirm(${o.id}::uuid, ${input.actorId}::uuid, ${input.version}::int,
          ${input.accountId}::uuid, ${serializeMoney(input.amount)}::platform.money, ${ref}, ${input.paidAt.toISOString()}::timestamptz) AS out`.execute(trx);
      begun = r.rows[0]!.out;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (/واریز تکراری/.test(msg)) throw orderError("duplicate_bank_ref", msg);
      if (/موجودی قابل‌فروش کافی نیست/.test(msg)) throw orderError("insufficient_stock", `${msg}؛ واریز ثبت نشد. پیش از برگشت پول، با مشتری تماس بگیرید.`);
      if (/زمان واریز/.test(msg)) throw orderError("bad_paid_at", msg, 422);
      throw err;
    }
    if (begun.replayed) return { invoiceId: begun.invoiceId, replayed: true };

    const paymentId = await this.#invoices.addPaymentIn(trx, {
      invoiceId: o.invoice_id, methodCode, amount: input.amount, refNo: ref, accountId: input.accountId,
      actorId: input.actorId, clientEventId: `ig:${o.id}`,
    });
    await this.#invoices.finalizeIn(trx, o.invoice_id, input.actorId);
    await sql`SELECT sales.instagram_finish_confirm(${o.id}::uuid, ${input.actorId}::uuid, ${paymentId}::uuid)`.execute(trx);
    return { invoiceId: o.invoice_id, replayed: false };
  }
}
