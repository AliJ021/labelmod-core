/**
 * انبارگردانی — لایه سرویس.
 *
 * ── قاعده‌ای که این فایل عمداً **نمی‌داند** ─────────────────────────
 *
 * موجودی سیستم را این لایه نمی‌خواند و نباید بخواند.
 * `inventory.post_stock_count()` آن را در لحظه ثبت و روی سطر قفل‌شده
 * می‌خواند. اگر اینجا هم خوانده می‌شد، دو تعریف از یک عدد داشتیم و
 * آنکه در فاصله میان دو خواندن عوض می‌شود، همان است که کسری کاذب
 * می‌سازد.
 *
 * ما `system_qty` را فقط برای **نمایش** برمی‌گردانیم، و فقط پس از
 * ثبت — پیش از آن `null` است و همان `null` را نشان می‌دهیم.
 *
 * ── چرا «تفاوت پیش‌بینی‌شده» نداریم ────────────────────────────────
 *
 * یک ستون «تفاوت احتمالی» روی پیش‌نویس، عددی است که تا لحظه ثبت
 * تغییر می‌کند. انباردار رویش تصمیم می‌گیرد و بعد عدد دیگری ثبت
 * می‌شود. بهتر است اصلاً نباشد.
 */
import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { Db } from "../db/client.ts";
import type { Database } from "../db/types.ts";
import { setActor } from "../lib/idempotency.ts";

export class StockCountError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "StockCountError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface StockCountLineJson {
  id: string;
  variationId: string;
  sku: string;
  barcode: string | null;
  productName: string;
  color: string | null;
  size: string | null;
  countedQty: string;
  /** تا لحظه ثبت `null` — عمداً، نه چون هنوز حساب نشده. */
  systemQty: string | null;
  diffQty: string | null;
  unitCost: string | null;
  valueDelta: string | null;
}

export interface StockCountJson {
  id: string;
  number: string | null;
  status: string;
  branchId: string;
  warehouseId: string;
  warehouseName: string;
  startedAt: string;
  postedAt: string | null;
  note: string | null;
  lines: StockCountLineJson[];
}

export interface StockCountSummaryJson {
  id: string;
  number: string | null;
  status: string;
  warehouseName: string;
  startedAt: string;
  lineCount: number;
  /** پس از ثبت: چند سطر واقعاً تفاوت داشت. پیش از آن صفر. */
  diffCount: number;
}

export class StockCountService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async list(opts: {
    branchIds: string[] | "all";
    status?: string | undefined;
    limit: number;
  }): Promise<StockCountSummaryJson[]> {
    if (opts.branchIds !== "all" && opts.branchIds.length === 0) return [];

    let q = this.#db
      .selectFrom("inventory.stock_count as c")
      .innerJoin("inventory.warehouse as w", "w.id", "c.warehouse_id")
      .select([
        "c.id",
        "c.number",
        "c.status",
        "c.started_at",
        "w.name as warehouse_name",
        sql<string>`(SELECT count(*) FROM inventory.stock_count_line l
                      WHERE l.count_id = c.id)`.as("line_count"),
        sql<string>`(SELECT count(*) FROM inventory.stock_count_line l
                      WHERE l.count_id = c.id AND l.diff_qty IS NOT NULL AND l.diff_qty <> 0)`.as(
          "diff_count",
        ),
      ])
      .orderBy("c.started_at", "desc")
      .orderBy("c.id", "desc")
      .limit(opts.limit);

    if (opts.branchIds !== "all") q = q.where("c.branch_id", "in", opts.branchIds);
    if (opts.status) q = q.where("c.status", "=", opts.status);

    const rows = await q.execute();
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      status: r.status,
      warehouseName: r.warehouse_name,
      startedAt: new Date(r.started_at).toISOString(),
      lineCount: Number(r.line_count),
      diffCount: Number(r.diff_count),
    }));
  }

  /** `null` یعنی نبود یا بیرون از دامنه شعبه کاربر. */
  async get(id: string, branchIds: string[] | "all"): Promise<StockCountJson | null> {
    const head = await this.#db
      .selectFrom("inventory.stock_count as c")
      .innerJoin("inventory.warehouse as w", "w.id", "c.warehouse_id")
      .select([
        "c.id",
        "c.number",
        "c.status",
        "c.branch_id",
        "c.warehouse_id",
        "c.started_at",
        "c.posted_at",
        "c.note",
        "w.name as warehouse_name",
      ])
      .where("c.id", "=", id)
      .executeTakeFirst();

    if (!head) return null;
    if (branchIds !== "all" && !branchIds.includes(head.branch_id)) return null;

    const lines = await this.#db
      .selectFrom("inventory.stock_count_line as l")
      .innerJoin("catalog.variation as v", "v.id", "l.variation_id")
      .innerJoin("catalog.product as p", "p.id", "v.product_id")
      .select([
        "l.id",
        "l.variation_id",
        "l.counted_qty",
        "l.system_qty",
        "l.diff_qty",
        "l.unit_cost",
        "l.value_delta",
        "v.sku",
        "v.barcode",
        "v.color",
        "v.size",
        "p.name_internal as product_name",
      ])
      .where("l.count_id", "=", id)
      .orderBy("l.id")
      .execute();

    return {
      id: head.id,
      number: head.number,
      status: head.status,
      branchId: head.branch_id,
      warehouseId: head.warehouse_id,
      warehouseName: head.warehouse_name,
      startedAt: new Date(head.started_at).toISOString(),
      postedAt: head.posted_at === null ? null : new Date(head.posted_at).toISOString(),
      note: head.note,
      lines: lines.map((l) => ({
        id: l.id,
        variationId: l.variation_id,
        sku: l.sku,
        barcode: l.barcode,
        productName: l.product_name,
        color: l.color,
        size: l.size,
        countedQty: l.counted_qty,
        systemQty: l.system_qty,
        diffQty: l.diff_qty,
        unitCost: l.unit_cost,
        valueDelta: l.value_delta,
      })),
    };
  }

  async createDraft(
    trx: Transaction<Database>,
    input: { branchId: string; warehouseId: string; note?: string | undefined; actorId: string },
  ): Promise<string> {
    await setActor(trx, input.actorId);

    const row = await trx
      .insertInto("inventory.stock_count")
      .values({
        number: null,
        branch_id: input.branchId,
        warehouse_id: input.warehouseId,
        created_by: input.actorId,
        note: input.note ?? null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    return row.id;
  }

  /**
   * شمارش یک کالا — **مطلق**، نه افزایشی.
   *
   * اسکن دوباره همان کالا یعنی «دوباره شمردم و این عدد است»، نه
   * «یکی دیگر پیدا کردم». انباردار روی برگه عدد نهایی هر ردیف را
   * می‌نویسد؛ اگر اسکن دوم جمع می‌شد، هر بازبینی عدد را دو برابر
   * می‌کرد.
   */
  async setLine(
    trx: Transaction<Database>,
    input: { countId: string; variationId: string; countedQty: string; actorId: string },
  ): Promise<string> {
    await setActor(trx, input.actorId);
    await this.#assertDraft(trx, input.countId);

    const row = await trx
      .insertInto("inventory.stock_count_line")
      .values({
        count_id: input.countId,
        variation_id: input.variationId,
        counted_qty: input.countedQty,
        system_qty: null,
        diff_qty: null,
        unit_cost: null,
        value_delta: null,
      })
      .onConflict((oc) =>
        oc.columns(["count_id", "variation_id"]).doUpdateSet({ counted_qty: input.countedQty }),
      )
      .returning("id")
      .executeTakeFirstOrThrow();

    return row.id;
  }

  async removeLine(
    trx: Transaction<Database>,
    countId: string,
    lineId: string,
    actorId: string,
  ): Promise<void> {
    await setActor(trx, actorId);
    await this.#assertDraft(trx, countId);
    const res = await trx
      .deleteFrom("inventory.stock_count_line")
      .where("id", "=", lineId)
      .where("count_id", "=", countId)
      .executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) {
      throw new StockCountError("line_not_found", "این سطر در برگه نیست", 404);
    }
  }

  /**
   * ثبت — تعدیل موجودی و سند کسری/اضافه.
   *
   * `null` برگشتی یعنی سندی لازم نبود: کسری و اضافه هم را خنثی
   * کرده‌اند. برگه ثبت شده و حرکت‌ها ثبت شده‌اند.
   */
  async post(
    trx: Transaction<Database>,
    countId: string,
    actorId: string,
  ): Promise<string | null> {
    await setActor(trx, actorId);
    const r = await sql<{ entry: string | null }>`
      SELECT inventory.post_stock_count(${countId}::uuid, ${actorId}::uuid) AS entry
    `.execute(trx);
    return r.rows[0]?.entry ?? null;
  }

  async cancelDraft(
    trx: Transaction<Database>,
    countId: string,
    actorId: string,
  ): Promise<void> {
    await setActor(trx, actorId);
    await this.#assertDraft(trx, countId);
    await trx
      .updateTable("inventory.stock_count")
      .set({ status: "cancelled" })
      .where("id", "=", countId)
      .execute();
  }

  /** برگه ثبت‌شده تغییر نمی‌کند. قفل روی سطر، نه فقط یک خواندن. */
  async #assertDraft(trx: Transaction<Database>, countId: string): Promise<void> {
    const r = await sql<{ status: string }>`
      SELECT status FROM inventory.stock_count WHERE id = ${countId}::uuid FOR UPDATE
    `.execute(trx);
    const row = r.rows[0];
    if (!row) throw new StockCountError("count_not_found", "برگه انبارگردانی یافت نشد", 404);
    if (row.status === "posted") {
      throw new StockCountError("count_posted", "برگه ثبت‌شده تغییر نمی‌کند", 409);
    }
    if (row.status === "cancelled") {
      throw new StockCountError("count_cancelled", "این برگه باطل شده است", 409);
    }
  }
}
