/**
 * برگشت از فروش.
 *
 * تمام منطق مالی در `sales.post_return` است: بهای بازگشت از Snapshot
 * همان فروش (نه میانگین جاری انبار)، ترتیب تسویه بازپرداخت، و سقف
 * «بیش از پول واقعاً دریافت‌شده پس داده نمی‌شود».
 *
 * این لایه چهار چیز اضافه می‌کند که دیتابیس نمی‌داند:
 *   ۱. مهلت مرجوعی — `return.same_day` یا `return.late`
 *   ۲. مجوز بازپرداخت نقدی — `refund.cash`
 *   ۳. علت مرجوعی از فهرست بسته `return.reason_codes`
 *   ۴. بازپرداخت نقدی باید به شیفت باز همان کاربر بچسبد
 *
 * ⚠️ برگ مرجوعی **یک‌جا** ساخته می‌شود، نه مثل سبد قدم‌به‌قدم. مرجوعی
 *    یک تصمیم است که در لحظه گرفته می‌شود؛ سبد نیست.
 */
import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { Db } from "../db/client.ts";
import type { Database } from "../db/types.ts";
import { parseMoney, serializeMoney } from "../lib/money.ts";
import { setActor } from "../lib/idempotency.ts";

export class ReturnError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode = 409) {
    super(message);
    this.name = "ReturnError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface ReturnLineInput {
  invoiceLineId: string;
  qty: string;
  restock?: boolean | undefined;
  condition?: "sellable" | "defective" | undefined;
}

export interface SaleReturn {
  id: string;
  number: string | null;
  invoiceId: string;
  branchId: string;
  warehouseId: string;
  shiftId: string | null;
  status: string;
  reasonCode: string;
  reasonNote: string | null;
  netAmount: bigint;
  taxAmount: bigint;
  refundAmount: bigint;
  refundMethod: string | null;
  refundReference: string | null;
  refundPaymentId: string | null;
  receivableApplied: bigint;
  creditApplied: bigint;
  cogsAmount: bigint;
  occurredAt: Date;
  lines: Array<{
    id: string;
    invoiceLineId: string;
    qty: string;
    restock: boolean;
    condition: string;
    netAmount: bigint;
  }>;
}

/** یک سطر فاکتور، با آنچه هنوز قابل برگشت است. */
export interface ReturnableLine {
  invoiceLineId: string;
  variationId: string;
  soldQty: string;
  returnedQty: string;
  remainingQty: string;
  unitPrice: bigint;
  netAmount: bigint;
  returnedNetAmount: bigint;
  taxAmount: bigint;
  returnedTaxAmount: bigint;
}

export class ReturnService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * مقصد کالای سالمِ برگشتی.
   *
   * سنجش‌ها در دیتابیس‌اند (`sales.set_return_warehouse`): پیش‌نویس
   * بودن، هم‌شعبه بودن انبار، و «در راه» نبودنش. اینجا فقط تراکنش و
   * کاربر عامل.
   */
  async setWarehouse(input: {
    id: string;
    warehouseId: string;
    actorId: string;
  }): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, input.actorId);
      await sql`
        SELECT sales.set_return_warehouse(
          ${input.id}::uuid, ${input.warehouseId}::uuid, ${input.actorId}::uuid)
      `.execute(trx);
    });
  }

  async byId(returnId: string): Promise<SaleReturn | null> {
    const r = await this.#db
      .selectFrom("sales.sale_return")
      .selectAll()
      .where("id", "=", returnId)
      .executeTakeFirst();
    if (!r) return null;

    const lines = await this.#db
      .selectFrom("sales.sale_return_line")
      .select(["id", "invoice_line_id", "qty", "restock", "condition", "net_amount"])
      .where("return_id", "=", returnId)
      .execute();

    return {
      id: r.id,
      number: r.number,
      invoiceId: r.invoice_id,
      branchId: r.branch_id,
      warehouseId: r.warehouse_id,
      shiftId: r.shift_id,
      status: r.status,
      reasonCode: r.reason_code,
      reasonNote: r.reason_note,
      netAmount: parseMoney(r.net_amount),
      taxAmount: parseMoney(r.tax_amount),
      refundAmount: parseMoney(r.refund_amount),
      refundMethod: r.refund_method,
      refundReference: r.refund_reference,
      refundPaymentId: r.refund_payment_id,
      receivableApplied: parseMoney(r.receivable_applied),
      creditApplied: parseMoney(r.credit_applied),
      cogsAmount: parseMoney(r.cogs_amount),
      occurredAt: r.occurred_at,
      lines: lines.map((l) => ({
        id: l.id,
        invoiceLineId: l.invoice_line_id,
        qty: l.qty,
        restock: l.restock,
        condition: l.condition,
        netAmount: parseMoney(l.net_amount),
      })),
    };
  }

  /**
   * آنچه از یک فاکتور هنوز قابل برگشت است.
   *
   * صندوق‌دار پیش از زدن مرجوعی باید بداند کدام قلم چقدر باقی مانده،
   * وگرنه فقط `post_return` سر خط آخر خطا می‌دهد و کل برگ رد می‌شود.
   */
  async returnable(invoiceId: string): Promise<ReturnableLine[]> {
    // تفریق در SQL انجام می‌شود نه در جاوااسکریپت. `platform.qty` سه
    // رقم اعشار دارد و `Number()` روی آن همان خطای شناوری را می‌آورد
    // که یک بار روی `qty × price` گرفتیمش — با این تفاوت که اینجا
    // نتیجه چیزی است که صندوق‌دار رویش تصمیم می‌گیرد.
    const res = await sql<{
      id: string;
      variation_id: string;
      qty: string;
      returned_qty: string;
      remaining_qty: string;
      unit_price: string;
        net_amount: string;
        returned_net: string;
        tax_amount: string;
        returned_tax: string;
      }>`
      SELECT id, variation_id, qty::text, returned_qty::text,
             (qty - returned_qty)::text AS remaining_qty,
               unit_price::text, net_amount::text, tax_amount::text,
               coalesce((SELECT sum(rl.net_amount) FROM sales.sale_return_line rl
                 JOIN sales.sale_return r ON r.id=rl.return_id WHERE rl.invoice_line_id=il.id AND r.status='posted'),0)::text returned_net,
               coalesce((SELECT sum(rl.tax_amount) FROM sales.sale_return_line rl
                 JOIN sales.sale_return r ON r.id=rl.return_id WHERE rl.invoice_line_id=il.id AND r.status='posted'),0)::text returned_tax
          FROM sales.invoice_line il
       WHERE invoice_id = ${invoiceId}::uuid
       ORDER BY id
    `.execute(this.#db);

    return res.rows.map((l) => ({
      invoiceLineId: l.id,
      variationId: l.variation_id,
      soldQty: l.qty,
      returnedQty: l.returned_qty,
      remainingQty: l.remaining_qty,
      unitPrice: parseMoney(l.unit_price),
        netAmount: parseMoney(l.net_amount),
        returnedNetAmount: parseMoney(l.returned_net),
        taxAmount: parseMoney(l.tax_amount),
        returnedTaxAmount: parseMoney(l.returned_tax),
    }));
  }

  /**
   * علت مرجوعی از فهرست بسته `return.reason_codes` خوانده می‌شود.
   *
   * فهرست باز یعنی «سایر» — و «سایر» یعنی هیچ‌وقت نمی‌فهمیم کالا چرا
   * برگشت خورده. تصمیم داده است نه کد: تغییر فهرست یک `UPDATE` است.
   */
  async assertReasonCode(code: string): Promise<void> {
    const row = await this.#db
      .selectFrom("platform.setting")
      .select("value")
      .where("key", "=", "return.reason_codes")
      .executeTakeFirst();

    const list = Array.isArray(row?.value) ? (row.value as string[]) : [];
    if (list.length > 0 && !list.includes(code)) {
      throw new ReturnError(
        "bad_reason_code",
        `علت «${code}» در فهرست مجاز نیست. علت‌های مجاز: ${list.join("، ")}`,
        422,
      );
    }
  }

  /** روش بازپرداخت باید یک روش پرداخت فعال باشد. */
  async assertRefundMethod(code: string): Promise<{ kind: string }> {
    const row = await this.#db
      .selectFrom("treasury.payment_method")
      .select(["kind", "is_active"])
      .where("code", "=", code)
      .executeTakeFirst();

    if (!row || (!row.is_active && code !== "snappay")) {
      throw new ReturnError("bad_refund_method", `روش بازپرداخت «${code}» فعال نیست`, 422);
    }
    // نسیه و امتیاز، بازپرداخت نیستند — تسویه‌اند. اگر به‌عنوان روش
    // بازپرداخت پذیرفته شوند، `post_return` یک `treasury.payment` نقدی
    // به نامشان می‌سازد و پولی که هرگز از کشو خارج نشده، خارج‌شده
    // ثبت می‌شود.
    if (row.kind === "credit" || row.kind === "points") {
      throw new ReturnError(
        "bad_refund_method",
        `«${code}» روش بازپرداخت نیست. مازاد ارزش کالا خودش به بدهی یا اعتبار مشتری می‌نشیند.`,
        422,
      );
    }
    return { kind: row.kind };
  }

  /**
   * چند ساعت از نهایی‌شدن فاکتور گذشته، و آیا از مهلت گذشته است.
   *
   * **به ساعت، نه روز.** مالک مهلت ۴۸ ساعته خواسته و گرد کردن روز
   * نمی‌تواند بیانش کند: با `window_days = 2`، فاکتور ۷۱ ساعته
   * `floor(71/24) = 2` می‌داد و «داخل مهلت» شمرده می‌شد — یعنی مهلت
   * واقعی ۷۲ ساعت بود، نه ۴۸.
   *
   * ساعت هم `floor` می‌شود، ولی خطایش حداکثر یک ساعت است نه یک روز.
   */
  async returnWindow(
    invoiceId: string,
  ): Promise<{ hoursSince: number; daysSince: number; late: boolean }> {
    const res = await sql<{ hours: number; late: boolean }>`
      SELECT
        floor(extract(epoch FROM (now() - coalesce(i.finalized_at, i.occurred_at))) / 3600)::int
          AS hours,
        now() > coalesce(i.finalized_at, i.occurred_at)
          + make_interval(hours => platform.setting_int('return.window_hours', 48)) AS late
        FROM sales.invoice i WHERE i.id = ${invoiceId}::uuid
    `.execute(this.#db);

    const r = res.rows[0];
    if (!r) throw new ReturnError("invoice_not_found", "فاکتور یافت نشد", 404);
    return {
      hoursSince: r.hours,
      // برای نمایش نگه داشته شده؛ تصمیم «دیرهنگام» فقط به ساعت است.
      daysSince: Math.floor(r.hours / 24),
      late: r.late,
    };
  }

  async createDraft(input: {
    invoiceId: string;
    reasonCode: string;
    reasonNote?: string | undefined;
    refundAmount: bigint;
    refundMethod?: string | undefined;
    refundReference?: string | undefined;
    refundPaymentId?: string | undefined;
    shiftId?: string | undefined;
    lines: ReturnLineInput[];
    actorId: string;
  }): Promise<SaleReturn> {
    if (input.lines.length === 0) {
      throw new ReturnError("no_lines", "برگ مرجوعی بدون قلم ساخته نمی‌شود", 400);
    }
    if (input.refundAmount < 0n) {
      throw new ReturnError("bad_refund", "مبلغ بازپرداخت منفی نمی‌شود", 400);
    }
    await this.assertReasonCode(input.reasonCode);
    if (input.refundMethod === "snappay" && input.refundAmount > 0n && (!input.refundReference?.trim() || !input.refundPaymentId)) {
      throw new ReturnError("refund_reference_required", "پرداخت اصلی اسنپ‌پی و شماره پیگیری برگشت تأییدشده لازم است.", 422);
    }

    const inv = await this.#db
      .selectFrom("sales.invoice")
      .select(["id", "branch_id", "warehouse_id", "status"])
      .where("id", "=", input.invoiceId)
      .executeTakeFirst();
    if (!inv) throw new ReturnError("invoice_not_found", "فاکتور یافت نشد", 404);
    if (!["finalized", "paid", "partially_returned"].includes(inv.status)) {
      throw new ReturnError(
        "invoice_not_returnable",
        `فاکتور در وضعیت «${inv.status}» قابل مرجوعی نیست`,
      );
    }

    // هر سطر باید واقعاً از همین فاکتور باشد. بدون این، یک درخواست
    // دستکاری‌شده می‌توانست سطر فاکتور دیگری را مرجوع کند — و
    // `post_return` هم جلویش را نمی‌گرفت، چون خودش سطرها را از
    // `sale_return_line` می‌خواند نه از فاکتور.
    const validLines = await this.#db
      .selectFrom("sales.invoice_line")
      .select("id")
      .where("invoice_id", "=", input.invoiceId)
      .execute();
    const valid = new Set(validLines.map((l) => l.id));
    const seen = new Set<string>();
    for (const l of input.lines) {
      if (!valid.has(l.invoiceLineId)) {
        throw new ReturnError(
          "line_not_in_invoice",
          "یکی از سطرهای مرجوعی به این فاکتور تعلق ندارد",
          422,
        );
      }
      // دو سطر برای یک قلم، سقف «بیش از باقی‌مانده» را دور می‌زد:
      // `post_return` هر سطر را جدا با `returned_qty` می‌سنجد و
      // `returned_qty` تا پایان حلقه به‌روز نشده است.
      if (seen.has(l.invoiceLineId)) {
        throw new ReturnError(
          "duplicate_line",
          "یک قلم فاکتور دو بار در برگ مرجوعی آمده است",
          422,
        );
      }
      seen.add(l.invoiceLineId);
      if (!(Number(l.qty) > 0)) {
        throw new ReturnError("bad_qty", "تعداد مرجوعی باید بزرگ‌تر از صفر باشد", 400);
      }
    }

    const id = await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, input.actorId);
      const r = await trx
        .insertInto("sales.sale_return")
        .values({
          branch_id: inv.branch_id,
          invoice_id: input.invoiceId,
          warehouse_id: inv.warehouse_id,
          shift_id: input.shiftId ?? null,
          kind: "return",
          net_amount: "0",
          tax_amount: "0",
          refund_amount: serializeMoney(input.refundAmount),
          cogs_amount: "0",
          reason_code: input.reasonCode,
          reason_note: input.reasonNote ?? null,
          status: "draft",
          created_by: input.actorId,
          approved_by: null,
          refund_method: input.refundMethod ?? null,
          refund_reference: input.refundReference?.trim() ?? null,
          refund_payment_id: input.refundPaymentId ?? null,
          receivable_applied: "0",
          credit_applied: "0",
          number: null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      for (const l of input.lines) {
        await trx
          .insertInto("sales.sale_return_line")
          .values({
            return_id: r.id,
            invoice_line_id: l.invoiceLineId,
            qty: l.qty,
            // این پنج عدد را post_return از Snapshot فروش بازمی‌نویسد؛
            // اینجا فقط جای خالی NOT NULL پر می‌شود.
            unit_price: "0",
            net_amount: "0",
            tax_amount: "0",
            unit_cost: "0",
            cogs_amount: "0",
            restock: l.restock ?? true,
            condition: l.condition ?? "sellable",
          })
          .execute();
      }
      return r.id;
    });

    return (await this.byId(id)) as SaleReturn;
  }

  /**
   * ثبت مرجوعی — کالا به انبار برمی‌گردد و سند معکوس زده می‌شود.
   *
   * `trx` از بیرون می‌آید تا با Inbox در یک تراکنش بنشیند.
   */
  async postIn(
    trx: Transaction<Database>,
    returnId: string,
    actorId: string,
  ): Promise<string> {
    await setActor(trx, actorId);
    const r = await sql<{ post_return: string }>`
      SELECT sales.post_return(${returnId}::uuid, ${actorId}::uuid) AS post_return
    `.execute(trx);
    const number = r.rows[0]?.post_return;
    if (!number) throw new ReturnError("post_failed", "ثبت مرجوعی ناموفق بود", 500);
    return number;
  }

  /** ابطال برگ پیش‌نویس — تنها وضعیتی که برگشت‌پذیر است. */
  async cancelDraft(returnId: string, actorId: string): Promise<SaleReturn> {
    const r = await this.byId(returnId);
    if (!r) throw new ReturnError("return_not_found", "برگ مرجوعی یافت نشد", 404);
    if (r.status !== "draft") {
      throw new ReturnError(
        "return_not_draft",
        `برگ مرجوعی در وضعیت «${r.status}» باطل نمی‌شود`,
      );
    }
    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, actorId);
      await trx
        .updateTable("sales.sale_return")
        .set({ status: "cancelled" })
        .where("id", "=", returnId)
        .where("status", "=", "draft")
        .execute();
    });
    return (await this.byId(returnId)) as SaleReturn;
  }
}

/** شکل JSON — پول همیشه رشته. */
export function returnToJson(r: SaleReturn, showCost: boolean) {
  return {
    id: r.id,
    number: r.number,
    invoiceId: r.invoiceId,
    branchId: r.branchId,
    warehouseId: r.warehouseId,
    shiftId: r.shiftId,
    status: r.status,
    reasonCode: r.reasonCode,
    reasonNote: r.reasonNote,
    netAmount: serializeMoney(r.netAmount),
    taxAmount: serializeMoney(r.taxAmount),
    refundAmount: serializeMoney(r.refundAmount),
    refundMethod: r.refundMethod,
    refundReference: r.refundReference,
    refundPaymentId: r.refundPaymentId,
    receivableApplied: serializeMoney(r.receivableApplied),
    creditApplied: serializeMoney(r.creditApplied),
    cogsAmount: showCost ? serializeMoney(r.cogsAmount) : null,
    occurredAt: r.occurredAt.toISOString(),
    lines: r.lines.map((l) => ({
      id: l.id,
      invoiceLineId: l.invoiceLineId,
      qty: l.qty,
      restock: l.restock,
      condition: l.condition,
      netAmount: serializeMoney(l.netAmount),
    })),
  };
}

export function returnableToJson(lines: ReturnableLine[]) {
  return lines.map((l) => ({
    invoiceLineId: l.invoiceLineId,
    variationId: l.variationId,
    soldQty: l.soldQty,
    returnedQty: l.returnedQty,
    remainingQty: l.remainingQty,
    unitPrice: serializeMoney(l.unitPrice),
    netAmount: serializeMoney(l.netAmount),
    returnedNetAmount: serializeMoney(l.returnedNetAmount),
    taxAmount: serializeMoney(l.taxAmount),
    returnedTaxAmount: serializeMoney(l.returnedTaxAmount),
  }));
}
