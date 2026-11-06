/**
 * سفارش خرید — لایه سرویس.
 *
 * ── قاعده‌ای که این فایل عمداً **رعایت نمی‌کند** ────────────────────
 *
 * هیچ سندی نمی‌زند و هیچ حرکت انباری نمی‌سازد — چون سفارش یک **تعهد**
 * است، نه یک رویداد مالی. تا وقتی کالا نیامده، نه دارایی‌ای اضافه شده
 * نه بدهی‌ای.
 *
 * این را صریح می‌نویسیم چون خطای رایجی است: سیستمی که سفارش را در
 * دفتر می‌نشاند، ترازنامه‌ای می‌سازد که کالای نرسیده را دارایی
 * می‌بیند.
 *
 * ── «چقدرش رسیده» را اینجا حساب نمی‌کنیم ───────────────────────────
 *
 * نمای `purchasing.order_progress` آن را از خودِ رسیدهای ثبت‌شده
 * می‌خواند و برگشتی را کم می‌کند. یک ستون مشتق، یا یک جمعِ دوباره در
 * TypeScript، جایی است که داده از خودش جدا می‌افتد.
 */
import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { Db } from "../db/client.ts";
import type { Database } from "../db/types.ts";
import { PurchasingError } from "./receipt.ts";
import { setActor } from "../lib/idempotency.ts";

export interface OrderLineJson {
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
  /** از نمای `order_progress` — رسیده منهای برگشتی. */
  receivedQty: string;
  remainingQty: string;
  /** بیش‌تحویل بسته نیست، ولی دیده می‌شود. */
  overQty: string;
}

export interface OrderJson {
  id: string;
  number: string | null;
  status: string;
  branchId: string;
  supplierId: string;
  supplierName: string;
  warehouseId: string;
  warehouseName: string;
  expectedAt: string | null;
  note: string | null;
  createdAt: string;
  sentAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  /** جمع توافقی سفارش — یک عدد برای مقایسه، نه یک بدهی. */
  orderedAmount: string;
  lines: OrderLineJson[];
}

export interface OrderSummaryJson {
  id: string;
  number: string | null;
  status: string;
  supplierName: string;
  expectedAt: string | null;
  createdAt: string;
  lineCount: number;
  /** چند سطر هنوز کامل نرسیده. */
  pendingLines: number;
  /**
   * طرح ۱۰ — جمع سطرهای همین سفارش از نمای `order_progress`، همه در SQL:
   * سفارش‌داده، برآورده (رسیده منهای برگشتی، حداکثر تا سفارش هر سطر)،
   * مانده و بیش‌تحویل. بیش‌تحویل جدا جمع می‌شود و هرگز «مانده» را منفی
   * یا «برآورده» را بیش از سفارش نمی‌کند.
   */
  orderedQty: string;
  fulfilledQty: string;
  remainingQty: string;
  overQty: string;
  /** جمع توافقی — یک عدد برای مقایسه، نه یک بدهی. */
  orderedAmount: string;
  closeReason: string | null;
}

export class PurchaseOrderService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async list(opts: {
    branchIds: string[] | "all";
    status?: string | undefined;
    limit: number;
  }): Promise<OrderSummaryJson[]> {
    if (opts.branchIds !== "all" && opts.branchIds.length === 0) return [];

    let q = this.#db
      .selectFrom("purchasing.purchase_order as o")
      .innerJoin("purchasing.supplier as s", "s.id", "o.supplier_id")
      // یک تعریف: همان نمایی که جزئیات سفارش می‌خواند. جمع پولی با round
      // صریح هر سطر، همان `line_amount` جزئیات.
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom("purchasing.order_progress as p")
            .whereRef("p.order_id", "=", "o.id")
            .select([
              sql<string>`count(*)`.as("line_count"),
              sql<string>`count(*) FILTER (WHERE p.remaining_qty > 0)`.as("pending_lines"),
              sql<string>`coalesce(sum(p.ordered_qty), 0)::platform.qty`.as("ordered_qty"),
              sql<string>`coalesce(sum(p.ordered_qty - p.remaining_qty), 0)::platform.qty`.as("fulfilled_qty"),
              sql<string>`coalesce(sum(p.remaining_qty), 0)::platform.qty`.as("remaining_qty"),
              sql<string>`coalesce(sum(p.over_qty), 0)::platform.qty`.as("over_qty"),
              sql<string>`coalesce(sum(round(p.ordered_qty * p.ordered_unit_price)), 0)::platform.money`.as("ordered_amount"),
            ])
            .as("p"),
        (join) => join.onTrue(),
      )
      .select([
        "o.id",
        "o.number",
        "o.status",
        "o.expected_at",
        "o.created_at",
        "o.close_reason",
        "s.name as supplier_name",
        "p.line_count",
        "p.pending_lines",
        "p.ordered_qty",
        "p.fulfilled_qty",
        "p.remaining_qty",
        "p.over_qty",
        "p.ordered_amount",
      ])
      .orderBy("o.created_at", "desc")
      .limit(opts.limit);

    if (opts.branchIds !== "all") q = q.where("o.branch_id", "in", opts.branchIds);
    if (opts.status) q = q.where("o.status", "=", opts.status);

    const rows = await q.execute();
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      status: r.status,
      supplierName: r.supplier_name,
      expectedAt: r.expected_at,
      createdAt: new Date(r.created_at).toISOString(),
      lineCount: Number(r.line_count ?? 0),
      pendingLines: Number(r.pending_lines ?? 0),
      orderedQty: r.ordered_qty ?? "0.000",
      fulfilledQty: r.fulfilled_qty ?? "0.000",
      remainingQty: r.remaining_qty ?? "0.000",
      overQty: r.over_qty ?? "0.000",
      orderedAmount: r.ordered_amount ?? "0",
      closeReason: r.close_reason,
    }));
  }

  async get(id: string, branchIds: string[] | "all"): Promise<OrderJson | null> {
    const head = await this.#db
      .selectFrom("purchasing.purchase_order as o")
      .innerJoin("purchasing.supplier as s", "s.id", "o.supplier_id")
      .innerJoin("inventory.warehouse as w", "w.id", "o.warehouse_id")
      .select([
        "o.id",
        "o.number",
        "o.status",
        "o.branch_id",
        "o.supplier_id",
        "o.warehouse_id",
        "o.expected_at",
        "o.note",
        "o.created_at",
        "o.sent_at",
        "o.closed_at",
        "o.close_reason",
        "s.name as supplier_name",
        "w.name as warehouse_name",
      ])
      .where("o.id", "=", id)
      .executeTakeFirst();

    if (!head) return null;
    if (branchIds !== "all" && !branchIds.includes(head.branch_id)) return null;

    const lines = await this.#db
      .selectFrom("purchasing.purchase_order_line as l")
      .innerJoin("purchasing.order_progress as p", "p.order_line_id", "l.id")
      .innerJoin("catalog.variation as v", "v.id", "l.variation_id")
      .innerJoin("catalog.product as pr", "pr.id", "v.product_id")
      .select([
        "l.id",
        "l.variation_id",
        "l.qty",
        "l.unit_price",
        "p.received_qty",
        "p.remaining_qty",
        "p.over_qty",
        "v.sku",
        "v.barcode",
        "v.color",
        "v.size",
        "pr.name_internal as product_name",
        // محاسبه پولی در SQL، نه در TypeScript: تعداد اعشاری با تقسیم
        // صحیح bigint نتیجه‌ای می‌دهد که با sum() دیتابیس یکی نیست.
        sql<string>`round(l.qty * l.unit_price)`.as("line_amount"),
        // جمع هم در SQL، همان تعریف فهرست سفارش‌ها؛ نه جمع bigint در TypeScript.
        sql<string>`sum(round(l.qty * l.unit_price)) OVER ()`.as("ordered_amount"),
      ])
      .where("l.order_id", "=", id)
      .orderBy("l.id")
      .execute();

    return {
      id: head.id,
      number: head.number,
      status: head.status,
      branchId: head.branch_id,
      supplierId: head.supplier_id,
      supplierName: head.supplier_name,
      warehouseId: head.warehouse_id,
      warehouseName: head.warehouse_name,
      expectedAt: head.expected_at,
      note: head.note,
      createdAt: new Date(head.created_at).toISOString(),
      sentAt: head.sent_at === null ? null : new Date(head.sent_at).toISOString(),
      closedAt: head.closed_at === null ? null : new Date(head.closed_at).toISOString(),
      closeReason: head.close_reason,
      orderedAmount: lines[0]?.ordered_amount ?? "0",
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
        receivedQty: l.received_qty,
        remainingQty: l.remaining_qty,
        overQty: l.over_qty,
      })),
    };
  }

  async createDraft(
    trx: Transaction<Database>,
    input: {
      branchId: string;
      supplierId: string;
      warehouseId: string;
      expectedAt?: string | undefined;
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
      .insertInto("purchasing.purchase_order")
      .values({
        number: null,
        branch_id: input.branchId,
        supplier_id: input.supplierId,
        warehouse_id: input.warehouseId,
        expected_at: input.expectedAt ?? null,
        note: input.note ?? null,
        created_by: input.actorId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    return row.id;
  }

  /**
   * افزودن یا اصلاح یک قلم — **مطلق**، مثل شمارش.
   *
   * سفارش یک فهرست است، نه یک سبد: «۱۰ تا از این» یعنی همان ۱۰ تا،
   * نه ۱۰ تای دیگر روی قبلی‌ها.
   */
  async setLine(
    trx: Transaction<Database>,
    input: {
      orderId: string;
      variationId: string;
      qty: string;
      unitPrice: bigint;
      actorId: string;
    },
  ): Promise<string> {
    await setActor(trx, input.actorId);
    await this.#assertDraft(trx, input.orderId);

    const row = await trx
      .insertInto("purchasing.purchase_order_line")
      .values({
        order_id: input.orderId,
        variation_id: input.variationId,
        qty: input.qty,
        unit_price: input.unitPrice.toString(),
      })
      .onConflict((oc) =>
        oc.columns(["order_id", "variation_id"]).doUpdateSet({
          qty: input.qty,
          unit_price: input.unitPrice.toString(),
        }),
      )
      .returning("id")
      .executeTakeFirstOrThrow();

    return row.id;
  }

  async removeLine(
    trx: Transaction<Database>,
    orderId: string,
    lineId: string,
    actorId: string,
  ): Promise<void> {
    await setActor(trx, actorId);
    await this.#assertDraft(trx, orderId);
    const res = await trx
      .deleteFrom("purchasing.purchase_order_line")
      .where("id", "=", lineId)
      .where("order_id", "=", orderId)
      .executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) {
      throw new PurchasingError("line_not_found", "این قلم در سفارش نیست", 404);
    }
  }

  /** فرستادن — شماره می‌گیرد. هیچ سندی و هیچ حرکتی. */
  async send(trx: Transaction<Database>, orderId: string, actorId: string): Promise<string> {
    await setActor(trx, actorId);
    const r = await sql<{ number: string }>`
      SELECT purchasing.send_purchase_order(${orderId}::uuid, ${actorId}::uuid) AS number
    `.execute(trx);
    const number = r.rows[0]?.number;
    if (!number) throw new PurchasingError("send_failed", "فرستادن سفارش نتیجه‌ای برنگرداند", 500);
    return number;
  }

  async close(
    trx: Transaction<Database>,
    orderId: string,
    reason: string | null,
    actorId: string,
  ): Promise<void> {
    await setActor(trx, actorId);
    await sql`
      SELECT purchasing.close_purchase_order(
        ${orderId}::uuid, ${reason}::text, ${actorId}::uuid)
    `.execute(trx);
  }

  /** سفارش فرستاده‌شده ویرایش نمی‌شود — تأمین‌کننده نسخه‌ای دستش دارد. */
  async #assertDraft(trx: Transaction<Database>, orderId: string): Promise<void> {
    const r = await sql<{ status: string }>`
      SELECT status FROM purchasing.purchase_order WHERE id = ${orderId}::uuid FOR UPDATE
    `.execute(trx);
    const row = r.rows[0];
    if (!row) throw new PurchasingError("order_not_found", "سفارش خرید یافت نشد", 404);
    if (row.status !== "draft") {
      throw new PurchasingError(
        "order_sent",
        "سفارش فرستاده‌شده ویرایش نمی‌شود — تأمین‌کننده نسخه‌ای از آن دارد",
        409,
      );
    }
  }
}
