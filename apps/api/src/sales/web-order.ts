/**
 * سفارش سایت — ورودی ووکامرس.
 *
 * ── قاعده‌ای که اینجا وارونه است، و چرا ─────────────────────────────
 *
 * صندوق قیمت نمی‌فرستد؛ قیمت از `catalog.price` خوانده می‌شود. **سایت
 * می‌فرستد** — و باید بفرستد.
 *
 * دلیلش یک اصل ساده است: **مشتری همان چیزی را پرداخت کرده که سایت
 * نشانش داده.** اگر ما قیمت جاری `catalog.price` را ثبت کنیم و سایت
 * وسط یک کمپین چیز دیگری گرفته باشد، دفتر دروغ می‌گوید — درآمدی ثبت
 * می‌شود که هرگز دریافت نشده.
 *
 * ولی این «قیمت آزاد» نیست: قیمت سایت دقیقاً از همان مسیر **قیمت
 * دستی** می‌گذرد که برای صندوق ساخته شده. یعنی `unit_price` قیمت
 * پرداختی می‌شود و `list_price` قیمت فهرست — فاکتور یک عدد نشان
 * می‌دهد و تفاوت در گزارش دیده می‌شود. اختلافِ پنهان، همان چیزی است
 * که هرگز پیدا نمی‌شود.
 *
 * ── چرا همه‌چیز در یک تراکنش ───────────────────────────────────────
 *
 * پیش‌نویس، اقلام، پرداخت و نهایی‌سازی همه در یک `runOnce` می‌نشینند.
 * جدا کردنشان یعنی خرابی میانه یک فاکتور نیمه‌کاره جا بگذارد که
 * درآمدش هرگز به دفتر نمی‌رود و کسی هم دنبالش نمی‌گردد.
 *
 * ── مالیات ─────────────────────────────────────────────────────────
 *
 * سایت مالیات را نمی‌فرستد و نباید بفرستد. نرخ مالیات یک تنظیم است
 * (`tax.rate_percent`، پیش‌فرض خاموش) و اگر روزی روشن شود، همان یک
 * تعریف باید همه‌جا حاکم باشد — نه عددی که پلاگین وردپرس حساب کرده.
 */
import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { Db } from "../db/client.ts";
import type { Database } from "../db/types.ts";
import { parseMoney, serializeMoney } from "../lib/money.ts";
import { InvoiceError, type Executor, type InvoiceService } from "./invoice.ts";

export interface WebOrderLineInput {
  sku: string;
  qty: string;
  /** قیمت واحدی که مشتری واقعاً پرداخت کرده — به ریال، رشته. */
  unitPrice: bigint;
}

export interface WebOrderInput {
  branchId: string;
  warehouseId: string;
  /** شماره سفارش در ووکامرس — هویت این عملیات. */
  externalId: string;
  occurredAt?: string | undefined;
  customerMobile?: string | undefined;
  customerName?: string | undefined;
  lines: WebOrderLineInput[];
  shippingAmount: bigint;
  /** روش پرداخت از فهرست `treasury.payment_method`. */
  paymentMethod: string;
  paymentRef?: string | undefined;
  /** مبلغی که درگاه واقعاً گرفته. */
  paidAmount: bigint;
  note?: string | undefined;
  actorId: string;
}

export class WebOrderService {
  readonly #db: Db;
  readonly #invoices: InvoiceService;

  constructor(db: Db, invoices: InvoiceService) {
    this.#db = db;
    this.#invoices = invoices;
  }

  /**
   * SKU → شناسه تنوع.
   *
   * سایت با **SKU** حرف می‌زند، نه با UUID: در ووکامرس همان SKU روی
   * محصول نشسته و کسی UUID ما را آنجا نمی‌نویسد. بارکد هم کار
   * می‌کرد، ولی SKU چیزی است که انباردار روی برچسب می‌بیند و در
   * ووکامرس وارد می‌کند.
   *
   * `ex` هم Pool را می‌پذیرد هم تراکنش: مسیر HTTP پیش از باز کردن
   * تراکنش صدایش می‌زند تا مجوز قیمت را بگیرد، و `ingest` داخل همان
   * تراکنش. یک تعریف از «SKU چه کالایی است»، نه دو تا.
   */
  async resolveSku(ex: Executor, sku: string): Promise<string> {
    const v = await ex
      .selectFrom("catalog.variation")
      .select(["id", "status"])
      .where("sku", "=", sku)
      .executeTakeFirst();

    if (!v) {
      throw new InvoiceError(
        "sku_not_found",
        `کالایی با SKU «${sku}» در سیستم نیست. سفارش سایت ثبت نشد.`,
        422,
      );
    }
    if (v.status !== "active") {
      throw new InvoiceError("variation_inactive", `کالای «${sku}» غیرفعال است`, 422);
    }
    return v.id;
  }

  /**
   * مشتری از روی موبایل — می‌سازد اگر نباشد.
   *
   * `mobile_normalized` کلید تطبیق است، نه کلید اصلی: همان شماره از
   * سایت و از صندوق باید یک مشتری بسازد، وگرنه سابقه خرید دو تکه
   * می‌شود.
   */
  async resolveCustomer(
    trx: Transaction<Database>,
    mobile: string,
    fullName: string | undefined,
  ): Promise<string> {
    // نرمال‌سازی در **دیتابیس**، نه اینجا: `sales.normalize_mobile()`
    // از روز اول وجود دارد و «۰۹۱۲…» و «+98912…» را یکی می‌کند. یک
    // نسخه دوم در TypeScript یعنی دو تعریف از یک قاعده — و آنکه
    // در psql دور زده می‌شود همان است که اهمیت دارد.
    const norm = await sql<{ m: string | null }>`
      SELECT sales.normalize_mobile(${mobile}) AS m
    `.execute(trx);
    const normalized = norm.rows[0]?.m ?? mobile;

    const existing = await trx
      .selectFrom("sales.customer")
      .select("id")
      .where("mobile_normalized", "=", normalized)
      .executeTakeFirst();
    if (existing) return existing.id;

    const row = await trx
      .insertInto("sales.customer")
      .values({
        mobile_normalized: normalized,
        full_name: fullName ?? null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /**
   * ثبت کامل یک سفارش سایت — در همان تراکنشِ فراخوان.
   *
   * `shippingAmount` روی سرآیند فاکتور می‌نشیند، نه به‌عنوان یک قلم:
   * کرایه ارسال کالا نیست و نباید در گزارش «چه فروختیم» بیاید.
   */
  async ingest(trx: Transaction<Database>, input: WebOrderInput): Promise<string> {
    if (input.lines.length === 0) {
      throw new InvoiceError("empty_order", "سفارش بدون قلم ثبت نمی‌شود", 422);
    }

    const customerId = input.customerMobile
      ? await this.resolveCustomer(trx, input.customerMobile, input.customerName)
      : undefined;

    const invoiceId = await this.#invoices.createDraftIn(trx, {
      branchId: input.branchId,
      warehouseId: input.warehouseId,
      channel: "web",
      actorId: input.actorId,
      ...(customerId === undefined ? {} : { customerId }),
    });

    for (const line of input.lines) {
      const variationId = await this.resolveSku(trx, line.sku);
      await this.#invoices.addLineIn(trx, {
        invoiceId,
        variationId,
        qty: line.qty,
        unitPrice: line.unitPrice,
        // دلیل ثابت و نه متن آزاد: در گزارش «کدام سطرها قیمت دستی
        // داشتند» باید بشود سایت را از صندوق جدا کرد.
        priceOverrideReason: "قیمت سایت",
        actorId: input.actorId,
      });
    }

    if (input.shippingAmount > 0n) {
      await trx
        .updateTable("sales.invoice")
        .set({ shipping_amount: serializeMoney(input.shippingAmount) })
        .where("id", "=", invoiceId)
        .execute();
      // جمع‌ها را دیتابیس می‌سازد، نه ما: `payable_amount` باید
      // کرایه را هم در خودش داشته باشد.
      await sql`SELECT sales.refresh_invoice_totals(${invoiceId}::uuid)`.execute(trx);
    }

    if (input.paidAmount > 0n) {
      await this.#invoices.addPaymentIn(trx, {
        invoiceId,
        methodCode: input.paymentMethod,
        amount: input.paidAmount,
        actorId: input.actorId,
        ...(input.paymentRef === undefined ? {} : { refNo: input.paymentRef }),
        // شماره سفارش سایت، کلید یکتایی پرداخت هم هست: درگاهی که
        // دو بار Callback بزند، پرداخت دوم را نمی‌سازد.
        clientEventId: `woo:${input.externalId}`,
      });
    }

    // نهایی‌سازی: کالا از انبار خارج می‌شود و شماره فاکتور می‌خورد.
    // سند درآمد و COGS اینجا زده نمی‌شود — کار `sales.post_batch()`
    // در بستن شبانه دوره کانال است (ADR-003).
    await this.#invoices.finalizeIn(trx, invoiceId, input.actorId);

    if (input.note) {
      await trx
        .updateTable("sales.invoice")
        .set({ note: input.note })
        .where("id", "=", invoiceId)
        .execute();
    }

    return invoiceId;
  }
}

/** مبلغ ریالی رشته‌ای → bigint، با پیام فارسی برای مرز API. */
export function parseWebMoney(value: unknown, field: string): bigint {
  try {
    return parseMoney(value);
  } catch {
    throw new InvoiceError("bad_money", `مبلغ «${field}» معتبر نیست`, 400);
  }
}
