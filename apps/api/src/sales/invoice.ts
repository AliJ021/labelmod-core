/**
 * سبد و فاکتور فروش.
 *
 * دو قاعده‌ای که کل این فایل رویشان بنا شده:
 *
 * **۱. قیمت از دیتابیس می‌آید، مگر با مجوز صریح.** تبلت صندوق معمولاً
 * فقط می‌گوید «این کالا، این تعداد». اگر `unit_price` را همیشه کلاینت
 * می‌فرستاد، یک POS دستکاری‌شده — یا یک درخواست مستقیم — می‌توانست هر
 * چیزی را به هر قیمتی بفروشد.
 *
 * مالک «قیمت دستی مثل دشت» خواسته، پس این قاعده مطلق نماند — ولی
 * **مجوزدار** شد و دو دروازه دارد:
 *
 *   `sale.price_override`   اجازه تایپ‌کردن قیمت
 *   `sale.discount[_high]`  سقف **کاهش کل**، چه از راه تخفیف چه از
 *                           راه قیمت دستی
 *
 * دروازه دوم حیاتی است: بدون آن، صندوق‌داری با سقف تخفیف ۱۰٪ کافی بود
 * به‌جای تخفیف، قیمت را نصف بنویسد و کل نردبان بی‌معنا شود.
 *
 * و قیمت فهرست در `list_price` می‌نشیند، نه در تخفیف — چون مالک صریح
 * گفت «یک وقت داخل فاکتور فروش دوتا قیمت نخورد». فاکتور یک عدد نشان
 * می‌دهد؛ `list_price` برای حسابرسی است، نه برای چاپ.
 *
 * **۲. اثر مالی در دیتابیس است، نه اینجا.** خروج کالا، بهای تمام‌شده،
 * شماره فاکتور و دوره ثبت همه در `sales.finalize_invoice`‌اند. این لایه
 * مجوز می‌گیرد، ورودی را می‌سنجد، و ترجمه می‌کند.
 */
import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { Db } from "../db/client.ts";
import type { Database } from "../db/types.ts";
import { parseMoney, serializeMoney } from "../lib/money.ts";
import { setActor } from "../lib/idempotency.ts";

export class InvoiceError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode = 409) {
    super(message);
    this.name = "InvoiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface InvoiceLine {
  id: string;
  lineNo: number;
  variationId: string;
  sku: string;
  productName: string;
  qty: string;
  unitPrice: bigint;
  discountAmount: bigint;
  netAmount: bigint;
  discountReason: string | null;
  /**
   * قیمت فهرست — **فقط** وقتی قیمت دستی خورده باشد، وگرنه null.
   *
   * فاکتور چاپی این را نشان نمی‌دهد؛ `unitPrice` تنها قیمتی است که
   * مشتری می‌بیند. این میدان برای صفحه حسابرسی و گزارش «چقدر زیر
   * قیمت فروختیم» است.
   */
  listPrice: bigint | null;
  priceOverrideReason: string | null;
}

export interface Invoice {
  id: string;
  number: string | null;
  branchId: string;
  warehouseId: string;
  shiftId: string | null;
  customerId: string | null;
  channel: string;
  status: string;
  grossAmount: bigint;
  discountAmount: bigint;
  netAmount: bigint;
  taxAmount: bigint;
  shippingAmount: bigint;
  payableAmount: bigint;
  paidAmount: bigint;
  occurredAt: Date;
  lines: InvoiceLine[];
}

export interface AddLineInput {
  invoiceId: string;
  /** یکی از این دو — بارکد راه صندوق است، شناسه راه سایت. */
  variationId?: string | undefined;
  barcode?: string | undefined;
  qty: string;
  discountAmount?: bigint | undefined;
  discountReason?: string | undefined;
  /** قیمت دستی. اگر نیاید، قیمت از `catalog.price` خوانده می‌شود. */
  unitPrice?: bigint | undefined;
  priceOverrideReason?: string | undefined;
  actorId: string;
}

/**
 * هرچه بتواند کوئری اجرا کند — Pool یا تراکنش باز.
 *
 * چند متد این کلاس باید هم از بیرون صدا زده شوند و هم **داخل تراکنش
 * فراخوان**. الگویش از `addPaymentIn` می‌آید و دلیلش همان است: اثر و
 * درج Inbox باید در یک تراکنش باشند، پس خواندن‌های میانی هم باید همان
 * تراکنش را ببینند — وگرنه کدی که داخل تراکنش می‌نویسد، بیرونش
 * می‌خواند و چیزی را می‌بیند که هنوز Commit نشده یا عوض شده.
 */
export type Executor = Db | Transaction<Database>;

/** سهم تخفیف از مبلغ ناخالص سطر، برای سنجش سقف نقش. */
export interface DiscountCheck {
  percent: number;
  grossAmount: bigint;
}

export class InvoiceService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async byId(invoiceId: string, ex: Executor = this.#db): Promise<Invoice | null> {
    const inv = await ex
      .selectFrom("sales.invoice")
      .selectAll()
      .where("id", "=", invoiceId)
      .executeTakeFirst();
    if (!inv) return null;

    const lines = await ex
      .selectFrom("sales.invoice_line as l")
      .innerJoin("catalog.variation as v", "v.id", "l.variation_id")
      .innerJoin("catalog.product as p", "p.id", "v.product_id")
      .select([
        "l.id",
        "l.line_no",
        "l.variation_id",
        "l.qty",
        "l.unit_price",
        "l.discount_amount",
        "l.net_amount",
        "l.discount_reason",
        "l.list_price",
        "l.price_override_reason",
        "v.sku",
        "p.name_internal",
      ])
      .where("l.invoice_id", "=", invoiceId)
      .orderBy("l.line_no")
      .execute();

    return {
      id: inv.id,
      number: inv.number,
      branchId: inv.branch_id,
      warehouseId: inv.warehouse_id,
      shiftId: inv.shift_id,
      customerId: inv.customer_id,
      channel: inv.channel,
      status: inv.status,
      grossAmount: parseMoney(inv.gross_amount),
      discountAmount: parseMoney(inv.discount_amount),
      netAmount: parseMoney(inv.net_amount),
      taxAmount: parseMoney(inv.tax_amount),
      shippingAmount: parseMoney(inv.shipping_amount),
      payableAmount: parseMoney(inv.payable_amount),
      paidAmount: parseMoney(inv.paid_amount),
      occurredAt: inv.occurred_at,
      lines: lines.map((l) => ({
        id: l.id,
        lineNo: l.line_no,
        variationId: l.variation_id,
        sku: l.sku,
        productName: l.name_internal,
        qty: l.qty,
        unitPrice: parseMoney(l.unit_price),
        discountAmount: parseMoney(l.discount_amount),
        listPrice: l.list_price === null ? null : parseMoney(l.list_price),
        priceOverrideReason: l.price_override_reason,
        netAmount: parseMoney(l.net_amount),
        discountReason: l.discount_reason,
      })),
    };
  }

  async createDraft(input: {
    branchId: string;
    warehouseId: string;
    shiftId?: string | undefined;
    customerId?: string | undefined;
    channel: string;
    actorId: string;
  }): Promise<Invoice> {
    const id = await this.#db.transaction().execute((trx) => this.createDraftIn(trx, input));

    const inv = await this.byId(id);
    if (!inv) throw new InvoiceError("invoice_not_found", "فاکتور ساخته نشد", 500);
    return inv;
  }

  /**
   * همان ساخت پیش‌نویس، ولی داخل تراکنشی که فراخوان می‌دهد.
   *
   * لازم است چون `runOnce` باید درج Inbox و اثر را در **یک** تراکنش
   * انجام دهد؛ اگر این متد تراکنش خودش را باز کند، دو Commit جدا
   * می‌شود و همان چیزی که Idempotency می‌خواست جلویش را بگیرد، از
   * میانشان رد می‌شود.
   */
  async createDraftIn(
    trx: Transaction<Database>,
    input: {
      branchId: string;
      warehouseId: string;
      shiftId?: string | undefined;
      customerId?: string | undefined;
      channel: string;
      actorId: string;
    },
  ): Promise<string> {
    {
      await setActor(trx, input.actorId);
      const row = await trx
        .insertInto("sales.invoice")
        .values({
          branch_id: input.branchId,
          warehouse_id: input.warehouseId,
          shift_id: input.shiftId ?? null,
          customer_id: input.customerId ?? null,
          channel: input.channel,
          status: "draft",
          number: null,
          gross_amount: "0",
          discount_amount: "0",
          net_amount: "0",
          tax_amount: "0",
          shipping_amount: "0",
          payable_amount: "0",
          paid_amount: "0",
          cogs_amount: "0",
          client_event_id: null,
          finalized_at: null,
          created_by: input.actorId,
          note: null,
          posting_batch_id: null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      return row.id;
    }
  }

  /**
   * قیمت جاری کالا از `catalog.price`.
   *
   * آخرین قیمت معتبر در همان لحظه. اگر کالا قیمت ندارد، فروش رد
   * می‌شود — قیمت صفر یک تصمیم است، نه یک پیش‌فرض.
   */
  async currentPrice(
    variationId: string,
    at: Date = new Date(),
    ex: Executor = this.#db,
  ): Promise<bigint> {
    const row = await ex
      .selectFrom("catalog.price")
      .select("amount")
      .where("variation_id", "=", variationId)
      .where("price_list", "=", "default")
      .where("valid_from", "<=", at)
      .where((eb) => eb.or([eb("valid_to", "is", null), eb("valid_to", ">", at)]))
      .orderBy("valid_from", "desc")
      .executeTakeFirst();

    if (!row) {
      throw new InvoiceError(
        "no_price",
        "برای این کالا قیمت معتبری ثبت نشده است. تا تعیین قیمت، فروش ممکن نیست.",
        422,
      );
    }
    return parseMoney(row.amount);
  }

  /** شناسه تنوع از بارکد — مسیر اسکنر صندوق. */
  async resolveVariation(
    input: {
      variationId?: string | undefined;
      barcode?: string | undefined;
    },
    ex: Executor = this.#db,
  ): Promise<string> {
    if (input.variationId) {
      const v = await ex
        .selectFrom("catalog.variation")
        .select(["id", "status"])
        .where("id", "=", input.variationId)
        .executeTakeFirst();
      if (!v) throw new InvoiceError("variation_not_found", "کالا یافت نشد", 404);
      if (v.status !== "active") {
        throw new InvoiceError("variation_inactive", "این کالا غیرفعال است و فروخته نمی‌شود");
      }
      return v.id;
    }

    if (!input.barcode) {
      throw new InvoiceError("no_variation", "کالا مشخص نشده است", 400);
    }
    const v = await ex
      .selectFrom("catalog.variation")
      .select(["id", "status"])
      .where("barcode", "=", input.barcode)
      .executeTakeFirst();
    if (!v) throw new InvoiceError("variation_not_found", "بارکد شناخته نشد", 404);
    if (v.status !== "active") {
      throw new InvoiceError("variation_inactive", "این کالا غیرفعال است و فروخته نمی‌شود");
    }
    return v.id;
  }

  /**
   * **کاهش کل** سطر نسبت به قیمت فهرست — پیش از افزودن، تا مجوز با
   * عدد واقعی سنجیده شود.
   *
   * جدا از `addLine` است چون مسیر HTTP باید **پیش از** هر نوشتنی مجوز
   * بگیرد؛ نه اینکه بنویسد و بعد بفهمد اجازه نداشته.
   *
   * «کاهش کل» یعنی تخفیف **به‌علاوه** تفاوت قیمت دستی. این نکته کل
   * امنیت این مسیر است: اگر فقط تخفیف سنجیده می‌شد، صندوق‌دار به‌جای
   * تخفیفِ بالای سقف، قیمت را کمتر می‌نوشت و همان کار را بی‌مجوز
   * می‌کرد.
   *
   * قیمت بالاتر از فهرست کاهش نیست: درصد صفر می‌شود و نردبان تخفیف
   * اصلاً فعال نمی‌شود. (دروازه `sale.price_override` جداگانه سنجیده
   * شده است.)
   */
  async markdownCheck(
    variationId: string,
    qty: string,
    discountAmount: bigint,
    unitPrice?: bigint | undefined,
  ): Promise<DiscountCheck> {
    const list = await this.currentPrice(variationId);
    const listGross = await this.grossOf(list, qty);
    const soldGross = unitPrice === undefined ? listGross : await this.grossOf(unitPrice, qty);

    if (discountAmount > soldGross) {
      throw new InvoiceError(
        "discount_exceeds_line",
        "تخفیف از مبلغ خودِ قلم بیشتر است",
        422,
      );
    }
    if (listGross <= 0n) return { percent: 0, grossAmount: listGross };

    const markdown = listGross - (soldGross - discountAmount);
    if (markdown <= 0n) return { percent: 0, grossAmount: listGross };

    return {
      percent: Number((markdown * 10000n) / listGross) / 100,
      grossAmount: markdown,
    };
  }

  /**
   * مبلغ ناخالص سطر — **در SQL**، نه در TypeScript.
   *
   * `qty` از نوع NUMERIC(14,3) است و می‌تواند اعشار داشته باشد. اگر
   * اینجا با تقسیم صحیح bigint حساب می‌شد، نتیجه با آنچه دیتابیس در
   * `sum(qty * unit_price)` می‌سازد یکی نمی‌ماند:
   *
   *   قیمت ۱۰۰۱ ریال، تعداد ۱٫۵ →  SQL ۱۵۰۲   TypeScript ۱۵۰۱
   *
   * یک ریال، ولی جمع فاکتور از جمع سطرها جدا می‌افتد و سند نامتوازن
   * می‌شود. یک مرجع، یک گرد کردن — قاعده «round() صریح» در
   * .claude/rules/sql.md.
   */
  private async grossOf(
    unitPrice: bigint,
    qty: string,
    ex: Executor = this.#db,
  ): Promise<bigint> {
    const r = await sql<{ gross: string }>`
      SELECT round(${qty}::numeric * ${serializeMoney(unitPrice)}::numeric) AS gross
    `.execute(ex);
    return parseMoney(r.rows[0]?.gross ?? "0");
  }

  async addLine(input: AddLineInput): Promise<Invoice> {
    await this.#db.transaction().execute((trx) => this.addLineIn(trx, input));
    return (await this.byId(input.invoiceId)) as Invoice;
  }

  /**
   * همان افزودن قلم، داخل تراکنش فراخوان.
   *
   * الگویش از `addPaymentIn` می‌آید و دلیلش همان است: مسیر سفارش
   * سایت باید کل فاکتور — پیش‌نویس، اقلام، پرداخت، نهایی‌سازی — را با
   * درج Inbox در **یک** تراکنش انجام دهد. اگر هر قلم تراکنش خودش را
   * باز کند، خرابی میانه یک پیش‌نویس نیمه‌کاره جا می‌گذارد که کلید
   * Idempotency هم ندارد، پس تلاش دوباره پیش‌نویس دوم می‌سازد.
   *
   * خواندن‌ها هم روی همان تراکنش‌اند، نه روی Pool: کدی که داخل
   * تراکنش می‌نویسد و بیرونش می‌خواند، چیزی را می‌بیند که هنوز
   * Commit نشده.
   */
  async addLineIn(trx: Transaction<Database>, input: AddLineInput): Promise<void> {
    const inv = await this.requireDraft(input.invoiceId, trx);
    const variationId = await this.resolveVariation(input, trx);
    const listPrice = await this.currentPrice(variationId, inv.occurredAt, trx);
    const discount = input.discountAmount ?? 0n;

    const qty = Number(input.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new InvoiceError("bad_qty", "تعداد باید بزرگ‌تر از صفر باشد", 400);
    }

    // قیمت صفر یا منفی از هیچ مسیری. ادعای پایدار CI هم همین را
    // می‌سنجد، ولی خطای اینجا برای کاربر خوانا است نه یک نقض قید.
    if (input.unitPrice !== undefined && input.unitPrice <= 0n) {
      throw new InvoiceError("bad_price", "قیمت باید بزرگ‌تر از صفر باشد", 422);
    }

    // قیمتِ دستیِ برابر با فهرست، بازنویسی نیست. `list_price` را
    // NULL نگه می‌داریم تا «آیا این سطر دستکاری شده؟» یک تست ساده
    // بماند و گزارش‌ها با سطرهای بی‌تفاوت شلوغ نشوند.
    const overridden = input.unitPrice !== undefined && input.unitPrice !== listPrice;
    const price = overridden ? (input.unitPrice as bigint) : listPrice;

    const gross = await this.grossOf(price, input.qty, trx);
    if (discount > gross) {
      throw new InvoiceError("discount_exceeds_line", "تخفیف از مبلغ خودِ قلم بیشتر است", 422);
    }

    {
      await setActor(trx, input.actorId);
      const nextNo = await nextLineNo(trx, input.invoiceId);
      await trx
        .insertInto("sales.invoice_line")
        .values({
          invoice_id: input.invoiceId,
          line_no: nextNo,
          variation_id: variationId,
          qty: input.qty,
          unit_price: serializeMoney(price),
          discount_amount: serializeMoney(discount),
          tax_amount: "0",
          net_amount: serializeMoney(gross - discount),
          unit_cost: "0",
          cogs_amount: "0",
          returned_qty: "0",
          discount_reason: input.discountReason ?? null,
          list_price: overridden ? serializeMoney(listPrice) : null,
          price_override_reason: overridden ? (input.priceOverrideReason ?? null) : null,
        })
        .execute();

      // ردّ حسابرسی فقط وقتی واقعاً قیمتی دست خورده. سطر عادی سبد
      // رویداد حسابرسی نمی‌سازد — وگرنه لاگ با هر اسکن بارکد پر
      // می‌شود و همان چیزی که باید دیده شود، گم می‌شود.
      if (overridden) {
        await sql`
          SELECT platform.audit('sale.price_override', 'invoice_line', ${input.invoiceId},
            ${JSON.stringify({
              variationId,
              qty: input.qty,
              listPrice: serializeMoney(listPrice),
              unitPrice: serializeMoney(price),
            })}::jsonb,
            ${input.actorId}::uuid, ${input.priceOverrideReason ?? null})
        `.execute(trx);
      }
      await refreshTotals(trx, input.invoiceId);
    }
  }

  /**
   * اسکن بارکد — همان کالا در سبد، یک سطر با تعداد بیشتر.
   *
   * `addLine` عمداً دست‌نخورده می‌ماند و هرگز ادغام نمی‌کند: مسیر سایت
   * و مسیر تخفیف‌دار به سطر مستقل نیاز دارند. ادغام رفتار **اسکنر**
   * است، نه رفتار افزودن قلم.
   *
   * تصمیم ادغام در سرور گرفته می‌شود، زیر قفل فاکتور. کلاینت
   * `variationId` را نمی‌داند و نباید بداند — فقط بارکدی که خوانده
   * است.
   *
   * «سطر سازگار» یعنی همان کالا **و** همان Snapshot: بدون تخفیف،
   * بدون قیمت دستی، بدون دلیل ثبت‌شده، و با همان `unit_price` که
   * قیمت‌گذاری امروز برای این فاکتور می‌دهد. آخری مهم است: اگر قیمتِ
   * حل‌شده با سطر موجود یکی نباشد، ادغام یعنی بازقیمت‌گذاری بی‌صدای
   * چیزی که مشتری قبلاً دیده.
   *
   * قیمت از همان مسیر `addLine` می‌آید — `currentPrice` با
   * `invoice.occurred_at` — نه یک منطق موازی. دو مرجع قیمت یعنی روزی
   * یکی از دیگری عقب می‌ماند.
   */
  async scanIn(
    trx: Transaction<Database>,
    input: {
      invoiceId: string;
      variationId?: string | undefined;
      barcode?: string | undefined;
      qty: string;
      actorId: string;
    },
  ): Promise<void> {
    const inv = await this.requireDraft(input.invoiceId);
    const variationId = await this.resolveVariation(input);
    const price = await this.currentPrice(variationId, inv.occurredAt);

    await setActor(trx, input.actorId);

    // قفل فاکتور **پیش از** یافتن سطر سازگار: بدون این، دو اسکن
    // هم‌زمان هر دو «سطری نیست» می‌دیدند و دو سطر می‌ساختند — یا هر
    // دو تعداد قدیمی را می‌خواندند و یک افزایش گم می‌شد.
    const locked = await sql<{ status: string }>`
      SELECT status FROM sales.invoice WHERE id = ${input.invoiceId}::uuid FOR UPDATE
    `.execute(trx);
    const status = locked.rows[0]?.status;
    if (!status) throw new InvoiceError("invoice_not_found", "فاکتور یافت نشد", 404);
    if (status !== "draft") {
      throw new InvoiceError(
        "invoice_not_draft",
        `فاکتور در وضعیت «${status}» است و دیگر تغییر نمی‌کند`,
      );
    }

    // اگر چند سطر سازگار باشد، کم‌ترین `line_no` انتخاب می‌شود —
    // ترتیب قطعی، بدون ادغام یا حذف سطرهای دیگر. سطر تکراری قبلی کار
    // کسی دیگر بوده و این مسیر آن را جمع نمی‌کند.
    const match = await sql<{ id: string }>`
      SELECT id FROM sales.invoice_line
       WHERE invoice_id = ${input.invoiceId}::uuid
         AND variation_id = ${variationId}::uuid
         AND discount_amount = 0
         AND list_price IS NULL
         AND discount_reason IS NULL
         AND price_override_reason IS NULL
         AND unit_price = ${serializeMoney(price)}::numeric
       ORDER BY line_no
       LIMIT 1
       FOR UPDATE
    `.execute(trx);

    const existing = match.rows[0]?.id;
    if (existing) {
      // جمع تعداد در SQL انجام می‌شود، نه در TypeScript.
      await sql`
        SELECT sales.set_line_qty(
          ${input.invoiceId}::uuid, ${existing}::uuid,
          (SELECT qty FROM sales.invoice_line WHERE id = ${existing}::uuid)
            + ${input.qty}::platform.qty)
      `.execute(trx);
      return;
    }

    const nextNo = await nextLineNo(trx, input.invoiceId);
    await trx
      .insertInto("sales.invoice_line")
      .values({
        invoice_id: input.invoiceId,
        line_no: nextNo,
        variation_id: variationId,
        qty: input.qty,
        unit_price: serializeMoney(price),
        discount_amount: "0",
        tax_amount: "0",
        // مبلغ سطر با round() صریح در SQL — همان قاعده‌ای که
        // `grossOf` برایش وجود دارد. تقسیم و ضرب در TypeScript با
        // جمع دیتابیس یکی درنمی‌آید.
        net_amount: sql<string>`round(${input.qty}::numeric * ${serializeMoney(price)}::numeric)`,
        unit_cost: "0",
        cogs_amount: "0",
        returned_qty: "0",
        discount_reason: null,
        list_price: null,
        price_override_reason: null,
      })
      .execute();

    await refreshTotals(trx, input.invoiceId);
  }

  /**
   * تخفیف روی سطری که همین حالا در سبد است.
   *
   * Snapshot قیمت دست نمی‌خورد — کل دلیل وجود این مسیر همین است.
   * تنها راه دیگر، حذف سطر و افزودن دوباره‌اش با تخفیف بود، و آن
   * قیمت را از `catalog.price` دوباره می‌خواند.
   *
   * سقف و مجوز اینجا **نیستند**: لایه مسیر با همان دروازه‌ای
   * می‌سنجدشان که افزودن قلم می‌سنجد. آنچه دیتابیس اجبار می‌کند
   * (تخفیف بیشتر از مبلغ قلم، و دلیل اجباری بالای آستانه) سر جایش
   * می‌ماند و این متد دورش نمی‌زند.
   */
  async setLineDiscount(input: {
    invoiceId: string;
    lineId: string;
    discountAmount: string;
    discountReason?: string | undefined;
    actorId: string;
  }): Promise<Invoice> {
    await this.requireDraft(input.invoiceId);
    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, input.actorId);
      await sql`SELECT sales.set_line_discount(
        ${input.invoiceId}::uuid, ${input.lineId}::uuid,
        ${input.discountAmount}::numeric, ${input.discountReason ?? null}::text)`
        .execute(trx);
    });
    return (await this.byId(input.invoiceId)) as Invoice;
  }

  async removeLine(invoiceId: string, lineId: string, actorId: string): Promise<Invoice> {
    await this.requireDraft(invoiceId);
    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, actorId);
      const deleted = await trx
        .deleteFrom("sales.invoice_line")
        .where("id", "=", lineId)
        .where("invoice_id", "=", invoiceId)
        .executeTakeFirst();
      if (!deleted.numDeletedRows) {
        throw new InvoiceError("line_not_found", "این قلم در فاکتور نیست", 404);
      }
      await refreshTotals(trx, invoiceId);
    });
    return (await this.byId(invoiceId)) as Invoice;
  }

  /**
   * تغییر تعداد یک قلم — بدون دست‌زدن به Snapshot قیمت.
   *
   * تنها راه دیگر، حذف سطر و افزودن دوباره‌اش بود؛ و آن مسیر قیمت را
   * از `catalog.price` دوباره می‌خواند. برای فاکتوری که قیمت لحظه
   * فروش را نگه می‌دارد، این یک اصلاح نیست — یک بازقیمت‌گذاری بی‌صدا
   * است.
   *
   * سنجش‌های اینجا **لایه اول**اند و فقط برای اینکه کاربر کد و پیام
   * دقیق بگیرد. لایه دومِ همین قواعد داخل `sales.set_line_qty` است و
   * زیر قفل فاکتور اجرا می‌شود — یعنی مسابقه‌ای که این خواندن‌ها
   * می‌توانند از دست بدهند، آنجا گرفته می‌شود.
   */
  async setLineQty(input: {
    invoiceId: string;
    lineId: string;
    qty: string;
    actorId: string;
  }): Promise<Invoice> {
    await this.requireDraft(input.invoiceId);

    const line = await this.#db
      .selectFrom("sales.invoice_line")
      .select(["id", "discount_amount", "list_price"])
      .where("id", "=", input.lineId)
      .where("invoice_id", "=", input.invoiceId)
      .executeTakeFirst();
    if (!line) throw new InvoiceError("line_not_found", "این قلم در فاکتور نیست", 404);

    // تخفیف یک مبلغ **مطلق** برای تعدادِ آن لحظه است. با تغییر تعداد،
    // یا باید مطلق بماند (و درصد کاهش بی‌صدا عوض شود) یا نسبتی شود (و
    // مبلغ ثبت‌شده بی‌صدا عوض شود). هر دو یک تصمیم مالی‌اند.
    if (parseMoney(line.discount_amount) > 0n || line.list_price !== null) {
      throw new InvoiceError(
        "line_price_adjusted",
        "تعداد سطری که تخفیف خورده یا قیمتش دستی تغییر کرده از این مسیر عوض نمی‌شود؛ سطر را حذف و دوباره ثبت کنید.",
      );
    }

    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, input.actorId);
      await sql`SELECT sales.set_line_qty(
        ${input.invoiceId}::uuid, ${input.lineId}::uuid, ${input.qty}::platform.qty)`
        .execute(trx);
    });

    return (await this.byId(input.invoiceId)) as Invoice;
  }

  /**
   * ثبت پرداخت روی فاکتور.
   *
   * پرداخت پیش از نهایی‌سازی ثبت می‌شود چون `finalize_invoice` جمع
   * پرداخت‌های موفق را می‌خواند تا `paid_amount` را بنویسد. «نامشخص» و
   * «در انتظار» عمداً پول شمرده نمی‌شوند — قاعده H1.
   */
  async addPayment(input: {
    invoiceId: string;
    methodCode: string;
    amount: bigint;
    refNo?: string | undefined;
    accountId?: string | undefined;
    actorId: string;
    clientEventId?: string | undefined;
  }): Promise<{ paymentId: string }> {
    const id = await this.#db
      .transaction()
      .execute((trx) => this.addPaymentIn(trx, input));
    return { paymentId: id };
  }

  /**
   * همان ثبت پرداخت، داخل تراکنش فراخوان.
   *
   * `runOnce` باید درج Inbox و ثبت پول را در **یک** تراکنش انجام دهد.
   * اگر این متد تراکنش خودش را باز کند، خرابی میان دو Commit یا پول
   * بدون رد می‌گذارد یا رد بدون پول — و هر دو بدتر از تکرارند.
   */
  async addPaymentIn(
    trx: Transaction<Database>,
    input: {
      invoiceId: string;
      methodCode: string;
      amount: bigint;
      refNo?: string | undefined;
      accountId?: string | undefined;
      actorId: string;
      clientEventId?: string | undefined;
    },
  ): Promise<string> {
    // ⚠️ خواندن‌ها روی **همان تراکنش**، نه روی Pool.
    //
    // تا امروز اینجا `this.#db` بود و کار می‌کرد، چون تنها مشتری‌اش
    // صندوق بود و فاکتور از پیش Commit شده. مسیر سفارش سایت کل فاکتور
    // را در یک تراکنش می‌سازد: پیش‌نویسی که هنوز Commit نشده، از Pool
    // دیده نمی‌شود و پرداخت با «فاکتور یافت نشد» رد می‌شد — خطایی که
    // هیچ ربطی به واقعیت نداشت.
    const inv = await this.requireDraft(input.invoiceId, trx);
    if (input.amount <= 0n) {
      throw new InvoiceError("bad_amount", "مبلغ پرداخت باید مثبت باشد", 400);
    }

    const method = await trx
      .selectFrom("treasury.payment_method")
      .select(["code", "requires_ref"])
      .where("code", "=", input.methodCode)
      .executeTakeFirst();
    if (!method) {
      throw new InvoiceError("method_not_found", "روش پرداخت شناخته نشد", 400);
    }
    if (method.requires_ref && !input.refNo) {
      throw new InvoiceError(
        "ref_required",
        `روش پرداخت «${input.methodCode}» شماره پیگیری لازم دارد`,
        400,
      );
    }

    {
      await setActor(trx, input.actorId);
      const row = await trx
        .insertInto("treasury.payment")
        .values({
          invoice_id: input.invoiceId,
          return_id: null,
          shift_id: inv.shiftId,
          method_code: input.methodCode,
          direction: "in",
          amount: serializeMoney(input.amount),
          ref_no: input.refNo ?? null,
          status: "succeeded",
          settled_at: null,
          fee_amount: "0",
          note: null,
          client_event_id: input.clientEventId ?? null,
          account_id: input.accountId ?? null,
          settlement_id: null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      return row.id;
    }
  }

  /**
   * رها کردن سبد نیمه‌کاره.
   *
   * بدون این، مشتری که وسط فروش برود یک فاکتور پیش‌نویس جا می‌گذارد و
   * `close_shift` تا ابد رد می‌کند: «شیفت با فاکتور نهایی‌نشده بسته
   * نمی‌شود». این نگهبان درست است — ولی راه خروجی هم لازم دارد، وگرنه
   * صندوق‌دار وسط شیفت گیر می‌کند.
   *
   * ⚠️ این ابطال **فاکتور نهایی‌شده** نیست. آن یک عملیات کاملاً دیگر
   *    است (`invoice.cancel`) که سند معکوس می‌خواهد و کالا را به انبار
   *    برمی‌گرداند. اینجا هیچ اثر مالی‌ای وجود ندارد که معکوس شود.
   */
  async cancelDraft(invoiceId: string, actorId: string, reason?: string): Promise<Invoice> {
    const inv = await this.byId(invoiceId);
    if (!inv) throw new InvoiceError("invoice_not_found", "فاکتور یافت نشد", 404);
    if (inv.status === "cancelled") return inv;
    if (inv.status !== "draft") {
      throw new InvoiceError(
        "invoice_not_draft",
        `فاکتور در وضعیت «${inv.status}» است. ابطال فاکتور نهایی‌شده مسیر جداگانه‌ای دارد.`,
      );
    }

    const paid = await this.paidSoFar(invoiceId);
    if (paid > 0n) {
      throw new InvoiceError(
        "invoice_has_payment",
        "روی این فاکتور پول دریافت شده است. ابتدا پرداخت باید برگردانده شود.",
      );
    }

    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, actorId);
      await trx
        .updateTable("sales.invoice")
        .set({ status: "cancelled", note: reason ?? null })
        .where("id", "=", invoiceId)
        .where("status", "=", "draft")
        .execute();
      await sql`SELECT platform.audit('invoice.cancel_draft', 'invoice', ${invoiceId}::text,
        jsonb_build_object('reason', ${reason ?? null}::text), ${actorId}::uuid)`.execute(trx);
    });

    return (await this.byId(invoiceId)) as Invoice;
  }

  /** جمع پرداخت‌های واقعاً موفق. «نامشخص» پول نیست. */
  async paidSoFar(invoiceId: string): Promise<bigint> {
    const row = await this.#db
      .selectFrom("treasury.payment")
      .select((eb) => eb.fn.coalesce(eb.fn.sum<string>("amount"), sql<string>`0`).as("total"))
      .where("invoice_id", "=", invoiceId)
      .where("direction", "=", "in")
      .where("status", "in", ["succeeded", "settled", "reconciled"])
      .executeTakeFirst();
    return parseMoney(row?.total ?? "0");
  }

  /** مبلغ قابل پرداختِ پیش‌بینی‌شده، پیش از نهایی‌سازی. */
  async payableEstimate(invoiceId: string): Promise<bigint> {
    const inv = await this.byId(invoiceId);
    if (!inv) throw new InvoiceError("invoice_not_found", "فاکتور یافت نشد", 404);
    return inv.netAmount + inv.taxAmount + inv.shippingAmount;
  }

  /**
   * نهایی‌سازی — تنها جایی که کالا از انبار خارج می‌شود.
   *
   * `trx` از بیرون می‌آید تا با Inbox در یک تراکنش بنشیند: اگر جدا
   * Commit شوند، Retry یا فاکتور دوم می‌سازد یا رد بدون اثر.
   */
  async finalizeIn(
    trx: Transaction<Database>,
    invoiceId: string,
    actorId: string,
  ): Promise<string> {
    await setActor(trx, actorId);
    const r = await sql<{ finalize_invoice: string }>`
      SELECT sales.finalize_invoice(${invoiceId}::uuid, ${actorId}::uuid)
    `.execute(trx);
    const number = r.rows[0]?.finalize_invoice;
    if (!number) {
      throw new InvoiceError("finalize_failed", "نهایی‌سازی فاکتور ناموفق بود", 500);
    }
    return number;
  }

  private async requireDraft(invoiceId: string, ex: Executor = this.#db): Promise<Invoice> {
    const inv = await this.byId(invoiceId, ex);
    if (!inv) throw new InvoiceError("invoice_not_found", "فاکتور یافت نشد", 404);
    if (inv.status !== "draft") {
      throw new InvoiceError(
        "invoice_not_draft",
        `فاکتور در وضعیت «${inv.status}» است و دیگر تغییر نمی‌کند`,
      );
    }
    return inv;
  }
}

async function nextLineNo(trx: Transaction<Database>, invoiceId: string): Promise<number> {
  const row = await trx
    .selectFrom("sales.invoice_line")
    .select((eb) => eb.fn.coalesce(eb.fn.max("line_no"), sql<number>`0`).as("m"))
    .where("invoice_id", "=", invoiceId)
    .executeTakeFirst();
  return Number(row?.m ?? 0) + 1;
}

/**
 * جمع‌های فاکتور از سطرها بازساخته می‌شوند، نه انباشته.
 *
 * انباشتن یعنی حذف یک سطر باید دقیقاً همان عددی را کم کند که افزوده
 * بود؛ یک گرد کردن متفاوت و جمع‌ها بی‌صدا از سطرها جدا می‌افتند.
 *
 * خودِ SQL از مهاجرت ۰۱۵ در دیتابیس است: `sales.set_line_qty` هم
 * همان را صدا می‌زند و دو تعریف از یک جمع، دیر یا زود از هم جدا
 * می‌افتند.
 */
async function refreshTotals(trx: Transaction<Database>, invoiceId: string): Promise<void> {
  await sql`SELECT sales.refresh_invoice_totals(${invoiceId}::uuid)`.execute(trx);
}

/** شکل JSON — پول همیشه رشته. */
export function invoiceToJson(inv: Invoice) {
  return {
    id: inv.id,
    number: inv.number,
    branchId: inv.branchId,
    warehouseId: inv.warehouseId,
    shiftId: inv.shiftId,
    customerId: inv.customerId,
    channel: inv.channel,
    status: inv.status,
    grossAmount: serializeMoney(inv.grossAmount),
    discountAmount: serializeMoney(inv.discountAmount),
    netAmount: serializeMoney(inv.netAmount),
    taxAmount: serializeMoney(inv.taxAmount),
    shippingAmount: serializeMoney(inv.shippingAmount),
    payableAmount: serializeMoney(inv.payableAmount),
    paidAmount: serializeMoney(inv.paidAmount),
    occurredAt: inv.occurredAt.toISOString(),
    lines: inv.lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      variationId: l.variationId,
      sku: l.sku,
      productName: l.productName,
      qty: l.qty,
      unitPrice: serializeMoney(l.unitPrice),
      discountAmount: serializeMoney(l.discountAmount),
      netAmount: serializeMoney(l.netAmount),
      discountReason: l.discountReason,
      // `listPrice` فقط وقتی مقدار دارد که قیمت دستی خورده باشد. رسید
      // چاپی این را نشان نمی‌دهد — «یک وقت داخل فاکتور دوتا قیمت
      // نخورد» — ولی صفحه حسابرسی و گزارش لازمش دارند.
      listPrice: l.listPrice === null ? null : serializeMoney(l.listPrice),
      priceOverrideReason: l.priceOverrideReason,
    })),
  };
}
