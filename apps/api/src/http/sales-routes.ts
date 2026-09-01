/**
 * مسیرهای فروش و صندوق.
 *
 * سه قاعده‌ای که هر Handler اینجا رعایت می‌کند:
 *
 * ۱. مجوز از `requireForSession` — تا `viaPin` از نشست بیاید، نه از
 *    فراخوان. همان چیزی که یک بار فراموش شد و کنترل PIN را مرده کرد.
 * ۲. مجوز **پیش از** هر نوشتنی گرفته می‌شود، نه بعدش.
 * ۳. پول در ورودی و خروجی رشته است. `parseMoney` عدد را صریح رد می‌کند.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AuthError } from "../auth/service.ts";
import { can, requireForSession } from "../auth/permission.ts";
import type { Db } from "../db/client.ts";
import { parseMoney, serializeMoney } from "../lib/money.ts";
import { runOnce } from "../lib/idempotency.ts";
import { InvoiceError, invoiceToJson, type InvoiceService } from "../sales/invoice.ts";
import { ShiftError, shiftToJson, type ShiftService } from "../sales/shift.ts";
import { assertBranch, assertWarehouseInBranch } from "../sales/scope.ts";

/** پول در JSON رشته است — رقم صحیح، بدون اعشار و بدون جداکننده. */
const moneyString = z
  .string()
  .regex(/^\d+$/, "مبلغ باید رقم صحیح باشد (ریال، بدون اعشار)");

const uuid = z.string().uuid("شناسه نامعتبر");

const openShiftBody = z.object({
  branchId: uuid,
  openingCash: moneyString.default("0"),
});

const closeShiftBody = z.object({
  countedCash: moneyString,
  note: z.string().max(500).optional(),
});

const createInvoiceBody = z.object({
  branchId: uuid,
  warehouseId: uuid,
  customerId: uuid.optional(),
  channel: z.enum(["pos", "web", "phone"]).default("pos"),
});

const addLineBody = z
  .object({
    variationId: uuid.optional(),
    barcode: z.string().min(1).max(64).optional(),
    qty: z.string().regex(/^\d+(\.\d{1,3})?$/, "تعداد نامعتبر"),
    discountAmount: moneyString.optional(),
    discountReason: z.string().max(200).optional(),
    /**
     * قیمت دستی — مثل دشت. اگر نیاید، قیمت از `catalog.price` خوانده
     * می‌شود؛ یعنی رفتار پیش‌فرض دست‌نخورده می‌ماند و کلاینتی که این
     * میدان را نمی‌فرستد هیچ قدرت تازه‌ای نمی‌گیرد.
     */
    unitPrice: moneyString.optional(),
    priceOverrideReason: z.string().max(200).optional(),
  })
  .refine((v) => v.variationId ?? v.barcode, {
    message: "کالا باید با شناسه یا بارکد مشخص شود",
  });

/**
 * تعداد در صندوق عدد صحیح است — عمداً سخت‌گیرتر از `addLine`.
 *
 * دیتابیس `platform.qty` اعشاری می‌پذیرد و باید بپذیرد (متر پارچه
 * روزی می‌آید). ولی صندوق پوشاک امروز کالای تعدادی می‌فروشد و «۱٫۵
 * پیراهن» یک اشتباه تایپی است، نه یک فروش.
 */
const setLineQtyBody = z.object({
  qty: z.string().regex(/^\d+$/, "تعداد باید عدد صحیح باشد"),
});

const paymentBody = z.object({
  methodCode: z.string().min(1).max(32),
  amount: moneyString,
  refNo: z.string().max(64).optional(),
  accountId: uuid.optional(),
});

export interface SalesRouteDeps {
  db: Db;
  invoices: InvoiceService;
  shifts: ShiftService;
}

export function registerSalesRoutes(app: FastifyInstance, deps: SalesRouteDeps): void {
  const { db, invoices, shifts } = deps;

  const session = (req: { session: unknown }) => {
    const s = req.session as
      | { userId: string; pinUnlocked: boolean; fullName: string }
      | null;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    return s;
  };

  // ── شیفت صندوق ──────────────────────────────────────────────────

  app.get("/shifts/current", async (req) => {
    const s = session(req);
    const branchId = z.object({ branchId: uuid }).parse(req.query).branchId;
    await assertBranch(db, s.userId, branchId);
    const shift = await shifts.current(s.userId, branchId);
    return shift ? shiftToJson(shift) : null;
  });

  app.post("/shifts", async (req, reply) => {
    const s = session(req);
    const body = openShiftBody.parse(req.body);
    await assertBranch(db, s.userId, body.branchId);
    await requireForSession(db, s, "sale.create");

    const shift = await shifts.open({
      userId: s.userId,
      branchId: body.branchId,
      openingCash: parseMoney(body.openingCash),
    });
    return reply.code(201).send(shiftToJson(shift));
  });

  /**
   * بستن شیفت — سند تجمیعی فروش، COGS و مغایرت اینجا زده می‌شوند.
   *
   * مجوز جدا از فروش است: `shift.close`. صندوق‌داری که می‌تواند بفروشد،
   * لزوماً نباید بتواند کشو را ببندد.
   */
  app.post("/shifts/:id/close", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = closeShiftBody.parse(req.body);

    const shift = await shifts.byId(id);
    if (!shift) throw new ShiftError("shift_not_found", "شیفت یافت نشد", 404);
    await assertBranch(db, s.userId, shift.branchId);

    // مجوز `shift.close` جدا از `sale.create` است — و طبق داده فعلی
    // permission_rule، صندوق‌دار آن را ندارد. یعنی بستن کشو تصمیم
    // سرپرست است، حتی برای شیفت خودِ صندوق‌دار. این یک تصمیم داده‌ای
    // است نه کدی؛ اگر عوض شود، یک UPDATE کافی است.
    await requireForSession(db, s, "shift.close");

    const closed = await shifts.close({
      shiftId: id,
      countedCash: parseMoney(body.countedCash),
      actorId: s.userId,
      ...(body.note === undefined ? {} : { note: body.note }),
    });
    return shiftToJson(closed);
  });

  // ── سبد و فاکتور ────────────────────────────────────────────────

  app.post("/invoices", async (req, reply) => {
    const s = session(req);
    const body = createInvoiceBody.parse(req.body);
    // دامنه پیش از مجوز: بی‌معناست که بپرسیم «می‌تواند بفروشد؟» وقتی
    // اصلاً به آن شعبه دسترسی ندارد.
    await assertBranch(db, s.userId, body.branchId);
    await assertWarehouseInBranch(db, body.warehouseId, body.branchId);
    await requireForSession(db, s, "sale.create");

    // فاکتور صندوق به شیفت باز کاربر می‌چسبد. بدون شیفت، درآمدش به
    // هیچ دوره ثبتی وصل نمی‌شود — همان الگوی C1.
    let shiftId: string | undefined;
    if (body.channel === "pos") {
      const shift = await shifts.current(s.userId, body.branchId);
      if (!shift) {
        throw new ShiftError(
          "no_open_shift",
          "برای فروش صندوق باید شیفت باز داشته باشید.",
          422,
        );
      }
      shiftId = shift.id;
    }

    const inv = await invoices.createDraft({
      branchId: body.branchId,
      warehouseId: body.warehouseId,
      channel: body.channel,
      actorId: s.userId,
      ...(shiftId === undefined ? {} : { shiftId }),
      ...(body.customerId === undefined ? {} : { customerId: body.customerId }),
    });
    return reply.code(201).send(invoiceToJson(inv));
  });

  app.get("/invoices/:id", async (req) => {
    session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const inv = await invoices.byId(id);
    if (!inv) throw new InvoiceError("invoice_not_found", "فاکتور یافت نشد", 404);
    await assertBranch(db, session(req).userId, inv.branchId);
    return invoiceToJson(inv);
  });

  /**
   * افزودن قلم به سبد.
   *
   * قیمت **از دیتابیس** خوانده می‌شود، مگر اینکه کلاینت `unitPrice`
   * بفرستد — و آن‌وقت دو دروازه باز می‌شود، نه یکی.
   */
  app.post("/invoices/:id/lines", async (req, reply) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = addLineBody.parse(req.body);
    await assertInvoiceInScope(db, s.userId, id, invoices);
    await requireForSession(db, s, "sale.create");

    const discount = body.discountAmount ? parseMoney(body.discountAmount) : 0n;
    const manualPrice = body.unitPrice === undefined ? undefined : parseMoney(body.unitPrice);

    // ورودی بی‌معنا **پیش از** مجوز رد می‌شود. بدون این، قیمت صفر یک
    // کاهش ۱۰۰٪ بود و به‌جای «قیمت نامعتبر»، «نیازمند تأیید سرپرست»
    // می‌گرفت — یعنی سیستم پیشنهاد می‌کرد کسی آن را تأیید کند.
    // (`InvoiceService` هم همین را می‌سنجد؛ آن لایه دوم است.)
    if (manualPrice !== undefined && manualPrice <= 0n) {
      throw new InvoiceError("bad_price", "قیمت باید بزرگ‌تر از صفر باشد", 422);
    }

    // ── دروازه اول: اجازه **تایپ‌کردن** قیمت ─────────────────────────
    // جدا از سقف تخفیف است، چون دو چیز متفاوت‌اند: «آیا این نقش اصلاً
    // حق دارد قیمت بنویسد» و «چقدر پایین‌تر از فهرست». صندوق‌دار
    // ممکن است اولی را نداشته باشد ولی تخفیف عادی را داشته باشد.
    if (manualPrice !== undefined) {
      await requireForSession(db, s, "sale.price_override");
    }

    // ── دروازه دوم: سقف **کاهش کل** ──────────────────────────────────
    // مجوز **پیش از** نوشتن سنجیده می‌شود، با درصد واقعی.
    //
    // «کاهش کل» یعنی تخفیف به‌علاوه تفاوت قیمت دستی، در یک عدد. این
    // نکته کل امنیت این مسیر است: اگر فقط تخفیف سنجیده می‌شد،
    // صندوق‌داری با سقف ۱۰٪ کافی بود قیمت را نصف بنویسد و همان کار را
    // بی‌مجوز بکند.
    //
    // دو عملیات، نه یکی: `sale.discount` سقف عادی نقش است و
    // `sale.discount_high` پله بالاتر که تأیید می‌خواهد. اگر فقط اولی
    // سنجیده می‌شد، تخفیف بالای سقف «ممنوع» می‌شد نه «نیازمند تأیید»
    // — و سرپرست هیچ‌وقت پرسیده نمی‌شد.
    //
    // خودِ آستانه‌ها اینجا نیستند: هر دو از permission_rule می‌آیند.
    // این کد فقط می‌داند «یک پله بالاتر هم هست»، نه اینکه پله کجاست.
    if (discount > 0n || manualPrice !== undefined) {
      const variationId = await invoices.resolveVariation(body);
      const check = await invoices.markdownCheck(variationId, body.qty, discount, manualPrice);
      if (check.grossAmount > 0n) {
        const normal = await can(db, {
          userId: s.userId,
          operation: "sale.discount",
          percent: check.percent,
          amount: check.grossAmount,
          viaPin: s.pinUnlocked,
        });
        if (normal.verdict !== "allow") {
          await requireForSession(db, s, "sale.discount_high", {
            percent: check.percent,
            amount: check.grossAmount,
          });
        }
      }
    }

    const inv = await invoices.addLine({
      invoiceId: id,
      qty: body.qty,
      actorId: s.userId,
      discountAmount: discount,
      ...(body.variationId === undefined ? {} : { variationId: body.variationId }),
      ...(body.barcode === undefined ? {} : { barcode: body.barcode }),
      ...(body.discountReason === undefined ? {} : { discountReason: body.discountReason }),
      ...(manualPrice === undefined ? {} : { unitPrice: manualPrice }),
      ...(body.priceOverrideReason === undefined
        ? {}
        : { priceOverrideReason: body.priceOverrideReason }),
    });
    return reply.code(201).send(invoiceToJson(inv));
  });

  /**
   * تغییر تعداد یک قلم.
   *
   * `qty` **مطلق** است نه دلتا: کلیک دوم روی «+» که پاسخ اولی هنوز
   * نرسیده، با دلتا دو بار شمرده می‌شد. با مقدار مطلق، آخرین درخواست
   * برنده است و تکرارش اثری ندارد.
   *
   * `qty=0` رد می‌شود: حذف قلم مسیر خودش را دارد و یک عملیات دیگر
   * است — با دلیل و ردّ حسابرسی متفاوت.
   */
  app.patch("/invoices/:id/lines/:lineId", async (req) => {
    const s = session(req);
    const { id, lineId } = z.object({ id: uuid, lineId: uuid }).parse(req.params);
    const body = setLineQtyBody.parse(req.body);
    if (Number(body.qty) <= 0) {
      throw new InvoiceError("bad_qty", "تعداد باید بزرگ‌تر از صفر باشد؛ برای حذف قلم از مسیر حذف استفاده کنید.", 400);
    }
    await assertInvoiceInScope(db, s.userId, id, invoices);
    await requireForSession(db, s, "sale.create");

    return invoiceToJson(
      await invoices.setLineQty({ invoiceId: id, lineId, qty: body.qty, actorId: s.userId }),
    );
  });

  app.delete("/invoices/:id/lines/:lineId", async (req) => {
    const s = session(req);
    const { id, lineId } = z.object({ id: uuid, lineId: uuid }).parse(req.params);
    await assertInvoiceInScope(db, s.userId, id, invoices);
    await requireForSession(db, s, "sale.create");
    return invoiceToJson(await invoices.removeLine(id, lineId, s.userId));
  });

  /**
   * رها کردن سبد — مشتری رفت.
   *
   * مجوزش `sale.create` است نه `invoice.cancel`: سبدی که هیچ اثر مالی
   * ندارد، ابطال فاکتور نیست. اگر همان مجوز سنگین را می‌خواست،
   * صندوق‌دار وسط شیفت گیر می‌کرد و کسی باید سرپرست را صدا می‌زد.
   */
  app.post("/invoices/:id/cancel", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ reason: z.string().max(200).optional() }).parse(req.body ?? {});
    await assertInvoiceInScope(db, s.userId, id, invoices);
    await requireForSession(db, s, "sale.create");
    const inv = await invoices.cancelDraft(id, s.userId, body.reason);
    return invoiceToJson(inv);
  });

  app.post("/invoices/:id/payments", async (req, reply) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = paymentBody.parse(req.body);
    await assertInvoiceInScope(db, s.userId, id, invoices);
    await requireForSession(db, s, "sale.create");

    const result = await invoices.addPayment({
      invoiceId: id,
      methodCode: body.methodCode,
      amount: parseMoney(body.amount),
      actorId: s.userId,
      ...(body.refNo === undefined ? {} : { refNo: body.refNo }),
      ...(body.accountId === undefined ? {} : { accountId: body.accountId }),
      ...(idempotencyKey(req) === undefined ? {} : { clientEventId: idempotencyKey(req) }),
    });
    return reply.code(201).send(result);
  });

  /**
   * نهایی‌سازی — تنها جایی که کالا از انبار خارج می‌شود.
   *
   * Idempotent با هدر `Idempotency-Key`: کلیک دوم روی «نهایی‌کردن» یا
   * Retry شبکه تبلت نباید فاکتور دوم بسازد و کالا را دو بار کم کند.
   */
  app.post("/invoices/:id/finalize", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await assertInvoiceInScope(db, s.userId, id, invoices);
    await requireForSession(db, s, "sale.create");

    const inv = await invoices.byId(id);
    if (!inv) throw new InvoiceError("invoice_not_found", "فاکتور یافت نشد", 404);

    // فروش نسیه مجوز جداگانه دارد: اگر پول کامل نرسیده، این یک اعتبار
    // است نه یک فروش نقدی — و صندوق‌دار پیش‌فرض اجازه‌اش را ندارد.
    if (inv.status === "draft") {
      const payable = inv.netAmount + inv.taxAmount + inv.shippingAmount;
      const paid = await invoices.paidSoFar(id);
      if (paid < payable) {
        if (!inv.customerId) {
          throw new InvoiceError(
            "credit_needs_customer",
            "فروش نسیه بدون مشتری ممکن نیست — بدهی باید به شخصی بچسبد.",
            422,
          );
        }
        await requireForSession(db, s, "sale.credit", { amount: payable - paid });
      }
    }

    const out = await runOnce<{ number: string }>(db, {
      key: idempotencyKey(req),
      source: "api.invoice.finalize",
      payload: { invoiceId: id },
      run: async (trx) => {
        const number = await invoices.finalizeIn(trx, id, s.userId);
        return { value: { number }, ref: id };
      },
      replay: async (ref) => {
        const done = await invoices.byId(ref);
        return { number: done?.number ?? "" };
      },
    });

    const finalized = await invoices.byId(id);
    return {
      ...invoiceToJson(finalized as NonNullable<typeof finalized>),
      replayed: out.replayed,
    };
  });

  // ── موجودی، برای اینکه صندوق پیش از فروش بداند ───────────────────

  app.get("/stock/:variationId", async (req) => {
    session(req);
    const { variationId } = z.object({ variationId: uuid }).parse(req.params);
    const { warehouseId } = z.object({ warehouseId: uuid }).parse(req.query);
    const wh = await db
      .selectFrom("inventory.warehouse")
      .select("branch_id")
      .where("id", "=", warehouseId)
      .executeTakeFirst();
    if (!wh) throw new InvoiceError("warehouse_not_found", "انبار یافت نشد", 404);
    await assertBranch(db, session(req).userId, wh.branch_id);

    const row = await db
      .selectFrom("inventory.stock_balance")
      .select(["on_hand", "reserved"])
      .where("variation_id", "=", variationId)
      .where("warehouse_id", "=", warehouseId)
      .executeTakeFirst();

    const price = await invoices.currentPrice(variationId).catch(() => null);
    return {
      variationId,
      warehouseId,
      onHand: row?.on_hand ?? "0",
      reserved: row?.reserved ?? "0",
      unitPrice: price === null ? null : serializeMoney(price),
    };
  });
}

/** فاکتور باید در دامنه شعبه‌های کاربر باشد. */
async function assertInvoiceInScope(
  db: Db,
  userId: string,
  invoiceId: string,
  invoices: InvoiceService,
): Promise<void> {
  const inv = await invoices.byId(invoiceId);
  if (!inv) throw new InvoiceError("invoice_not_found", "فاکتور یافت نشد", 404);
  await assertBranch(db, userId, inv.branchId);
}

function idempotencyKey(req: { headers: Record<string, unknown> }): string | undefined {
  const raw = req.headers["idempotency-key"];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}
