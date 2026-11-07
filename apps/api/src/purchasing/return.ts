/**
 * برگشت از خرید — لایه سرویس.
 *
 * ── دو مبلغ که یکی نیستند ──────────────────────────────────────────
 *
 * **بهای فاکتور** آنچه تأمین‌کننده گرفته (`unit_price` سطر رسید).
 * بدهی‌اش دقیقاً به همین اندازه کم می‌شود.
 *
 * **ارزش دفتری** آنچه کالا در انبار ما ارزیده (`landed_unit_cost`):
 * بهای فاکتور به‌علاوه سهمش از هزینه حمل.
 *
 * تفاوتشان حملی است که برای کالای پس‌فرستاده پرداختیم و باربری
 * برنمی‌گرداند — یک زیان واقعی با سرفصل خودش (۵۱۰۲).
 *
 * ── قیمت و بها را این لایه حساب نمی‌کند ────────────────────────────
 *
 * هر دو Snapshot سطر رسیدند و `post_purchase_return()` می‌نویسدشان.
 * حساب‌کردنشان اینجا یعنی دو تعریف — و در روش «آخرین قیمت خرید»،
 * میانگین جاری با بهای همان رسید فرق دارد.
 */
import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { Db } from "../db/client.ts";
import type { Database } from "../db/types.ts";
import { PurchasingError } from "./receipt.ts";
import { setActor } from "../lib/idempotency.ts";

/** یک سطر رسید، از دید «چقدرش هنوز قابل برگشت است». */
export interface ReturnableLineJson {
  receiptLineId: string;
  variationId: string;
  sku: string;
  productName: string;
  color: string | null;
  size: string | null;
  receivedQty: string;
  returnedQty: string;
  remainingQty: string;
  unitPrice: string;
  /** بهای دفتری هر واحد — کالا با همین نرخ خارج می‌شود، نه میانگین جاری. */
  landedUnitCost: string;
}

export interface ReturnableJson {
  receiptId: string;
  number: string | null;
  supplierName: string;
  warehouseId: string;
  warehouseName: string;
  occurredAt: string;
  lines: ReturnableLineJson[];
}

export interface PurchaseReturnLineJson {
  id: string;
  receiptLineId: string;
  sku: string;
  productName: string;
  color: string | null;
  size: string | null;
  qty: string;
  unitPrice: string | null;
  unitCost: string | null;
  goodsAmount: string | null;
  costAmount: string | null;
}

export interface PurchaseReturnJson {
  id: string;
  number: string | null;
  status: string;
  branchId: string;
  receiptId: string;
  receiptNumber: string | null;
  supplierName: string;
  warehouseName: string;
  reasonCode: string;
  reasonNote: string | null;
  occurredAt: string;
  postedAt: string | null;
  goodsAmount: string;
  costAmount: string;
  taxAmount: string;
  /** حملِ کالای پس‌فرستاده — پرداختیم و برنمی‌گردد. */
  chargeLoss: string;
  lines: PurchaseReturnLineJson[];
}

/** یک سطر فهرست برگشت از خرید (طرح ۱۰) — همان چهار مبلغی که `post_purchase_return()` نوشته. */
export interface PurchaseReturnSummaryJson {
  id: string;
  number: string | null;
  status: string;
  occurredAt: string;
  receiptNumber: string | null;
  supplierName: string;
  warehouseName: string;
  /** نخستین کالا («نام · رنگ · سایز») و شمار سطرهای دیگر، فقط برای خواندن. */
  firstItem: string | null;
  lineCount: number;
  totalQty: string;
  goodsAmount: string;
  costAmount: string;
  taxAmount: string;
  chargeLoss: string;
}

export class PurchaseReturnService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * چه چیزی از یک رسید هنوز قابل برگشت است.
   *
   * نقطه شروع هر برگشت: انباردار رسید را باز می‌کند و می‌بیند از هر
   * سطر چقدر باقی مانده. `remainingQty` از خودِ سرور می‌آید، نه از
   * تفریق در مرورگر — دو تعریف از یک عدد، دیر یا زود از هم جدا
   * می‌افتند.
   */
  async returnable(
    receiptId: string,
    branchIds: string[] | "all",
  ): Promise<ReturnableJson | null> {
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
        "r.occurred_at",
        "s.name as supplier_name",
        "w.name as warehouse_name",
      ])
      .where("r.id", "=", receiptId)
      .executeTakeFirst();

    if (!head) return null;
    if (branchIds !== "all" && !branchIds.includes(head.branch_id)) return null;
    if (head.status !== "posted") {
      throw new PurchasingError(
        "receipt_not_posted",
        "رسید خرید هنوز ثبت نشده — چیزی نیامده که برگردد",
        422,
      );
    }

    const lines = await this.#db
      .selectFrom("purchasing.receipt_line as l")
      .innerJoin("catalog.variation as v", "v.id", "l.variation_id")
      .innerJoin("catalog.product as p", "p.id", "v.product_id")
      .select([
        "l.id",
        "l.variation_id",
        "l.qty",
        "l.returned_qty",
        "l.unit_price",
        "l.landed_unit_cost",
        "v.sku",
        "v.color",
        "v.size",
        "p.name_internal as product_name",
        sql<string>`l.qty - l.returned_qty`.as("remaining_qty"),
      ])
      .where("l.receipt_id", "=", receiptId)
      .orderBy("l.id")
      .execute();

    return {
      receiptId: head.id,
      number: head.number,
      supplierName: head.supplier_name,
      warehouseId: head.warehouse_id,
      warehouseName: head.warehouse_name,
      occurredAt: new Date(head.occurred_at).toISOString(),
      lines: lines.map((l) => ({
        receiptLineId: l.id,
        variationId: l.variation_id,
        sku: l.sku,
        productName: l.product_name,
        color: l.color,
        size: l.size,
        receivedQty: l.qty,
        returnedQty: l.returned_qty,
        remainingQty: l.remaining_qty,
        unitPrice: l.unit_price,
        landedUnitCost: l.landed_unit_cost,
      })),
    };
  }

  /**
   * فهرست برگه‌ها، تازه‌ترین اول، در دامنهٔ شعبه. مبلغ‌ها همان ستون‌هایی‌اند که تابع ثبت نوشته؛
   * این لایه هیچ مبلغی حساب نمی‌کند (جمع تعداد فقط شمارش است).
   */
  async list(branchIds: string[] | "all", limit: number): Promise<PurchaseReturnSummaryJson[]> {
    if (branchIds !== "all" && branchIds.length === 0) return [];
    let q = this.#db
      .selectFrom("purchasing.purchase_return as pr")
      .innerJoin("purchasing.receipt as r", "r.id", "pr.receipt_id")
      .innerJoin("purchasing.supplier as s", "s.id", "r.supplier_id")
      .innerJoin("inventory.warehouse as w", "w.id", "pr.warehouse_id")
      .select([
        "pr.id", "pr.number", "pr.status", "pr.occurred_at", "r.number as receipt_number",
        "s.name as supplier_name", "w.name as warehouse_name",
        sql<string>`pr.goods_amount::text`.as("goods_amount"),
        sql<string>`pr.cost_amount::text`.as("cost_amount"),
        sql<string>`pr.tax_amount::text`.as("tax_amount"),
        sql<string>`pr.charge_loss::text`.as("charge_loss"),
        sql<string>`(SELECT count(*) FROM purchasing.purchase_return_line l WHERE l.return_id = pr.id)`.as("line_count"),
        sql<string>`(SELECT coalesce(sum(l.qty), 0)::text FROM purchasing.purchase_return_line l WHERE l.return_id = pr.id)`.as("total_qty"),
        sql<string | null>`(SELECT concat_ws(' · ', p.name_internal, v.color, v.size)
                              FROM purchasing.purchase_return_line l
                              JOIN purchasing.receipt_line rl ON rl.id = l.receipt_line_id
                              JOIN catalog.variation v ON v.id = rl.variation_id
                              JOIN catalog.product p ON p.id = v.product_id
                             WHERE l.return_id = pr.id ORDER BY l.id LIMIT 1)`.as("first_item"),
      ])
      .orderBy("pr.occurred_at", "desc")
      .orderBy("pr.id", "desc")
      .limit(limit);
    if (branchIds !== "all") q = q.where("pr.branch_id", "in", branchIds);
    const rows = await q.execute();
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      status: r.status,
      occurredAt: new Date(r.occurred_at).toISOString(),
      receiptNumber: r.receipt_number,
      supplierName: r.supplier_name,
      warehouseName: r.warehouse_name,
      firstItem: r.first_item,
      lineCount: Number(r.line_count),
      totalQty: r.total_qty,
      goodsAmount: r.goods_amount,
      costAmount: r.cost_amount,
      taxAmount: r.tax_amount,
      chargeLoss: r.charge_loss,
    }));
  }

  async get(id: string, branchIds: string[] | "all"): Promise<PurchaseReturnJson | null> {
    const head = await this.#db
      .selectFrom("purchasing.purchase_return as pr")
      .innerJoin("purchasing.receipt as r", "r.id", "pr.receipt_id")
      .innerJoin("purchasing.supplier as s", "s.id", "r.supplier_id")
      .innerJoin("inventory.warehouse as w", "w.id", "pr.warehouse_id")
      .select([
        "pr.id",
        "pr.number",
        "pr.status",
        "pr.branch_id",
        "pr.receipt_id",
        "pr.reason_code",
        "pr.reason_note",
        "pr.occurred_at",
        "pr.posted_at",
        "pr.goods_amount",
        "pr.cost_amount",
        "pr.tax_amount",
        "pr.charge_loss",
        "r.number as receipt_number",
        "s.name as supplier_name",
        "w.name as warehouse_name",
      ])
      .where("pr.id", "=", id)
      .executeTakeFirst();

    if (!head) return null;
    if (branchIds !== "all" && !branchIds.includes(head.branch_id)) return null;

    const lines = await this.#db
      .selectFrom("purchasing.purchase_return_line as prl")
      .innerJoin("purchasing.receipt_line as rl", "rl.id", "prl.receipt_line_id")
      .innerJoin("catalog.variation as v", "v.id", "rl.variation_id")
      .innerJoin("catalog.product as p", "p.id", "v.product_id")
      .select([
        "prl.id",
        "prl.receipt_line_id",
        "prl.qty",
        "prl.unit_price",
        "prl.unit_cost",
        "prl.goods_amount",
        "prl.cost_amount",
        "v.sku",
        "v.color",
        "v.size",
        "p.name_internal as product_name",
      ])
      .where("prl.return_id", "=", id)
      .orderBy("prl.id")
      .execute();

    return {
      id: head.id,
      number: head.number,
      status: head.status,
      branchId: head.branch_id,
      receiptId: head.receipt_id,
      receiptNumber: head.receipt_number,
      supplierName: head.supplier_name,
      warehouseName: head.warehouse_name,
      reasonCode: head.reason_code,
      reasonNote: head.reason_note,
      occurredAt: new Date(head.occurred_at).toISOString(),
      postedAt: head.posted_at === null ? null : new Date(head.posted_at).toISOString(),
      goodsAmount: head.goods_amount,
      costAmount: head.cost_amount,
      taxAmount: head.tax_amount,
      chargeLoss: head.charge_loss,
      lines: lines.map((l) => ({
        id: l.id,
        receiptLineId: l.receipt_line_id,
        sku: l.sku,
        productName: l.product_name,
        color: l.color,
        size: l.size,
        qty: l.qty,
        unitPrice: l.unit_price,
        unitCost: l.unit_cost,
        goodsAmount: l.goods_amount,
        costAmount: l.cost_amount,
      })),
    };
  }

  /**
   * برگه و سطرهایش با هم — و عمداً با هم.
   *
   * برخلاف رسید خرید، برگشت یک سبد تدریجی نیست: انباردار رسید را
   * می‌بیند، تیک می‌زند، و می‌فرستد. یک پیش‌نویس نیمه‌کاره اینجا فقط
   * یک برگه رها می‌سازد که هیچ‌کس دنبالش نمی‌رود.
   */
  async createDraft(
    trx: Transaction<Database>,
    input: {
      branchId: string;
      receiptId: string;
      warehouseId: string;
      reasonCode: string;
      reasonNote?: string | undefined;
      lines: { receiptLineId: string; qty: string }[];
      actorId: string;
    },
  ): Promise<string> {
    await setActor(trx, input.actorId);

    const row = await trx
      .insertInto("purchasing.purchase_return")
      .values({
        number: null,
        branch_id: input.branchId,
        receipt_id: input.receiptId,
        warehouse_id: input.warehouseId,
        reason_code: input.reasonCode,
        reason_note: input.reasonNote ?? null,
        created_by: input.actorId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    // سطرها باید واقعاً به همان رسید بچسبند. بدون این بررسی، یک
    // `receiptLineId` از رسید دیگری می‌توانست بهای آن رسید را
    // برگرداند در حالی که بدهی این تأمین‌کننده کم می‌شد.
    const valid = await trx
      .selectFrom("purchasing.receipt_line")
      .select("id")
      .where("receipt_id", "=", input.receiptId)
      .execute();
    const allowed = new Set(valid.map((v) => v.id));

    for (const line of input.lines) {
      if (!allowed.has(line.receiptLineId)) {
        throw new PurchasingError(
          "line_not_in_receipt",
          "یکی از اقلام به این رسید تعلق ندارد",
          422,
        );
      }
    }

    await trx
      .insertInto("purchasing.purchase_return_line")
      .values(
        input.lines.map((l) => ({
          return_id: row.id,
          receipt_line_id: l.receiptLineId,
          qty: l.qty,
          unit_price: null,
          unit_cost: null,
          goods_amount: null,
          cost_amount: null,
        })),
      )
      .execute();

    return row.id;
  }

  /** ثبت — کالا از انبار خارج و بدهی تأمین‌کننده کم می‌شود. */
  async post(
    trx: Transaction<Database>,
    returnId: string,
    actorId: string,
  ): Promise<string> {
    await setActor(trx, actorId);
    const r = await sql<{ entry: string }>`
      SELECT purchasing.post_purchase_return(${returnId}::uuid, ${actorId}::uuid) AS entry
    `.execute(trx);
    const entry = r.rows[0]?.entry;
    if (!entry) throw new PurchasingError("post_failed", "ثبت برگشت نتیجه‌ای برنگرداند", 500);
    return entry;
  }
}
