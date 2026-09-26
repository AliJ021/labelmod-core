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
import { CONTROL_CHARS_MESSAGE, hasControlChars } from "../lib/text.ts";
import { InvoiceError, invoiceToJson, type InvoiceService } from "../sales/invoice.ts";
import { ShiftError, shiftToJson, type ShiftService } from "../sales/shift.ts";
import { assertBranch, assertWarehouseInBranch } from "../sales/scope.ts";
import { assertMarkdownAllowed as markdownGate } from "../sales/markdown-gate.ts";

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

/**
 * اسکن صندوق — بارکد و تعداد، هیچ قیمتی.
 *
 * `qty` پیش‌فرض «۱» است چون یک کشیدن اسکنر یعنی یک عدد.
 */
const scanBody = z
  .object({
    variationId: uuid.optional(),
    barcode: z.string().min(1).max(64).optional(),
    qty: z.string().regex(/^\d+$/, "تعداد باید عدد صحیح باشد").default("1"),
  })
  .refine((v) => v.variationId ?? v.barcode, {
    message: "کالا باید با شناسه یا بارکد مشخص شود",
  });

/**
 * قیمت دستی روی سطری که همین حالا در سبد است.
 *
 * `unitPrice` اجباری است — این مسیر فقط یک کار می‌کند. «برگرداندن به
 * قیمت فهرست» هم همین مسیر است: کافی است قیمت فهرست فرستاده شود و
 * تابع دیتابیس خودش Snapshot را پاک می‌کند.
 */
const setLinePriceBody = z.object({
  unitPrice: moneyString,
  priceOverrideReason: z.string().max(200).optional(),
});

/** تخفیف روی سطری که همین حالا در سبد است. */
const setLineDiscountBody = z.object({
  discountAmount: moneyString,
  discountReason: z.string().max(200).optional(),
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

  /**
   * دروازه «کاهش قیمت» — تعریفش در `sales/markdown-gate.ts` است.
   *
   * منتقل شد چون سفارش سایت هم قیمت می‌فرستد و باید از **همان** دروازه
   * بگذرد. دو نسخه از یک قاعده مالی یعنی یکی‌شان عقب می‌ماند، و همان
   * است که دور زده می‌شود.
   */
  // ── شیفت صندوق ──────────────────────────────────────────────────

  app.get("/shifts/open", async (req) => {
    const s = session(req);
    const { branchId } = z.object({ branchId: uuid }).parse(req.query);
    await assertBranch(db, s.userId, branchId);
    const sameDay = await can(db, { userId: s.userId, operation: "return.same_day", viaPin: s.pinUnlocked });
    if (sameDay.verdict !== "allow") await requireForSession(db, s, "return.late");
    const open = await shifts.openInBranch(branchId);
    const users = open.length === 0 ? [] : await db.selectFrom("identity.app_user")
      .select(["id", "full_name"]).where("id", "in", open.map((x) => x.userId)).execute();
    return open.map((x) => ({ id: x.id, openedAt: x.openedAt.toISOString(),
      userName: users.find((u) => u.id === x.userId)?.full_name ?? "—" }));
  });

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

    // Idempotent: بستن شیفت سند فروش، COGS و مغایرت می‌زند. تکرار
    // درخواست تا امروز ۴۰۹ «شیفت قبلاً بسته شده» می‌گرفت — ایمن، ولی
    // برای صندوق‌داری که پاسخ اولش در شبکه گم شده، شبیه خطاست.
    const out = await runOnce<string>(db, {
      key: idempotencyKey(req),
      source: "api.shift.close",
      payload: {
        actorId: s.userId,
        shiftId: id,
        countedCash: body.countedCash,
        note: body.note ?? null,
      },
      run: async (trx) => {
        await shifts.closeIn(trx, {
          shiftId: id,
          countedCash: parseMoney(body.countedCash),
          actorId: s.userId,
          ...(body.note === undefined ? {} : { note: body.note }),
        });
        return { value: id, ref: id };
      },
      replay: async (ref) => ref,
    });

    const closed = await shifts.byId(out.value);
    if (!closed) throw new ShiftError("shift_not_found", "شیفت یافت نشد", 404);
    // دامنه در مسیر Replay هم دوباره سنجیده می‌شود.
    await assertBranch(db, s.userId, closed.branchId);
    return { ...shiftToJson(closed), replayed: out.replayed };
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

    // Idempotent: دابل‌کلیک روی «فروش تازه» یا Retry شبکه تبلت نباید
    // یک پیش‌نویس دوم جا بگذارد. پیش‌نویس رها اثر مالی ندارد، ولی
    // `close_shift` تا ابد ردش می‌کند: «شیفت با فاکتور نهایی‌نشده بسته
    // نمی‌شود».
    //
    // `shiftId` عمداً در Payload نیست: ورودی کلاینت نیست، از وضعیت
    // سرور می‌آید. اگر بود، Retry همان درخواست پس از عوض‌شدن شیفت
    // به‌جای Replay، Conflict می‌گرفت.
    const out = await runOnce<string>(db, {
      key: idempotencyKey(req),
      source: "api.invoice.create",
      payload: {
        actorId: s.userId,
        branchId: body.branchId,
        warehouseId: body.warehouseId,
        channel: body.channel,
        customerId: body.customerId ?? null,
      },
      run: async (trx) => {
        const id = await invoices.createDraftIn(trx, {
          branchId: body.branchId,
          warehouseId: body.warehouseId,
          channel: body.channel,
          actorId: s.userId,
          ...(shiftId === undefined ? {} : { shiftId }),
          ...(body.customerId === undefined ? {} : { customerId: body.customerId }),
        });
        return { value: id, ref: id };
      },
      replay: async (ref) => ref,
    });

    // مسیر Replay هم دامنه را دوباره می‌سنجد: بدون این، کاربر شعبه
    // دیگر با حدس‌زدن یک کلید، فاکتور کسی را می‌دید.
    await assertInvoiceInScope(db, s.userId, out.value, invoices);
    const inv = await invoices.byId(out.value);
    if (!inv) throw new InvoiceError("invoice_not_found", "فاکتور ساخته نشد", 500);

    return reply.code(out.replayed ? 200 : 201).send({
      ...invoiceToJson(inv),
      replayed: out.replayed,
    });
  });

  /**
   * یک فاکتور، با «چقدر تا حالا گرفته‌ایم».
   *
   * `receivedAmount` اینجا لازم است چون `invoice.paidAmount` روی
   * پیش‌نویس عمداً صفر است — آن ستون را `finalize_invoice` می‌نویسد.
   * بدون این میدان، صندوقی که وسط فروش Reload شده هیچ راهی نداشت
   * بفهمد مشتری قبلاً بخشی از پول را داده: سبد را با «دریافتی صفر»
   * بازمی‌ساخت و همان مبلغ **دوباره** گرفته می‌شد.
   *
   * همان `paidSoFar` که مسیر پرداخت استفاده می‌کند — یک تعریف، نه دو
   * تا. جمع پرداخت‌های **واقعاً موفق**؛ «نامشخص» و «در انتظار» پول
   * شمرده نمی‌شوند.
   */
  /**
   * یافتن فاکتور از روی شماره رسید.
   *
   * مرجوعی از روی رسیدِ دست مشتری شروع می‌شود و روی آن یک **شماره**
   * چاپ شده، نه UUID. بدون این مسیر، صفحه مرجوعی راهی نداشت جز
   * اینکه از صندوق‌دار UUID بخواهد.
   *
   * **مسیر ثابت پیش از `/:id` ثبت می‌شود** تا مسیریاب Fastify
   * «lookup» را شناسه نخواند. ادعای پایدارش در تست هست، چون این
   * چیزی است که با یک جابه‌جایی بی‌ربط در همین فایل می‌شکند.
   *
   * جست‌وجو **همیشه شعبه‌دار** است: شماره در سطح شعبه یکتاست، نه
   * سراسری (`platform.next_document_no()` شمارنده را به شعبه
   * می‌بندد). بدون این، صندوق‌دار شعبه A رسید شعبه B را پیدا می‌کرد.
   */
  app.get("/invoices/lookup", async (req) => {
    const s = session(req);
    const q = z
      .object({ number: z.string().min(1).max(64), branchId: uuid })
      .parse(req.query);
    await assertBranch(db, s.userId, q.branchId);

    const row = await db
      .selectFrom("sales.invoice")
      .select("id")
      .where("number", "=", q.number.trim())
      .where("branch_id", "=", q.branchId)
      .executeTakeFirst();
    if (!row) throw new InvoiceError("invoice_not_found", "فاکتوری با این شماره پیدا نشد", 404);

    const inv = await invoices.byId(row.id);
    if (!inv) throw new InvoiceError("invoice_not_found", "فاکتور یافت نشد", 404);
    return {
      ...invoiceToJson(inv),
      receivedAmount: serializeMoney(await invoices.paidSoFar(row.id)),
    };
  });

  app.get("/invoices/:id", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const inv = await invoices.byId(id);
    if (!inv) throw new InvoiceError("invoice_not_found", "فاکتور یافت نشد", 404);
    await assertBranch(db, s.userId, inv.branchId);
    return {
      ...invoiceToJson(inv),
      receivedAmount: serializeMoney(await invoices.paidSoFar(id)),
    };
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
    }, (trx, line) => markdownGate(trx, invoices, s, {
      variationId: line.variationId, qty: line.qty, discount: line.discountAmount,
      settingPrice: line.unitPrice, listPrice: line.listPrice,
    }));
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
    await assertInvoiceInScope(db, s.userId, id, invoices);
    await requireForSession(db, s, "sale.create");

    // سنجش مقدار **پس از** دامنه و مجوز: کاربری که به این فاکتور
    // دسترسی ندارد باید ۴۰۳ بگیرد، نه ۴۰۰ — وگرنه پاسخ خطا به ترتیبِ
    // ورودی وابسته می‌شود و با بقیه مسیرها یکدست نیست.
    if (Number(body.qty) <= 0) {
      throw new InvoiceError("bad_qty", "تعداد باید بزرگ‌تر از صفر باشد؛ برای حذف قلم از مسیر حذف استفاده کنید.", 400);
    }

    return invoiceToJson(
      await invoices.setLineQty({ invoiceId: id, lineId, qty: body.qty, actorId: s.userId }),
    );
  });

  /**
   * تخفیف روی سطری که همین حالا در سبد است.
   *
   * تا امروز تخفیف فقط در لحظه **افزودن** قلم تنظیم می‌شد، پس
   * صندوق‌داری که کالا را اسکن کرده و بعد می‌خواهد تخفیف بدهد تنها
   * یک راه داشت: حذف سطر و افزودن دوباره‌اش. همان راهی که مهاجرت ۰۱۵
   * برای تغییر تعداد ردش کرد، و به همان دلیل — افزودن دوباره قیمت را
   * از `catalog.price` دوباره می‌خواند و Snapshot لحظه فروش را
   * می‌بازد.
   *
   * دروازه‌اش **همان** `assertMarkdownAllowed` مسیر افزودن قلم است.
   * قیمت دستی از این مسیر عوض نمی‌شود؛ آن هنوز فقط هنگام افزودن قلم
   * ممکن است، چون تغییر قیمت روی سطر موجود یعنی همان بازقیمت‌گذاری.
   */
  app.patch("/invoices/:id/lines/:lineId/discount", async (req) => {
    const s = session(req);
    const { id, lineId } = z.object({ id: uuid, lineId: uuid }).parse(req.params);
    const body = setLineDiscountBody.parse(req.body);
    await assertInvoiceInScope(db, s.userId, id, invoices);
    await requireForSession(db, s, "sale.create");

    return invoiceToJson(
      await invoices.setLineDiscount({
        invoiceId: id,
        lineId,
        discountAmount: body.discountAmount,
        actorId: s.userId,
        ...(body.discountReason === undefined ? {} : { discountReason: body.discountReason }),
      }, (trx, line) => markdownGate(trx, invoices, s, {
        variationId: line.variationId,
        qty: line.qty,
        discount: parseMoney(body.discountAmount),
        effectivePrice: line.unitPrice,
        listPrice: line.listPrice,
      })),
    );
  });

  /**
   * قیمت دستی روی سطری که همین حالا در سبد است — «مثل دشت».
   *
   * تا امروز قیمت دستی فقط در لحظه **افزودن** قلم ممکن بود، و صندوق
   * از آن مسیر استفاده نمی‌کرد: صندوق‌دار اسکن می‌کرد و بعد راهی
   * نداشت جز حذف سطر و ثبت دوباره‌اش. آن راه قیمت فهرست را از
   * `catalog.price` **دوباره** می‌خواند، پس حراجِ وسط شیفت، عددی را
   * که سقف تخفیف از آن سنجیده می‌شود بی‌صدا عوض می‌کرد.
   *
   * دروازه همان `assertMarkdownAllowed` است — هیچ منطق تازه‌ای اینجا
   * نیست. `settingPrice` یعنی «الان دارد قیمت نوشته می‌شود»، پس هم
   * `sale.price_override` سنجیده می‌شود و هم سقف کاهش کل؛ تخفیفِ
   * ثبت‌شده سطر هم در همان عدد می‌آید، وگرنه ترکیبِ تخفیف مجاز و
   * قیمت پایین‌تر از سقف رد می‌شد.
   */
  app.patch("/invoices/:id/lines/:lineId/price", async (req) => {
    const s = session(req);
    const { id, lineId } = z.object({ id: uuid, lineId: uuid }).parse(req.params);
    const body = setLinePriceBody.parse(req.body);
    await assertInvoiceInScope(db, s.userId, id, invoices);
    await requireForSession(db, s, "sale.create");

    return invoiceToJson(
      await invoices.setLinePrice({
        invoiceId: id,
        lineId,
        unitPrice: parseMoney(body.unitPrice),
        actorId: s.userId,
        ...(body.priceOverrideReason === undefined
          ? {}
          : { priceOverrideReason: body.priceOverrideReason }),
      }, (trx, line) => markdownGate(trx, invoices, s, {
        variationId: line.variationId,
        qty: line.qty,
        discount: line.discountAmount,
        settingPrice: parseMoney(body.unitPrice),
        at: line.occurredAt,
        listPrice: line.listPrice,
      })),
    );
  });

  /**
   * اسکن یک بارکد.
   *
   * تفاوتش با `POST /lines` در یک جمله: این مسیر می‌داند اسکنر پشتش
   * است، پس اسکن دوباره همان کالا تعداد همان سطر را بالا می‌برد
   * به‌جای اینکه سطر دوم بسازد. `POST /lines` عمداً دست‌نخورده مانده.
   *
   * `Idempotency-Key` **اختیاری** است و باید برای هر کشیدن اسکنر
   * تازه باشد: دو بار اسکن عمدی یعنی دو عدد. کلید فقط برای این است
   * که Retry شبکه، عدد سوم نسازد.
   */
  /**
   * چسباندن مشتری به سبد — **اختیاری**، با شماره موبایل.
   *
   * تصمیم مالک: پرسیدن شماره پای صندوق اجباری نیست. فروش ناشناس
   * کارِ عادی است و این مسیر فقط وقتی صدا زده می‌شود که مشتری شماره
   * داده باشد.
   *
   * فایده‌اش دو چیز است: سابقه خرید مشتری، و دیده‌شدن همان خرید در
   * حساب کاربری سایت (`GET /web/instore-purchases`).
   *
   * مجوزش `sale.create` است، نه `customer.manage`: صندوق‌دار باید
   * بتواند شماره بگیرد بدون اینکه بتواند پرونده مشتری را ویرایش کند.
   */
  app.patch("/invoices/:id/customer", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await assertInvoiceInScope(db, s.userId, id, invoices);
    await requireForSession(db, s, "sale.create");

    const body = z
      .object({
        mobile: z.string().trim().min(1).max(20),
        fullName: z.string().trim().max(120).optional(),
      })
      .parse(req.body);

    return invoiceToJson(
      await invoices.attachCustomer({
        invoiceId: id,
        mobile: body.mobile,
        ...(body.fullName === undefined ? {} : { fullName: body.fullName }),
        actorId: s.userId,
      }),
    );
  });

  /**
   * گیرنده — وقتی خرید برای دیگری است.
   *
   * ⚠️ گیرنده **یک مشتری است**، نه چند ستون روی فاکتور.
   *
   * وسوسه‌اش `recipientName` و `recipientMobile` بود. ولی گیرنده خودش
   * یک مشتری است: همان کسی که پارسال برایش خریدند، امسال ممکن است
   * خودش بیاید. با ستون روی فاکتور آن دو هرگز یکی نمی‌شدند و
   * اندازه‌هایی که برای هدیه ثبت شده بود، در پرونده خودش پیدا
   * نمی‌شد.
   *
   * پس شماره از همان `sales.normalize_mobile` می‌گذرد و شماره تکراری
   * مشتری دوم نمی‌سازد — همان قاعده‌ای که کل پرونده مشتری بر آن است.
   *
   * مجوزش `sale.create` است مثل مسیر مشتری: صندوق‌دار باید بتواند
   * گیرنده را ثبت کند بدون اینکه پرونده مشتری را ویرایش کند.
   */
  app.patch("/invoices/:id/recipient", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await assertInvoiceInScope(db, s.userId, id, invoices);
    await requireForSession(db, s, "sale.create");

    const body = z
      .object({
        mobile: z.string().trim().min(1).max(20).nullable(),
        fullName: z.string().trim().max(120).optional(),
      })
      .parse(req.body);

    return invoiceToJson(
      await invoices.setRecipient({
        invoiceId: id,
        mobile: body.mobile,
        ...(body.fullName === undefined ? {} : { fullName: body.fullName }),
        actorId: s.userId,
      }),
    );
  });

  /**
   * گزینه‌های بسته‌بندی هدیه.
   *
   * از `sales.gift_option` می‌آید نه از فهرستی در کد: فروشگاه امسال
   * سه رنگ کاغذ دارد و سال بعد پنج تا.
   */
  app.get("/gift-options", async (req) => {
    session(req);
    const r = await db
      .selectFrom("sales.gift_option")
      .select(["code", "kind", "label", "price", "sort_order"])
      .where("is_active", "=", true)
      .orderBy("sort_order")
      .execute();
    return {
      options: r.map((x) => ({
        code: x.code,
        kind: x.kind,
        label: x.label,
        // پول در JSON رشته است — حتی وقتی صفر است.
        price: x.price,
      })),
    };
  });

  /**
   * بسته‌بندی هدیه یک فاکتور.
   *
   * `PUT` است و `Idempotency-Key` نمی‌خواهد: مطلق است نه افزایشی، و
   * ارسال دوباره همان نتیجه را می‌دهد. بدنه خالی یعنی «هدیه نیست» و
   * سطر را پاک می‌کند.
   *
   * ⚠️ فقط روی فاکتور **باز**. برگه هدیه بخشی از همان سند است؛
   * تغییرش پس از تحویل یعنی آنچه مشتری برد با آنچه در سیستم است فرق
   * کند. سنجشش در دیتابیس است، نه اینجا.
   */
  app.put("/invoices/:id/gift", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await assertInvoiceInScope(db, s.userId, id, invoices);
    await requireForSession(db, s, "sale.create");

    const body = z
      .object({
        isGift: z.boolean().default(true),
        wrapCode: z.string().trim().max(40).nullable().optional(),
        colorCode: z.string().trim().max(40).nullable().optional(),
        flowerCode: z.string().trim().max(40).nullable().optional(),
        note: z.string().max(500).nullable().optional(),
        hidePrices: z.boolean().optional(),
      })
      .parse(req.body ?? {});

    // ⚠️ نویسه کنترلی **رد** می‌شود، نه بی‌صدا پاک.
    //
    // یادداشت روی کارت هدیه چاپ می‌شود و ورودی کاربر است. پاک‌کردن
    // خاموش یعنی متنی چاپ شود که کاربر ننوشته؛ همان قاعده‌ای که
    // بقیه مسیرها دارند و تعریفش یک جاست: `lib/text.ts`.
    if (typeof body.note === "string" && hasControlChars(body.note)) {
      throw new InvoiceError("bad_note", `یادداشت ${CONTROL_CHARS_MESSAGE}`, 400);
    }

    return invoiceToJson(
      await invoices.setGift({
        invoiceId: id,
        isGift: body.isGift,
        wrapCode: body.wrapCode ?? null,
        colorCode: body.colorCode ?? null,
        flowerCode: body.flowerCode ?? null,
        note: body.note ?? null,
        hidePrices: body.hidePrices ?? true,
        actorId: s.userId,
      }),
    );
  });

  app.post("/invoices/:id/scan", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = scanBody.parse(req.body ?? {});
    await assertInvoiceInScope(db, s.userId, id, invoices);
    await requireForSession(db, s, "sale.create");

    // مثل مسیر تغییر تعداد: اول «اجازه داری؟»، بعد «ورودی درست است؟».
    if (Number(body.qty) <= 0) {
      throw new InvoiceError("bad_qty", "تعداد باید بزرگ‌تر از صفر باشد", 400);
    }

    const out = await runOnce<string>(db, {
      key: idempotencyKey(req),
      source: "api.invoice.scan",
      payload: {
        actorId: s.userId,
        invoiceId: id,
        variationId: body.variationId ?? null,
        barcode: body.barcode ?? null,
        qty: body.qty,
      },
      run: async (trx) => {
        await invoices.scanIn(trx, {
          invoiceId: id,
          qty: body.qty,
          actorId: s.userId,
          ...(body.variationId === undefined ? {} : { variationId: body.variationId }),
          ...(body.barcode === undefined ? {} : { barcode: body.barcode }),
        });
        return { value: id, ref: id };
      },
      replay: async (ref) => ref,
    });

    // پاسخ عمداً فقط فاکتور و replayed است. «کدام سطر عوض شد» و «ادغام
    // شد یا نه» را در مسیر Replay نمی‌شود بدون حدس بازسازی کرد، و
    // میدانی که در Replay حدسی باشد بدتر از نبودنش است.
    const inv = await invoices.byId(id);
    if (!inv) throw new InvoiceError("invoice_not_found", "فاکتور یافت نشد", 404);
    return { invoice: invoiceToJson(inv), replayed: out.replayed };
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

  app.get("/invoices/:id/draft-payments", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await assertInvoiceInScope(db, s.userId, id, invoices);
    await requireForSession(db, s, "invoice.cancel");
    const inv = await invoices.byId(id);
    if (inv?.status !== "draft") throw new InvoiceError("invoice_not_draft", "فاکتور پیش‌نویس نیست.");
    return { payments: (await invoices.draftPayments(id)).filter((p) => !["failed", "reversed"].includes(p.status)) };
  });
  app.get("/invoices/:id/payments", async (req) => {
    const s=session(req), {id}=z.object({id:uuid}).parse(req.params);
    await requireForSession(db,s,"sale.create");
    await assertInvoiceInScope(db,s.userId,id,invoices);
    const own=await db.selectFrom("sales.invoice").select("created_by").where("id","=",id).executeTakeFirst();
    if(own?.created_by!==s.userId) throw new InvoiceError("payment_forbidden","فقط پرداخت‌های فاکتور خودتان را می‌بینید.",403);
    return {payments:(await invoices.draftPayments(id)).filter(p=>p.status==="succeeded" && p.direction==="in")
      .map(p=>({id:p.id,name:p.name,amount:p.amount}))};
  });

  app.post("/invoices/:id/refund-draft", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({
      reason: z.string().trim().min(3).max(200),
      confirmed: z.literal(true),
      paymentIds: z.array(uuid).min(1).max(100),
      refundReference: z.string().trim().min(1).max(120).optional(),
    }).parse(req.body);
    await assertInvoiceInScope(db, s.userId, id, invoices);
    await requireForSession(db, s, "invoice.cancel");
    const key = idempotencyKey(req);
    if (!key) throw new InvoiceError("idempotency_required", "شناسه یکتای درخواست لازم است.", 400);
    const out = await runOnce<string>(db, {
      key, source: "api.invoice.refund_draft", payload: { actorId: s.userId, invoiceId: id, ...body },
      run: async (trx) => {
        const value = await invoices.refundDraftIn(trx, { invoiceId: id, actorId: s.userId,
          reason: body.reason, paymentIds: body.paymentIds,
          authorize: async (amount) => { await requireForSession(trx, s, "invoice.cancel", { amount }); },
          ...(body.refundReference === undefined ? {} : { refundReference: body.refundReference }) });
        return { value, ref: value };
      },
      replay: async (ref) => ref,
    });
    const inv = await invoices.byId(out.value);
    if (!inv) throw new InvoiceError("invoice_not_found", "فاکتور یافت نشد", 404);
    return { invoice: invoiceToJson(inv), replayed: out.replayed };
  });

  app.post("/invoices/:id/payments", async (req, reply) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = paymentBody.parse(req.body);
    await assertInvoiceInScope(db, s.userId, id, invoices);
    await requireForSession(db, s, "sale.create");

    // Replay واقعی، نه فقط جلوگیری از درج دوم.
    //
    // پیش از این، کلید فقط در `client_event_id` می‌نشست و قید یکتایی
    // پستگرس درج دوم را می‌شکست — یعنی پول دوباره ثبت نمی‌شد (خوب) ولی
    // کاربر خطای سرور می‌دید (بد). دفاعی که شبیه خرابی گزارش شود، در
    // عمل خاموش است.
    //
    // هر دو لایه سر جایشان می‌مانند: Inbox پاسخ درست را برمی‌گرداند و
    // قید یکتایی آخرین سد است.
    const method = await db.selectFrom("treasury.payment_method").select("kind")
      .where("code", "=", body.methodCode).executeTakeFirst();
    if (method?.kind === "credit") {
      await requireForSession(db, s, "sale.credit", { amount: parseMoney(body.amount) });
    }
    const key = idempotencyKey(req);
    const out = await runOnce<string>(db, {
      key,
      source: "api.invoice.payment",
      payload: {
        actorId: s.userId,
        invoiceId: id,
        methodCode: body.methodCode,
        amount: body.amount,
        refNo: body.refNo ?? null,
        accountId: body.accountId ?? null,
      },
      run: async (trx) => {
        const paymentId = await invoices.addPaymentIn(trx, {
          invoiceId: id,
          methodCode: body.methodCode,
          amount: parseMoney(body.amount),
          actorId: s.userId,
          ...(body.refNo === undefined ? {} : { refNo: body.refNo }),
          ...(body.accountId === undefined ? {} : { accountId: body.accountId }),
          ...(key === undefined ? {} : { clientEventId: key }),
        });
        return { value: paymentId, ref: paymentId };
      },
      replay: async (ref) => ref,
    });

    // نمای فعلی سرور، نه آنچه کلاینت حساب کرده.
    //
    // `invoice.paidAmount` روی پیش‌نویس عمداً صفر است: آن ستون را
    // `finalize_invoice` می‌نویسد. «چقدر تا حالا گرفته‌ایم» عدد دیگری
    // است و از `paidSoFar` می‌آید — جمع پرداخت‌های **واقعاً موفق**؛
    // «نامشخص» و «در انتظار» پول شمرده نمی‌شوند.
    //
    // دو نام جدا، چون دو چیز جدا هستند. اگر یکی می‌شدند، صندوق روی
    // پیش‌نویس عدد اشتباه نشان می‌داد یا فاکتور نهایی عدد دوباره
    // حساب‌شده.
    const inv = await invoices.byId(id);
    if (!inv) throw new InvoiceError("invoice_not_found", "فاکتور یافت نشد", 404);
    const received = await invoices.paidSoFar(id);

    return reply.code(out.replayed ? 200 : 201).send({
      paymentId: out.value,
      replayed: out.replayed,
      receivedAmount: serializeMoney(received),
      invoice: invoiceToJson(inv),
    });
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
