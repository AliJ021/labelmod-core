/**
 * رسید خرید — لایه سرویس.
 *
 * ── تفاوت بنیادی با فروش، که اگر فراموش شود همه‌چیز را وارونه می‌کند ──
 *
 * در فروش، **قیمت از دیتابیس می‌آید و کلاینت فقط کالا و تعداد را
 * می‌گوید** — چون قیمت فروش تصمیم ماست و کلاینت نباید بتواند عوضش کند.
 *
 * در خرید برعکس است: قیمت خرید **تصمیم تأمین‌کننده** است و هیچ‌جا در
 * دیتابیس ما نیست. انباردار آن را از روی فاکتور کاغذی وارد می‌کند. پس
 * `unitPrice` اینجا از کلاینت می‌آید و باید بیاید.
 *
 * محافظ جای دیگری است: رسید تا لحظه ثبت هیچ اثری بر انبار و دفتر
 * ندارد، ثبتش مجوز `stock.receive` می‌خواهد، و پس از ثبت تغییرناپذیر
 * است. یعنی «قیمت از کلاینت» اینجا یک استثنا نیست — یک قلمرو دیگر است.
 *
 * ── محاسبه پولی در SQL ────────────────────────────────────────────────
 *
 * `qty` از نوع `NUMERIC(14,3)` است و می‌تواند اعشار داشته باشد (متر
 * پارچه، نه فقط عدد لباس). `qty × unit_price` با `round()` صریح در
 * دیتابیس حساب می‌شود، نه در TypeScript: تقسیم صحیح bigint برای تعداد
 * اعشاری نتیجه‌ای می‌دهد که با `sum()` دیتابیس یکی نیست — و آن‌وقت جمع
 * رسید با جمع سطرهایش نمی‌خواند.
 *
 * ── آنچه اینجا نیست ───────────────────────────────────────────────────
 *
 * تخصیص هزینه حمل، تجدید ارزیابی، سند حسابداری و ورود انبار همه در
 * `purchasing.post_receipt()` هستند. این فایل فقط پیش‌نویس را می‌سازد و
 * می‌خواند؛ لحظه‌ای که پول جابه‌جا می‌شود، یک تابع دیتابیس است.
 */
import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { Db } from "../db/client.ts";
import type { Database } from "../db/types.ts";
import { serializeMoney } from "../lib/money.ts";
import { setActor } from "../lib/idempotency.ts";

export class PurchasingError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "PurchasingError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface ReceiptLineJson {
  id: string;
  variationId: string;
  sku: string;
  barcode: string | null;
  productName: string;
  color: string | null;
  size: string | null;
  qty: string;
  unitPrice: string;
  lineAmount: string;
  chargeAlloc: string;
  landedUnitCost: string;
}

export interface ReceiptChargeJson {
  id: string;
  chargeType: string;
  amount: string;
  allocation: string;
  paidFrom: string;
  payeeType: string;
  payeeName: string | null;
  paidAccountId: string | null;
  paidAccountName: string | null;
  /**
   * سرفصل هزینه دوره — فقط وقتی `allocation` برابر `none` است.
   * تهی یعنی حساب پیش‌فرض قاعده ثبت (۶۱۰۲ هزینه حمل و ارسال).
   */
  expenseAccountCode: string | null;
  expenseAccountName: string | null;
}

export interface ReceiptJson {
  id: string;
  number: string | null;
  status: string;
  branchId: string;
  warehouseId: string;
  warehouseName: string;
  supplierId: string;
  supplierName: string;
  supplierInvoiceNo: string | null;
  occurredAt: string;
  postedAt: string | null;
  note: string | null;
  taxAmount: string;
  /** جمع کالا — از سطرها، نه از ستون. تا پیش از ثبت، ستون هنوز صفر است. */
  goodsAmount: string;
  chargesAmount: string;
  /** جمع پرداختنی به تأمین‌کننده: کالا + مالیات + هزینه‌های بر عهده او. */
  supplierPayable: string;
  /** هزینه‌هایی که به شخص ثالث بدهکاریم (باربری و مانند آن). */
  thirdPartyPayable: string;
  lines: ReceiptLineJson[];
  charges: ReceiptChargeJson[];
}

export interface ReceiptSummaryJson {
  id: string;
  number: string | null;
  status: string;
  supplierName: string;
  warehouseName: string;
  occurredAt: string;
  supplierInvoiceNo: string | null;
  lineCount: number;
  goodsAmount: string;
}

export class ReceiptService {
  // فیلد خصوصی، نه parameter property: TypeScript اینجا بدون مرحله
  // Build اجرا می‌شود و حالت strip-only آن نحو را نمی‌پذیرد (ADR-001).
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  // ── خواندن ─────────────────────────────────────────────────────────

  /**
   * فهرست رسیدها در دامنه شعبه کاربر.
   *
   * جمع کالا از سطرها خوانده می‌شود، نه از ستون `goods_amount`: آن ستون
   * را `post_receipt` می‌نویسد، پس روی پیش‌نویس همیشه صفر است و فهرستی
   * که همه‌چیزش صفر باشد بی‌فایده است.
   */
  async list(opts: {
    branchIds: string[] | "all";
    status?: string | undefined;
    limit: number;
  }): Promise<ReceiptSummaryJson[]> {
    if (opts.branchIds !== "all" && opts.branchIds.length === 0) return [];

    let q = this.#db
      .selectFrom("purchasing.receipt as r")
      .innerJoin("purchasing.supplier as s", "s.id", "r.supplier_id")
      .innerJoin("inventory.warehouse as w", "w.id", "r.warehouse_id")
      .select([
        "r.id",
        "r.number",
        "r.status",
        "r.occurred_at",
        "r.supplier_invoice_no",
        "s.name as supplier_name",
        "w.name as warehouse_name",
        sql<string>`(SELECT count(*) FROM purchasing.receipt_line l WHERE l.receipt_id = r.id)`.as(
          "line_count",
        ),
        sql<string>`(SELECT coalesce(sum(round(l.qty * l.unit_price)), 0)
                       FROM purchasing.receipt_line l WHERE l.receipt_id = r.id)`.as(
          "goods_amount",
        ),
      ])
      .orderBy("r.occurred_at", "desc")
      .orderBy("r.id", "desc")
      .limit(opts.limit);

    if (opts.branchIds !== "all") q = q.where("r.branch_id", "in", opts.branchIds);
    if (opts.status) q = q.where("r.status", "=", opts.status);

    const rows = await q.execute();
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      status: r.status,
      supplierName: r.supplier_name,
      warehouseName: r.warehouse_name,
      occurredAt: new Date(r.occurred_at).toISOString(),
      supplierInvoiceNo: r.supplier_invoice_no,
      lineCount: Number(r.line_count),
      goodsAmount: r.goods_amount,
    }));
  }

  /**
   * یافتن رسید از روی **شماره**.
   *
   * شماره در سطح شعبه یکتاست، نه سراسری — پس `branchId` اجباری است،
   * همان قاعده‌ای که `GET /invoices/lookup` دارد.
   *
   * چرا سرورساید و نه فیلتر روی فهرست: فهرست رسیدها سقف دارد و فقط
   * تازه‌ترین‌ها را می‌دهد. برگشت از خریدی که سه ماه پیش رسید شده،
   * با فیلتر مرورگر هرگز پیدا نمی‌شد.
   */
  async byNumber(
    number: string,
    branchId: string,
  ): Promise<{ id: string } | null> {
    const row = await this.#db
      .selectFrom("purchasing.receipt")
      .select("id")
      .where("number", "=", number)
      .where("branch_id", "=", branchId)
      .executeTakeFirst();
    return row ?? null;
  }

  /** رسید کامل. `null` یعنی نبود یا بیرون از دامنه شعبه کاربر. */
  async get(id: string, branchIds: string[] | "all"): Promise<ReceiptJson | null> {
    const head = await this.#db
      .selectFrom("purchasing.receipt as r")
      .innerJoin("purchasing.supplier as s", "s.id", "r.supplier_id")
      .innerJoin("inventory.warehouse as w", "w.id", "r.warehouse_id")
      .select([
        "r.id",
        "r.number",
        "r.status",
        "r.branch_id",
        "r.warehouse_id",
        "r.supplier_id",
        "r.supplier_invoice_no",
        "r.occurred_at",
        "r.posted_at",
        "r.note",
        "r.tax_amount",
        "s.name as supplier_name",
        "w.name as warehouse_name",
      ])
      .where("r.id", "=", id)
      .executeTakeFirst();

    if (!head) return null;
    if (branchIds !== "all" && !branchIds.includes(head.branch_id)) return null;

    const lines = await this.#db
      .selectFrom("purchasing.receipt_line as l")
      .innerJoin("catalog.variation as v", "v.id", "l.variation_id")
      .innerJoin("catalog.product as p", "p.id", "v.product_id")
      .select([
        "l.id",
        "l.variation_id",
        "l.qty",
        "l.unit_price",
        "l.charge_alloc",
        "l.landed_unit_cost",
        "v.sku",
        "v.barcode",
        "v.color",
        "v.size",
        "p.name_internal as product_name",
        // مبلغ سطر از qty × unit_price حساب می‌شود، نه از ستون
        // `line_amount`: آن ستون را post_receipt می‌نویسد و روی
        // پیش‌نویس هنوز مقدار قبلی یا صفر است.
        sql<string>`round(l.qty * l.unit_price)`.as("line_amount"),
      ])
      .where("l.receipt_id", "=", id)
      .orderBy("l.id")
      .execute();

    const charges = await this.#db
      .selectFrom("purchasing.receipt_charge as c")
      .leftJoin("treasury.account as a", "a.id", "c.paid_account_id")
      .leftJoin("ledger.account as x", "x.code", "c.expense_account_code")
      .select([
        "c.id",
        "c.charge_type",
        "c.amount",
        "c.allocation",
        "c.paid_from",
        "c.payee_type",
        "c.payee_name",
        "c.paid_account_id",
        "c.expense_account_code",
        "a.name as paid_account_name",
        "x.name as expense_account_name",
      ])
      .where("c.receipt_id", "=", id)
      .orderBy("c.id")
      .execute();

    const goods = lines.reduce((a, l) => a + BigInt(l.line_amount), 0n);
    const chargeTotal = charges.reduce((a, c) => a + BigInt(c.amount), 0n);
    const supplierCharges = charges
      .filter((c) => c.paid_from === "payable" && c.payee_type === "supplier")
      .reduce((a, c) => a + BigInt(c.amount), 0n);
    const thirdParty = charges
      .filter((c) => c.paid_from === "payable" && c.payee_type === "other")
      .reduce((a, c) => a + BigInt(c.amount), 0n);

    return {
      id: head.id,
      number: head.number,
      status: head.status,
      branchId: head.branch_id,
      warehouseId: head.warehouse_id,
      warehouseName: head.warehouse_name,
      supplierId: head.supplier_id,
      supplierName: head.supplier_name,
      supplierInvoiceNo: head.supplier_invoice_no,
      occurredAt: new Date(head.occurred_at).toISOString(),
      postedAt: head.posted_at === null ? null : new Date(head.posted_at).toISOString(),
      note: head.note,
      taxAmount: head.tax_amount,
      goodsAmount: serializeMoney(goods),
      chargesAmount: serializeMoney(chargeTotal),
      supplierPayable: serializeMoney(goods + BigInt(head.tax_amount) + supplierCharges),
      thirdPartyPayable: serializeMoney(thirdParty),
      lines: lines.map((l) => ({
        id: l.id,
        variationId: l.variation_id,
        sku: l.sku,
        barcode: l.barcode,
        productName: l.product_name,
        color: l.color,
        size: l.size,
        qty: l.qty,
        unitPrice: l.unit_price,
        lineAmount: l.line_amount,
        chargeAlloc: l.charge_alloc,
        landedUnitCost: l.landed_unit_cost,
      })),
      charges: charges.map((c) => ({
        id: c.id,
        chargeType: c.charge_type,
        amount: c.amount,
        allocation: c.allocation,
        paidFrom: c.paid_from ?? "payable",
        payeeType: c.payee_type,
        payeeName: c.payee_name,
        paidAccountId: c.paid_account_id,
        paidAccountName: c.paid_account_name,
        expenseAccountCode: c.expense_account_code,
        expenseAccountName: c.expense_account_name,
      })),
    };
  }

  // ── نوشتن ──────────────────────────────────────────────────────────

  /**
   * پیش‌نویس تازه — **بدون شماره**.
   *
   * شماره را `purchasing.post_receipt()` در لحظه ثبت می‌دهد (مهاجرت
   * ۰۲۵). پیش‌نویسی که رها می‌شود نباید یک شماره را بسوزاند.
   */
  async createDraft(
    trx: Transaction<Database>,
    input: {
      branchId: string;
      warehouseId: string;
      supplierId: string;
      occurredAt?: string | undefined;
      supplierInvoiceNo?: string | undefined;
      note?: string | undefined;
      actorId: string;
    },
  ): Promise<string> {
    await setActor(trx, input.actorId);

    const supplier = await trx
      .selectFrom("purchasing.supplier")
      .select(["id", "is_active"])
      .where("id", "=", input.supplierId)
      .executeTakeFirst();
    if (!supplier) throw new PurchasingError("supplier_not_found", "تأمین‌کننده یافت نشد", 404);
    if (!supplier.is_active) {
      throw new PurchasingError("supplier_inactive", "این تأمین‌کننده غیرفعال است");
    }

    const row = await trx
      .insertInto("purchasing.receipt")
      .values({
        number: null,
        branch_id: input.branchId,
        warehouse_id: input.warehouseId,
        supplier_id: input.supplierId,
        supplier_invoice_no: input.supplierInvoiceNo ?? null,
        note: input.note ?? null,
        created_by: input.actorId,
        ...(input.occurredAt === undefined ? {} : { occurred_at: new Date(input.occurredAt) }),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    return row.id;
  }

  /**
   * سطر تازه، یا افزودن به سطر موجودِ همان کالا **با همان قیمت**.
   *
   * چرا شرط «همان قیمت»: دو محموله از یک کالا با دو نرخ، دو سطر واقعی
   * روی فاکتور تأمین‌کننده‌اند. ادغامشان در یک سطر یعنی یکی از دو نرخ
   * پاک شود — و بهای تمام‌شده‌ای که از آن درمی‌آید هیچ‌کدام نباشد.
   */
  async addLine(
    trx: Transaction<Database>,
    input: {
      receiptId: string;
      variationId: string;
      qty: string;
      unitPrice: bigint;
      actorId: string;
    },
  ): Promise<string> {
    await setActor(trx, input.actorId);
    await this.assertDraft(trx, input.receiptId);

    const existing = await trx
      .selectFrom("purchasing.receipt_line")
      .select(["id", "qty"])
      .where("receipt_id", "=", input.receiptId)
      .where("variation_id", "=", input.variationId)
      .where("unit_price", "=", serializeMoney(input.unitPrice))
      .executeTakeFirst();

    if (existing) {
      await trx
        .updateTable("purchasing.receipt_line")
        .set({
          qty: sql<string>`qty + ${input.qty}::platform.qty`,
          line_amount: sql<string>`round((qty + ${input.qty}::platform.qty) * unit_price)`,
        })
        .where("id", "=", existing.id)
        .execute();
      return existing.id;
    }

    const row = await trx
      .insertInto("purchasing.receipt_line")
      .values({
        receipt_id: input.receiptId,
        variation_id: input.variationId,
        qty: input.qty,
        unit_price: serializeMoney(input.unitPrice),
        line_amount: sql<string>`round(${input.qty}::numeric * ${serializeMoney(input.unitPrice)}::numeric)`,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    return row.id;
  }

  /** تعداد و قیمت **مطلق**، نه افزایشی — مثل ویرایش سطر فاکتور. */
  async setLine(
    trx: Transaction<Database>,
    input: {
      receiptId: string;
      lineId: string;
      qty?: string | undefined;
      unitPrice?: bigint | undefined;
      actorId: string;
    },
  ): Promise<void> {
    await setActor(trx, input.actorId);
    await this.assertDraft(trx, input.receiptId);

    const line = await trx
      .selectFrom("purchasing.receipt_line")
      .select(["id", "qty", "unit_price"])
      .where("id", "=", input.lineId)
      .where("receipt_id", "=", input.receiptId)
      .executeTakeFirst();
    if (!line) throw new PurchasingError("line_not_found", "این قلم در رسید نیست", 404);

    const qty = input.qty ?? line.qty;
    const price = input.unitPrice === undefined ? line.unit_price : serializeMoney(input.unitPrice);

    await trx
      .updateTable("purchasing.receipt_line")
      .set({
        qty,
        unit_price: price,
        line_amount: sql<string>`round(${qty}::numeric * ${price}::numeric)`,
      })
      .where("id", "=", input.lineId)
      .execute();
  }

  async removeLine(
    trx: Transaction<Database>,
    receiptId: string,
    lineId: string,
    actorId: string,
  ): Promise<void> {
    await setActor(trx, actorId);
    await this.assertDraft(trx, receiptId);
    const res = await trx
      .deleteFrom("purchasing.receipt_line")
      .where("id", "=", lineId)
      .where("receipt_id", "=", receiptId)
      .executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) {
      throw new PurchasingError("line_not_found", "این قلم در رسید نیست", 404);
    }
  }

  /**
   * هزینه جانبی — حمل، ترخیص، بسته‌بندی.
   *
   * `allocation` تعیین می‌کند این هزینه چطور روی بهای تمام‌شده بنشیند:
   * `by_value` نسبت به مبلغ سطر، `by_qty` نسبت به تعداد، و `none`
   * یعنی اصلاً وارد بهای کالا نشود.
   *
   * ⚠️ هزینه پرداخت‌شده از خزانه، حساب پرداخت‌کننده می‌خواهد — و
   * دیتابیس اجازه نمی‌دهد آن حساب صندوق فروشگاه باشد
   * (`assert_charge_not_from_cash_box`): پول کشو فقط از فروش و
   * بازپرداخت حرکت می‌کند، وگرنه شمارش صندوق مغایرت کاذب می‌دهد.
   */
  async addCharge(
    trx: Transaction<Database>,
    input: {
      receiptId: string;
      chargeType: string;
      amount: bigint;
      allocation: string;
      paidFrom: string;
      payeeType: string;
      payeeName?: string | undefined;
      paidAccountId?: string | undefined;
      expenseAccountCode?: string | undefined;
      actorId: string;
    },
  ): Promise<string> {
    await setActor(trx, input.actorId);
    await this.assertDraft(trx, input.receiptId);

    const row = await trx
      .insertInto("purchasing.receipt_charge")
      .values({
        receipt_id: input.receiptId,
        charge_type: input.chargeType,
        amount: serializeMoney(input.amount),
        allocation: input.allocation,
        paid_from: input.paidFrom,
        payee_type: input.payeeType,
        payee_name: input.payeeName ?? null,
        paid_account_id: input.paidAccountId ?? null,
        expense_account_code: input.expenseAccountCode ?? null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    return row.id;
  }

  async removeCharge(
    trx: Transaction<Database>,
    receiptId: string,
    chargeId: string,
    actorId: string,
  ): Promise<void> {
    await setActor(trx, actorId);
    await this.assertDraft(trx, receiptId);
    const res = await trx
      .deleteFrom("purchasing.receipt_charge")
      .where("id", "=", chargeId)
      .where("receipt_id", "=", receiptId)
      .executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) {
      throw new PurchasingError("charge_not_found", "این هزینه در رسید نیست", 404);
    }
  }

  /** سرآیند پیش‌نویس — مالیات، شماره فاکتور تأمین‌کننده، تاریخ، یادداشت. */
  async updateHead(
    trx: Transaction<Database>,
    input: {
      receiptId: string;
      taxAmount?: bigint | undefined;
      supplierInvoiceNo?: string | null | undefined;
      occurredAt?: string | undefined;
      note?: string | null | undefined;
      actorId: string;
    },
  ): Promise<void> {
    await setActor(trx, input.actorId);
    await this.assertDraft(trx, input.receiptId);

    const patch: Record<string, unknown> = {};
    if (input.taxAmount !== undefined) patch["tax_amount"] = serializeMoney(input.taxAmount);
    if (input.supplierInvoiceNo !== undefined) {
      patch["supplier_invoice_no"] = input.supplierInvoiceNo;
    }
    if (input.occurredAt !== undefined) patch["occurred_at"] = new Date(input.occurredAt);
    if (input.note !== undefined) patch["note"] = input.note;
    if (Object.keys(patch).length === 0) return;

    await trx
      .updateTable("purchasing.receipt")
      .set(patch)
      .where("id", "=", input.receiptId)
      .execute();
  }

  /**
   * ثبت — لحظه‌ای که کالا وارد انبار و سند وارد دفتر می‌شود.
   *
   * همه کار در `purchasing.post_receipt()` است: تخصیص شماره، تخصیص
   * هزینه حمل، تجدید ارزیابی (اگر روش «آخرین قیمت خرید» باشد)، ورود
   * انبار و سند حسابداری. اینجا فقط صدا زده می‌شود.
   */
  async post(
    trx: Transaction<Database>,
    receiptId: string,
    actorId: string,
  ): Promise<string> {
    await setActor(trx, actorId);
    const r = await sql<{ entry: string }>`
      SELECT purchasing.post_receipt(${receiptId}::uuid, ${actorId}::uuid) AS entry
    `.execute(trx);
    const entry = r.rows[0]?.entry;
    if (!entry) throw new PurchasingError("post_failed", "ثبت رسید نتیجه‌ای برنگرداند", 500);
    return entry;
  }

  /**
   * ابطال پیش‌نویس.
   *
   * حذف نمی‌شود، `cancelled` می‌شود: پیش‌نویسی که ساخته و رها شده،
   * خودش یک واقعیت است. حذفش یعنی کسی که فردا می‌پرسد «آن محموله چه
   * شد؟» هیچ ردی پیدا نکند.
   */
  async cancelDraft(
    trx: Transaction<Database>,
    receiptId: string,
    actorId: string,
  ): Promise<void> {
    await setActor(trx, actorId);
    await this.assertDraft(trx, receiptId);
    await trx
      .updateTable("purchasing.receipt")
      .set({ status: "cancelled" })
      .where("id", "=", receiptId)
      .execute();
  }

  /**
   * رسید ثبت‌شده تغییر نمی‌کند.
   *
   * قفل روی سطر است، نه فقط یک خواندن: بدون آن، دو درخواست هم‌زمان
   * می‌توانستند هر دو «پیش‌نویس است» ببینند و یکی‌شان روی رسیدِ در حال
   * ثبت بنویسد.
   */
  private async assertDraft(trx: Transaction<Database>, receiptId: string): Promise<void> {
    const r = await sql<{ status: string }>`
      SELECT status FROM purchasing.receipt WHERE id = ${receiptId}::uuid FOR UPDATE
    `.execute(trx);
    const row = r.rows[0];
    if (!row) throw new PurchasingError("receipt_not_found", "رسید خرید یافت نشد", 404);
    if (row.status === "posted") {
      throw new PurchasingError("receipt_posted", "رسید ثبت‌شده تغییر نمی‌کند", 409);
    }
    if (row.status === "cancelled") {
      throw new PurchasingError("receipt_cancelled", "این رسید باطل شده است", 409);
    }
  }
}
