/**
 * مسیرهای خرید — تأمین‌کننده و رسید خرید.
 *
 * ── قاعده‌ای که این گروه را از فروش جدا می‌کند ──────────────────────
 *
 * در فروش قیمت هرگز از کلاینت نمی‌آید. **در خرید می‌آید و باید بیاید**:
 * قیمت خرید تصمیم تأمین‌کننده است و هیچ‌جا در دیتابیس ما نیست.
 * توضیح کامل در `purchasing/receipt.ts`.
 *
 * ── دو مرزی که هر Handler اینجا رعایت می‌کند ────────────────────────
 *
 * ۱. **دامنه پیش از مجوز.** بی‌معناست بپرسیم «می‌تواند رسید بزند؟»
 *    وقتی اصلاً به آن شعبه دسترسی ندارد.
 * ۲. **مجوز پیش از هر نوشتنی.** `requireForSession` تا `viaPin` از
 *    نشست بیاید، نه از فراخوان.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { resolveVariationId } from "../catalog/resolve.ts";
import { AuthError } from "../auth/service.ts";
import { requireForSession } from "../auth/permission.ts";
import type { Db } from "../db/client.ts";
import { parseMoney } from "../lib/money.ts";
import { runOnce } from "../lib/idempotency.ts";
import { assertBranch, assertWarehouseInBranch } from "../sales/scope.ts";
import { branchesOf } from "../sales/scope.ts";
import { PurchasingError, type ReceiptService } from "../purchasing/receipt.ts";
import { StockCountError, type StockCountService } from "../inventory/stock-count.ts";
import type { PurchaseReturnService } from "../purchasing/return.ts";
import type { PurchaseOrderService } from "../purchasing/order.ts";

const uuid = z.string().uuid("شناسه نامعتبر");

/** پول در JSON رشته است — رقم صحیح، بدون اعشار و بدون جداکننده. */
const moneyString = z
  .string()
  .regex(/^\d+$/, "مبلغ باید رقم صحیح باشد (ریال، بدون اعشار)");

/** تعداد تا سه رقم اعشار — `platform.qty` است، نه عدد صحیح. */
const qtyString = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, "تعداد نامعتبر")
  .refine((v) => Number(v) > 0, { message: "تعداد باید بزرگ‌تر از صفر باشد" });

/**
 * نویسه‌های کنترلی و جهت‌دهی — همان فهرستی که مسیر کالا رد می‌کند.
 *
 * نام تأمین‌کننده روی سند حسابداری و در گردش حساب اشخاص می‌نشیند. یک
 * نشانه جهت‌دهی راست‌به‌چپ می‌تواند ظاهر متن را وارونه نشان دهد بدون
 * اینکه محتوا عوض شود.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

const cleanText = (max: number) =>
  z
    .string()
    .trim()
    .min(1, "نمی‌تواند خالی باشد")
    .max(max, `حداکثر ${max} نویسه`)
    .refine((v) => !CONTROL_CHARS.test(v), { message: "شامل نویسه کنترلی است" });

const createSupplierBody = z.object({
  code: cleanText(40),
  name: cleanText(120),
  mobile: z.string().trim().max(20).optional(),
  phone: z.string().trim().max(20).optional(),
  address: z.string().trim().max(400).optional(),
  nationalId: z.string().trim().max(20).optional(),
});

const createReceiptBody = z.object({
  branchId: uuid,
  warehouseId: uuid,
  supplierId: uuid,
  /** سفارشی که این رسید بابتش آمده. تهی = خرید بدون سفارش، کار عادی. */
  orderId: uuid.optional(),
  /** تاریخ رسید — روی فاکتور تأمین‌کننده، نه لزوماً امروز. */
  occurredAt: z.string().datetime().optional(),
  supplierInvoiceNo: z.string().trim().max(60).optional(),
  note: z.string().trim().max(500).optional(),
});

const addLineBody = z
  .object({
    variationId: uuid.optional(),
    barcode: z.string().trim().min(1).max(64).optional(),
    qty: qtyString,
    unitPrice: moneyString,
    /**
     * سطر سفارشی که این قلم بابتش آمده.
     *
     * دیتابیس اجبار می‌کند که به همان سفارشِ رسید باشد — کلید خارجی
     * این را نمی‌گیرد، چون سطر واقعاً وجود دارد و فقط مال سفارش
     * دیگری است.
     */
    orderLineId: uuid.optional(),
  })
  .refine((v) => v.variationId !== undefined || v.barcode !== undefined, {
    message: "شناسه کالا یا بارکد لازم است",
  });

const setLineBody = z
  .object({
    qty: qtyString.optional(),
    unitPrice: moneyString.optional(),
  })
  .refine((v) => v.qty !== undefined || v.unitPrice !== undefined, {
    message: "دست‌کم یکی از تعداد یا قیمت لازم است",
  });

/**
 * هزینه جانبی رسید.
 *
 * `allocation` تعیین می‌کند چطور روی بهای تمام‌شده بنشیند و `paidFrom`
 * تعیین می‌کند پولش از کجا رفته. اگر از خزانه رفته باشد، حساب
 * پرداخت‌کننده اجباری است — و دیتابیس اجازه نمی‌دهد آن حساب صندوق
 * فروشگاه باشد.
 */
const addChargeBody = z
  .object({
    chargeType: cleanText(60),
    amount: moneyString,
    allocation: z.enum(["by_value", "by_qty", "none"]).default("by_value"),
    paidFrom: z.enum(["payable", "treasury"]).default("payable"),
    payeeType: z.enum(["supplier", "other"]).default("supplier"),
    payeeName: z.string().trim().max(120).optional(),
    paidAccountId: uuid.optional(),
    /**
     * سرفصل هزینه دوره — فقط با `allocation: none` معنا دارد.
     *
     * دیتابیس هم همین را اجبار می‌کند
     * (`charge_expense_account_only_when_none`). اینجا هم رد می‌شود تا
     * کاربر پیش از رفتن به سرور بفهمد انتخابش بی‌اثر است.
     */
    expenseAccountCode: z.string().trim().regex(/^\d{1,8}$/, "کد حساب نامعتبر").optional(),
  })
  .refine((v) => v.paidFrom !== "treasury" || v.paidAccountId !== undefined, {
    message: "هزینه پرداخت‌شده از خزانه، حساب پرداخت‌کننده می‌خواهد",
  })
  .refine((v) => v.expenseAccountCode === undefined || v.allocation === "none", {
    message: "سرفصل هزینه فقط برای هزینه‌ای است که به بهای کالا نمی‌رود",
  });

const updateHeadBody = z.object({
  taxAmount: moneyString.optional(),
  supplierInvoiceNo: z.string().trim().max(60).nullable().optional(),
  occurredAt: z.string().datetime().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

const createCountBody = z.object({
  branchId: uuid,
  warehouseId: uuid,
  note: z.string().trim().max(500).optional(),
});

/**
 * یک سطر شمارش.
 *
 * `countedQty` **مطلق** است، نه افزایشی: اسکن دوباره همان کالا یعنی
 * «دوباره شمردم و این عدد است»، نه «یکی دیگر پیدا کردم». اگر جمع
 * می‌شد، هر بازبینی عدد را دو برابر می‌کرد.
 *
 * صفر پذیرفته می‌شود و یک شمارش است: «گشتیم و هیچ‌کدامش نبود» با
 * «نشمردیم» یکی نیست — دومی یعنی سطر اصلاً نباشد.
 */
const countLineBody = z
  .object({
    variationId: uuid.optional(),
    barcode: z.string().trim().min(1).max(64).optional(),
    countedQty: z
      .string()
      .regex(/^\d+(\.\d{1,3})?$/, "تعداد نامعتبر"),
  })
  .refine((v) => v.variationId !== undefined || v.barcode !== undefined, {
    message: "شناسه کالا یا بارکد لازم است",
  });

/**
 * برگ برگشت از خرید — سرآیند و اقلام با هم.
 *
 * برخلاف رسید خرید، این یک سبد تدریجی نیست: انباردار رسید را می‌بیند،
 * تیک می‌زند و می‌فرستد. پیش‌نویس نیمه‌کاره فقط برگه‌ای رها می‌سازد که
 * هیچ‌کس دنبالش نمی‌رود.
 */
const createReturnBody = z.object({
  receiptId: uuid,
  reasonCode: cleanText(40),
  reasonNote: z.string().trim().max(500).optional(),
  lines: z
    .array(z.object({ receiptLineId: uuid, qty: qtyString }))
    .min(1, "دست‌کم یک قلم لازم است")
    .max(200),
});

const createOrderBody = z.object({
  branchId: uuid,
  supplierId: uuid,
  warehouseId: uuid,
  expectedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاریخ نامعتبر").optional(),
  note: z.string().trim().max(500).optional(),
});

/**
 * یک قلم سفارش — **مطلق**، مثل شمارش.
 *
 * سفارش یک فهرست است، نه یک سبد: «۱۰ تا از این» یعنی همان ۱۰ تا، نه
 * ۱۰ تای دیگر روی قبلی‌ها.
 */
const orderLineBody = z
  .object({
    variationId: uuid.optional(),
    barcode: z.string().trim().min(1).max(64).optional(),
    qty: qtyString,
    unitPrice: moneyString,
  })
  .refine((v) => v.variationId !== undefined || v.barcode !== undefined, {
    message: "شناسه کالا یا بارکد لازم است",
  });

export interface PurchasingRouteDeps {
  db: Db;
  receipts: ReceiptService;
  counts: StockCountService;
  returns: PurchaseReturnService;
  orders: PurchaseOrderService;
}

export function registerPurchasingRoutes(
  app: FastifyInstance,
  deps: PurchasingRouteDeps,
): void {
  const { db, receipts, counts, returns, orders } = deps;

  const session = (req: { session: unknown }) => {
    const s = req.session as
      | { userId: string; pinUnlocked: boolean; fullName: string }
      | null;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    return s;
  };

  /** رسید و دامنه‌اش را با هم برمی‌گرداند — الگویی که هر مسیر لازم دارد. */
  const loadInScope = async (userId: string, receiptId: string) => {
    const scope = await branchesOf(db, userId);
    const receipt = await receipts.get(receiptId, scope);
    if (!receipt) {
      throw new PurchasingError("receipt_not_found", "رسید خرید یافت نشد", 404);
    }
    return receipt;
  };

  // ── تأمین‌کننده ──────────────────────────────────────────────────

  app.get("/suppliers", async (req) => {
    const s = session(req);
    const query = z
      .object({
        q: z.string().trim().max(60).optional(),
        includeInactive: z.enum(["true", "false"]).default("false"),
      })
      .parse(req.query ?? {});

    // خواندن فهرست تأمین‌کننده همان مجوزی را می‌خواهد که رسید خرید:
    // فهرست تأمین‌کننده‌ها خودش اطلاعات تجاری است.
    await requireForSession(db, s, "stock.receive");

    let q = db
      .selectFrom("purchasing.supplier")
      .select(["id", "code", "name", "mobile", "phone", "is_active"])
      .orderBy("name")
      .limit(500);

    if (query.includeInactive === "false") q = q.where("is_active", "=", true);
    if (query.q) {
      const like = `%${query.q}%`;
      q = q.where((eb) => eb.or([eb("name", "ilike", like), eb("code", "ilike", like)]));
    }

    const rows = await q.execute();
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      mobile: r.mobile,
      phone: r.phone,
      isActive: r.is_active,
    }));
  });

  /**
   * تأمین‌کننده تازه.
   *
   * `tafsili_no` را دیتابیس از یک Sequence می‌دهد — هر تأمین‌کننده یک
   * تفصیلی است و بدون آن، گردش حسابش از دفتر ساختنی نیست.
   */
  app.post("/suppliers", async (req, reply) => {
    const s = session(req);
    const body = createSupplierBody.parse(req.body);
    await requireForSession(db, s, "supplier.manage");

    const duplicate = await db
      .selectFrom("purchasing.supplier")
      .select("id")
      .where("code", "=", body.code)
      .executeTakeFirst();
    if (duplicate) {
      throw new PurchasingError("supplier_code_taken", `کد «${body.code}» قبلاً ثبت شده است`, 409);
    }

    const out = await runOnce<string>(db, {
      key: idempotencyKey(req),
      source: "api.supplier.create",
      payload: { actorId: s.userId, ...body },
      run: async (trx) => {
        const row = await trx
          .insertInto("purchasing.supplier")
          .values({
            code: body.code,
            name: body.name,
            mobile: body.mobile ?? null,
            phone: body.phone ?? null,
            address: body.address ?? null,
            national_id: body.nationalId ?? null,
            is_active: true,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        return { value: row.id, ref: row.id };
      },
      replay: async (ref) => ref,
    });

    const row = await db
      .selectFrom("purchasing.supplier")
      .select(["id", "code", "name", "tafsili_no"])
      .where("id", "=", out.value)
      .executeTakeFirstOrThrow();

    return reply.code(out.replayed ? 200 : 201).send({
      id: row.id,
      code: row.code,
      name: row.name,
      tafsiliNo: row.tafsili_no,
      replayed: out.replayed,
    });
  });

  // ── حساب‌های خزانه، برای هزینه‌ای که از خزانه پرداخت شده ──────────

  /**
   * حساب‌هایی که می‌شود هزینه رسید را از آن‌ها پرداخت کرد.
   *
   * صندوق فروشگاه عمداً بیرون است: دیتابیس هم ردش می‌کند
   * (`assert_charge_not_from_cash_box`)، ولی فهرستی که گزینه‌ای را
   * نشان بدهد که سرور ردش می‌کند، یک تله است.
   */
  app.get("/purchasing/pay-accounts", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "stock.receive");

    const rows = await db
      .selectFrom("treasury.account")
      .select(["id", "code", "name", "kind"])
      .where("is_active", "=", true)
      .where("kind", "!=", "cash_box")
      .orderBy("code")
      .execute();

    return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, kind: r.kind }));
  });

  /**
   * سرفصل‌های هزینه دوره — برای هزینه‌ای که به بهای کالا نمی‌رود.
   *
   * فقط حساب‌های **قابل ثبت** زیر «هزینه‌های عملیاتی». فهرست از
   * `ledger.account` می‌آید نه از کد؛ حسابدار سرفصل تازه بسازد،
   * همان‌جا دیده می‌شود.
   */
  app.get("/purchasing/expense-accounts", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "stock.receive");

    const rows = await db
      .selectFrom("ledger.account")
      .select(["code", "name"])
      .where("is_active", "=", true)
      .where("is_postable", "=", true)
      .where("type", "=", "expense")
      .orderBy("code")
      .execute();

    return rows.map((r) => ({ code: r.code, name: r.name }));
  });

  // ── رسید خرید ────────────────────────────────────────────────────

  app.get("/receipts", async (req) => {
    const s = session(req);
    const query = z
      .object({
        status: z.enum(["draft", "posted", "cancelled"]).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query ?? {});

    await requireForSession(db, s, "stock.receive");
    const scope = await branchesOf(db, s.userId);
    return receipts.list({
      branchIds: scope,
      limit: query.limit,
      ...(query.status === undefined ? {} : { status: query.status }),
    });
  });

  /**
   * یافتن رسید از روی شماره — نقطه شروع برگشت از خرید.
   *
   * ⚠️ پیش از `/receipts/:id` ثبت می‌شود. Fastify مسیر ثابت را بر
   * پارامتر مقدم می‌داند، ولی ترتیب صریح، خواننده بعدی را از حدس‌زدن
   * نجات می‌دهد.
   */
  app.get("/receipts/lookup", async (req) => {
    const s = session(req);
    const query = z
      .object({ number: z.string().trim().min(1).max(60), branchId: uuid })
      .parse(req.query ?? {});

    await assertBranch(db, s.userId, query.branchId);
    await requireForSession(db, s, "stock.receive");

    const found = await receipts.byNumber(query.number, query.branchId);
    if (!found) {
      throw new PurchasingError("receipt_not_found", "رسیدی با این شماره پیدا نشد", 404);
    }
    return loadInScope(s.userId, found.id);
  });

  app.get("/receipts/:id", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await requireForSession(db, s, "stock.receive");
    return loadInScope(s.userId, id);
  });

  app.post("/receipts", async (req, reply) => {
    const s = session(req);
    const body = createReceiptBody.parse(req.body);
    await assertBranch(db, s.userId, body.branchId);
    await assertWarehouseInBranch(db, body.warehouseId, body.branchId);
    await requireForSession(db, s, "stock.receive");

    const out = await runOnce<string>(db, {
      key: idempotencyKey(req),
      source: "api.receipt.create",
      payload: {
        actorId: s.userId,
        branchId: body.branchId,
        warehouseId: body.warehouseId,
        supplierId: body.supplierId,
        orderId: body.orderId ?? null,
        occurredAt: body.occurredAt ?? null,
        supplierInvoiceNo: body.supplierInvoiceNo ?? null,
        note: body.note ?? null,
      },
      run: async (trx) => {
        const id = await receipts.createDraft(trx, {
          branchId: body.branchId,
          warehouseId: body.warehouseId,
          supplierId: body.supplierId,
          actorId: s.userId,
          ...(body.orderId === undefined ? {} : { orderId: body.orderId }),
          ...(body.occurredAt === undefined ? {} : { occurredAt: body.occurredAt }),
          ...(body.supplierInvoiceNo === undefined
            ? {}
            : { supplierInvoiceNo: body.supplierInvoiceNo }),
          ...(body.note === undefined ? {} : { note: body.note }),
        });
        return { value: id, ref: id };
      },
      replay: async (ref) => ref,
    });

    const receipt = await loadInScope(s.userId, out.value);
    return reply.code(out.replayed ? 200 : 201).send({ ...receipt, replayed: out.replayed });
  });

  app.patch("/receipts/:id", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = updateHeadBody.parse(req.body);
    await loadInScope(s.userId, id);
    await requireForSession(db, s, "stock.receive");

    await db.transaction().execute((trx) =>
      receipts.updateHead(trx, {
        receiptId: id,
        actorId: s.userId,
        ...(body.taxAmount === undefined ? {} : { taxAmount: parseMoney(body.taxAmount) }),
        ...(body.supplierInvoiceNo === undefined
          ? {}
          : { supplierInvoiceNo: body.supplierInvoiceNo }),
        ...(body.occurredAt === undefined ? {} : { occurredAt: body.occurredAt }),
        ...(body.note === undefined ? {} : { note: body.note }),
      }),
    );

    return loadInScope(s.userId, id);
  });

  /**
   * افزودن قلم — با بارکد یا شناسه.
   *
   * بارکد پذیرفته می‌شود چون انباردار محموله را با اسکنر می‌شمارد، نه
   * با فهرست کشویی. کالای تکراری **با همان قیمت** روی یک سطر جمع
   * می‌شود؛ با قیمت متفاوت، سطر تازه — دو نرخ روی یک فاکتور، دو سطر
   * واقعی‌اند.
   */
  app.post("/receipts/:id/lines", async (req, reply) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = addLineBody.parse(req.body);
    await loadInScope(s.userId, id);
    await requireForSession(db, s, "stock.receive");

    const variationId = await resolveVariation(db, body);

    const out = await runOnce<string>(db, {
      key: idempotencyKey(req),
      source: "api.receipt.line.add",
      payload: {
        actorId: s.userId,
        receiptId: id,
        variationId,
        qty: body.qty,
        unitPrice: body.unitPrice,
        orderLineId: body.orderLineId ?? null,
      },
      run: async (trx) => {
        const lineId = await receipts.addLine(trx, {
          receiptId: id,
          variationId,
          qty: body.qty,
          unitPrice: parseMoney(body.unitPrice),
          actorId: s.userId,
          ...(body.orderLineId === undefined ? {} : { orderLineId: body.orderLineId }),
        });
        return { value: lineId, ref: lineId };
      },
      replay: async (ref) => ref,
    });

    const receipt = await loadInScope(s.userId, id);
    return reply.code(out.replayed ? 200 : 201).send({ ...receipt, replayed: out.replayed });
  });

  app.patch("/receipts/:id/lines/:lineId", async (req) => {
    const s = session(req);
    const { id, lineId } = z.object({ id: uuid, lineId: uuid }).parse(req.params);
    const body = setLineBody.parse(req.body);
    await loadInScope(s.userId, id);
    await requireForSession(db, s, "stock.receive");

    await db.transaction().execute((trx) =>
      receipts.setLine(trx, {
        receiptId: id,
        lineId,
        actorId: s.userId,
        ...(body.qty === undefined ? {} : { qty: body.qty }),
        ...(body.unitPrice === undefined ? {} : { unitPrice: parseMoney(body.unitPrice) }),
      }),
    );

    return loadInScope(s.userId, id);
  });

  app.delete("/receipts/:id/lines/:lineId", async (req) => {
    const s = session(req);
    const { id, lineId } = z.object({ id: uuid, lineId: uuid }).parse(req.params);
    await loadInScope(s.userId, id);
    await requireForSession(db, s, "stock.receive");

    await db
      .transaction()
      .execute((trx) => receipts.removeLine(trx, id, lineId, s.userId));
    return loadInScope(s.userId, id);
  });

  app.post("/receipts/:id/charges", async (req, reply) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = addChargeBody.parse(req.body);
    await loadInScope(s.userId, id);
    await requireForSession(db, s, "stock.receive");

    const out = await runOnce<string>(db, {
      key: idempotencyKey(req),
      source: "api.receipt.charge.add",
      payload: { actorId: s.userId, receiptId: id, ...body },
      run: async (trx) => {
        const chargeId = await receipts.addCharge(trx, {
          receiptId: id,
          chargeType: body.chargeType,
          amount: parseMoney(body.amount),
          allocation: body.allocation,
          paidFrom: body.paidFrom,
          payeeType: body.payeeType,
          actorId: s.userId,
          ...(body.payeeName === undefined ? {} : { payeeName: body.payeeName }),
          ...(body.paidAccountId === undefined ? {} : { paidAccountId: body.paidAccountId }),
          ...(body.expenseAccountCode === undefined
            ? {}
            : { expenseAccountCode: body.expenseAccountCode }),
        });
        return { value: chargeId, ref: chargeId };
      },
      replay: async (ref) => ref,
    });

    const receipt = await loadInScope(s.userId, id);
    return reply.code(out.replayed ? 200 : 201).send({ ...receipt, replayed: out.replayed });
  });

  app.delete("/receipts/:id/charges/:chargeId", async (req) => {
    const s = session(req);
    const { id, chargeId } = z.object({ id: uuid, chargeId: uuid }).parse(req.params);
    await loadInScope(s.userId, id);
    await requireForSession(db, s, "stock.receive");

    await db
      .transaction()
      .execute((trx) => receipts.removeCharge(trx, id, chargeId, s.userId));
    return loadInScope(s.userId, id);
  });

  /**
   * ثبت — لحظه‌ای که کالا وارد انبار و سند وارد دفتر می‌شود.
   *
   * Idempotent: کلیک دوم روی «ثبت» یا Retry شبکه نباید محموله را دو
   * بار وارد انبار کند. لایه دومش خودِ `post_receipt` است که رسید
   * ثبت‌شده را رد می‌کند — ولی آن لایه ۴۰۹ می‌دهد، و برای انباردارِ
   * که پاسخ اولش گم شده، ۴۰۹ شبیه خطاست.
   */
  app.post("/receipts/:id/post", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const receipt = await loadInScope(s.userId, id);
    await requireForSession(db, s, "stock.receive");

    if (receipt.lines.length === 0) {
      throw new PurchasingError("empty_receipt", "رسید بدون قلم ثبت نمی‌شود", 422);
    }

    const out = await runOnce<string>(db, {
      key: idempotencyKey(req),
      source: "api.receipt.post",
      payload: { actorId: s.userId, receiptId: id },
      run: async (trx) => {
        const entry = await receipts.post(trx, id, s.userId);
        return { value: entry, ref: entry };
      },
      replay: async (ref) => ref,
    });

    const posted = await loadInScope(s.userId, id);
    return { ...posted, entryId: out.value, replayed: out.replayed };
  });

  app.post("/receipts/:id/cancel", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await loadInScope(s.userId, id);
    await requireForSession(db, s, "stock.receive");

    await db.transaction().execute((trx) => receipts.cancelDraft(trx, id, s.userId));
    return loadInScope(s.userId, id);
  });

  // ── انبارگردانی ──────────────────────────────────────────────────
  //
  // مجوزش `stock.count` است، جدا از `stock.receive`: شمارش قفسه و
  // تحویل محموله دو کار متفاوت‌اند و — مهم‌تر — انبارگردانی موجودی را
  // **بدون سند خرید** عوض می‌کند. کسی که می‌تواند بشمارد، می‌تواند
  // کسری را پنهان کند.

  const countInScope = async (userId: string, countId: string) => {
    const scope = await branchesOf(db, userId);
    const sheet = await counts.get(countId, scope);
    if (!sheet) {
      throw new StockCountError("count_not_found", "برگه انبارگردانی یافت نشد", 404);
    }
    return sheet;
  };

  app.get("/stock-counts", async (req) => {
    const s = session(req);
    const query = z
      .object({
        status: z.enum(["draft", "posted", "cancelled"]).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query ?? {});

    await requireForSession(db, s, "stock.count");
    const scope = await branchesOf(db, s.userId);
    return counts.list({
      branchIds: scope,
      limit: query.limit,
      ...(query.status === undefined ? {} : { status: query.status }),
    });
  });

  app.get("/stock-counts/:id", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await requireForSession(db, s, "stock.count");
    return countInScope(s.userId, id);
  });

  app.post("/stock-counts", async (req, reply) => {
    const s = session(req);
    const body = createCountBody.parse(req.body);
    await assertBranch(db, s.userId, body.branchId);
    await assertWarehouseInBranch(db, body.warehouseId, body.branchId);
    await requireForSession(db, s, "stock.count");

    const out = await runOnce<string>(db, {
      key: idempotencyKey(req),
      source: "api.stock-count.create",
      payload: {
        actorId: s.userId,
        branchId: body.branchId,
        warehouseId: body.warehouseId,
        note: body.note ?? null,
      },
      run: async (trx) => {
        const id = await counts.createDraft(trx, {
          branchId: body.branchId,
          warehouseId: body.warehouseId,
          actorId: s.userId,
          ...(body.note === undefined ? {} : { note: body.note }),
        });
        return { value: id, ref: id };
      },
      replay: async (ref) => ref,
    });

    const sheet = await countInScope(s.userId, out.value);
    return reply.code(out.replayed ? 200 : 201).send({ ...sheet, replayed: out.replayed });
  });

  /**
   * ثبت یا اصلاح شمارش یک کالا.
   *
   * `PUT` است نه `POST` و عمداً: عملیات **مطلق** و تکرارپذیر است —
   * همان بارکد با همان عدد، هر چند بار که فرستاده شود یک نتیجه دارد.
   * به همین دلیل `Idempotency-Key` هم نمی‌خواهد.
   */
  app.put("/stock-counts/:id/lines", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = countLineBody.parse(req.body);
    await countInScope(s.userId, id);
    await requireForSession(db, s, "stock.count");

    const variationId = await resolveVariation(db, body);
    await db.transaction().execute((trx) =>
      counts.setLine(trx, {
        countId: id,
        variationId,
        countedQty: body.countedQty,
        actorId: s.userId,
      }),
    );

    return countInScope(s.userId, id);
  });

  app.delete("/stock-counts/:id/lines/:lineId", async (req) => {
    const s = session(req);
    const { id, lineId } = z.object({ id: uuid, lineId: uuid }).parse(req.params);
    await countInScope(s.userId, id);
    await requireForSession(db, s, "stock.count");

    await db.transaction().execute((trx) => counts.removeLine(trx, id, lineId, s.userId));
    return countInScope(s.userId, id);
  });

  /**
   * ثبت — تعدیل موجودی و سند کسری/اضافه.
   *
   * ⚠️ **موجودی سیستم را همین‌جا نمی‌خوانیم.** تابع دیتابیس آن را در
   * لحظه ثبت و روی سطر قفل‌شده می‌خواند. خواندنش اینجا یعنی دو تعریف
   * از یک عدد، و آنکه در فاصله میان دو خواندن عوض می‌شود همان است که
   * کسری کاذب می‌سازد.
   */
  app.post("/stock-counts/:id/post", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const sheet = await countInScope(s.userId, id);
    await requireForSession(db, s, "stock.count");

    if (sheet.lines.length === 0) {
      throw new StockCountError("empty_count", "برگه بدون سطر ثبت نمی‌شود", 422);
    }

    const out = await runOnce<string>(db, {
      key: idempotencyKey(req),
      source: "api.stock-count.post",
      payload: { actorId: s.userId, countId: id },
      run: async (trx) => {
        // سند ممکن است ساخته نشود (کسری و اضافه که هم را خنثی
        // می‌کنند). `ref` باید همیشه چیزی باشد، پس شناسه برگه
        // می‌نشیند نه شناسه سند.
        await counts.post(trx, id, s.userId);
        return { value: id, ref: id };
      },
      replay: async (ref) => ref,
    });

    const posted = await countInScope(s.userId, id);
    return { ...posted, replayed: out.replayed };
  });

  app.post("/stock-counts/:id/cancel", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await countInScope(s.userId, id);
    await requireForSession(db, s, "stock.count");

    await db.transaction().execute((trx) => counts.cancelDraft(trx, id, s.userId));
    return countInScope(s.userId, id);
  });

  // ── برگشت از خرید ────────────────────────────────────────────────

  /**
   * چه چیزی از یک رسید هنوز قابل برگشت است.
   *
   * نقطه شروع هر برگشت. `remainingQty` و بهای دفتری هر دو از سرور
   * می‌آیند — کلاینت نه تفریق می‌کند و نه بها را حدس می‌زند.
   */
  app.get("/receipts/:id/returnable", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await requireForSession(db, s, "stock.receive");

    const scope = await branchesOf(db, s.userId);
    const view = await returns.returnable(id, scope);
    if (!view) throw new PurchasingError("receipt_not_found", "رسید خرید یافت نشد", 404);
    return view;
  });

  app.get("/purchase-returns/:id", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await requireForSession(db, s, "stock.receive");

    const scope = await branchesOf(db, s.userId);
    const sheet = await returns.get(id, scope);
    if (!sheet) throw new PurchasingError("return_not_found", "برگ برگشت یافت نشد", 404);
    return sheet;
  });

  /**
   * ساخت و ثبت — در **یک** درخواست و یک تراکنش.
   *
   * جداکردنشان یک پنجره باز می‌کرد: برگه‌ای ساخته و ثبت‌نشده، که نه
   * موجودی را کم کرده نه بدهی را، ولی در فهرست هست. برای مرجوعی فروش
   * آن جداسازی معنا دارد (بازپرداخت نقدی مرحله جداست)؛ اینجا ندارد.
   */
  app.post("/purchase-returns", async (req, reply) => {
    const s = session(req);
    const body = createReturnBody.parse(req.body);

    const scope = await branchesOf(db, s.userId);
    const source = await returns.returnable(body.receiptId, scope);
    if (!source) throw new PurchasingError("receipt_not_found", "رسید خرید یافت نشد", 404);

    // برگشت از خرید موجودی را کم می‌کند و بدهی را — همان مجوزی که
    // رسید را ثبت می‌کند.
    await requireForSession(db, s, "stock.receive");

    const out = await runOnce<string>(db, {
      key: idempotencyKey(req),
      source: "api.purchase-return.create",
      payload: { actorId: s.userId, ...body },
      run: async (trx) => {
        const scopeRow = await trx
          .selectFrom("purchasing.receipt")
          .select(["branch_id", "warehouse_id"])
          .where("id", "=", body.receiptId)
          .executeTakeFirstOrThrow();

        const id = await returns.createDraft(trx, {
          branchId: scopeRow.branch_id,
          receiptId: body.receiptId,
          warehouseId: scopeRow.warehouse_id,
          reasonCode: body.reasonCode,
          lines: body.lines,
          actorId: s.userId,
          ...(body.reasonNote === undefined ? {} : { reasonNote: body.reasonNote }),
        });
        await returns.post(trx, id, s.userId);
        return { value: id, ref: id };
      },
      replay: async (ref) => ref,
    });

    const posted = await returns.get(out.value, scope);
    if (!posted) throw new PurchasingError("return_not_found", "برگ برگشت یافت نشد", 404);
    return reply.code(out.replayed ? 200 : 201).send({ ...posted, replayed: out.replayed });
  });

  // ── سفارش خرید ───────────────────────────────────────────────────
  //
  // ⚠️ هیچ‌کدام از این مسیرها سند نمی‌زند و موجودی را عوض نمی‌کند.
  //    سفارش یک **تعهد** است، نه یک رویداد مالی.

  const orderInScope = async (userId: string, orderId: string) => {
    const scope = await branchesOf(db, userId);
    const order = await orders.get(orderId, scope);
    if (!order) throw new PurchasingError("order_not_found", "سفارش خرید یافت نشد", 404);
    return order;
  };

  app.get("/purchase-orders", async (req) => {
    const s = session(req);
    const query = z
      .object({
        status: z.enum(["draft", "sent", "closed", "cancelled"]).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query ?? {});

    await requireForSession(db, s, "stock.receive");
    const scope = await branchesOf(db, s.userId);
    return orders.list({
      branchIds: scope,
      limit: query.limit,
      ...(query.status === undefined ? {} : { status: query.status }),
    });
  });

  app.get("/purchase-orders/:id", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await requireForSession(db, s, "stock.receive");
    return orderInScope(s.userId, id);
  });

  app.post("/purchase-orders", async (req, reply) => {
    const s = session(req);
    const body = createOrderBody.parse(req.body);
    await assertBranch(db, s.userId, body.branchId);
    await assertWarehouseInBranch(db, body.warehouseId, body.branchId);
    await requireForSession(db, s, "stock.receive");

    const out = await runOnce<string>(db, {
      key: idempotencyKey(req),
      source: "api.purchase-order.create",
      payload: { actorId: s.userId, ...body },
      run: async (trx) => {
        const id = await orders.createDraft(trx, {
          branchId: body.branchId,
          supplierId: body.supplierId,
          warehouseId: body.warehouseId,
          actorId: s.userId,
          ...(body.expectedAt === undefined ? {} : { expectedAt: body.expectedAt }),
          ...(body.note === undefined ? {} : { note: body.note }),
        });
        return { value: id, ref: id };
      },
      replay: async (ref) => ref,
    });

    const order = await orderInScope(s.userId, out.value);
    return reply.code(out.replayed ? 200 : 201).send({ ...order, replayed: out.replayed });
  });

  /** قلم مطلق است، پس `PUT` و بدون `Idempotency-Key`. */
  app.put("/purchase-orders/:id/lines", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = orderLineBody.parse(req.body);
    await orderInScope(s.userId, id);
    await requireForSession(db, s, "stock.receive");

    const variationId = await resolveVariation(db, body);
    await db.transaction().execute((trx) =>
      orders.setLine(trx, {
        orderId: id,
        variationId,
        qty: body.qty,
        unitPrice: parseMoney(body.unitPrice),
        actorId: s.userId,
      }),
    );

    return orderInScope(s.userId, id);
  });

  app.delete("/purchase-orders/:id/lines/:lineId", async (req) => {
    const s = session(req);
    const { id, lineId } = z.object({ id: uuid, lineId: uuid }).parse(req.params);
    await orderInScope(s.userId, id);
    await requireForSession(db, s, "stock.receive");

    await db.transaction().execute((trx) => orders.removeLine(trx, id, lineId, s.userId));
    return orderInScope(s.userId, id);
  });

  /**
   * فرستادن — سفارش شماره می‌گیرد و دیگر ویرایش نمی‌شود.
   *
   * ⚠️ هیچ سندی و هیچ حرکت انباری‌ای ساخته نمی‌شود. اگر روزی کسی
   * چیزی اینجا اضافه کند، `db/test/purchase-order.sql` قرمز می‌شود.
   */
  app.post("/purchase-orders/:id/send", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const order = await orderInScope(s.userId, id);
    await requireForSession(db, s, "stock.receive");

    if (order.lines.length === 0) {
      throw new PurchasingError("empty_order", "سفارش بدون قلم فرستادنی نیست", 422);
    }

    await runOnce<string>(db, {
      key: idempotencyKey(req),
      source: "api.purchase-order.send",
      payload: { actorId: s.userId, orderId: id },
      run: async (trx) => {
        const number = await orders.send(trx, id, s.userId);
        return { value: number, ref: id };
      },
      replay: async (ref) => ref,
    });

    return orderInScope(s.userId, id);
  });

  /**
   * «محموله این سفارش رسید» — یک پیش‌نویس رسید، از روی باقی‌مانده.
   *
   * بدون این، انباردار باید هر قلم را دوباره دستی وارد کند و
   * `orderLineId` را از جایی پیدا کند — که یعنی در عمل هیچ رسیدی به
   * سفارش وصل نمی‌شود و پیشرفت سفارش برای همیشه صفر می‌ماند.
   *
   * پیش‌نویس با **باقی‌مانده** پر می‌شود و به **قیمت توافقی سفارش**.
   * هر دو قابل ویرایش‌اند: فاکتور تأمین‌کننده حرف آخر را می‌زند، نه
   * سفارش.
   */
  app.post("/purchase-orders/:id/receipt", async (req, reply) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const order = await orderInScope(s.userId, id);
    await requireForSession(db, s, "stock.receive");

    if (order.status !== "sent") {
      throw new PurchasingError(
        "order_not_sent",
        "فقط سفارش فرستاده‌شده می‌تواند رسید بگیرد",
        422,
      );
    }

    const pending = order.lines.filter((l) => Number(l.remainingQty) > 0);
    if (pending.length === 0) {
      throw new PurchasingError("order_complete", "همه اقلام این سفارش رسیده‌اند", 422);
    }

    const out = await runOnce<string>(db, {
      key: idempotencyKey(req),
      source: "api.purchase-order.receipt",
      payload: {
        actorId: s.userId,
        orderId: id,
        // باقی‌مانده در Payload است تا Retry پس از یک رسید جزئیِ
        // موفق، Replay نشود: وضعیت سفارش عوض شده، پس درخواست هم
        // درخواست دیگری است.
        pending: pending.map((l) => ({ line: l.id, qty: l.remainingQty })),
      },
      run: async (trx) => {
        const receiptId = await receipts.createDraft(trx, {
          branchId: order.branchId,
          warehouseId: order.warehouseId,
          supplierId: order.supplierId,
          orderId: id,
          actorId: s.userId,
        });
        for (const line of pending) {
          await receipts.addLine(trx, {
            receiptId,
            variationId: line.variationId,
            qty: line.remainingQty,
            unitPrice: parseMoney(line.unitPrice),
            orderLineId: line.id,
            actorId: s.userId,
          });
        }
        return { value: receiptId, ref: receiptId };
      },
      replay: async (ref) => ref,
    });

    const receipt = await loadInScope(s.userId, out.value);
    return reply.code(out.replayed ? 200 : 201).send({ ...receipt, replayed: out.replayed });
  });

  /**
   * بستن — یک **تصمیم انسانی**، نه نتیجه یک محاسبه.
   *
   * تأمین‌کننده گفته بقیه‌اش نمی‌آید، یا فصل عوض شده. اگر خودکار با
   * «همه رسید» بسته می‌شد، سفارشِ نیمه‌رسیده تا ابد باز می‌ماند و
   * فهرست سفارش‌های باز بی‌فایده می‌شد.
   *
   * دیتابیس اجبار می‌کند که بستن سفارشِ نیمه‌رسیده دلیل داشته باشد.
   */
  app.post("/purchase-orders/:id/close", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({ reason: z.string().trim().max(300).optional() })
      .parse(req.body ?? {});
    await orderInScope(s.userId, id);
    await requireForSession(db, s, "stock.receive");

    await db
      .transaction()
      .execute((trx) => orders.close(trx, id, body.reason ?? null, s.userId));
    return orderInScope(s.userId, id);
  });
}

/**
 * بارکد یا شناسه → شناسه تنوع.
 *
 * منطقش به `catalog/resolve.ts` منتقل شد چون مسیر انتقال بین انبارها
 * هم دقیقاً همان را می‌خواست. کلاس خطا همان `PurchasingError` می‌ماند،
 * پس کد و پیام این مسیرها دست‌نخورده است.
 */
async function resolveVariation(
  db: Db,
  input: { variationId?: string | undefined; barcode?: string | undefined },
): Promise<string> {
  return await resolveVariationId(
    db,
    input,
    (code, message, status) => new PurchasingError(code, message, status),
  );
}

function idempotencyKey(req: { headers: Record<string, unknown> }): string | undefined {
  const raw = req.headers["idempotency-key"];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}
