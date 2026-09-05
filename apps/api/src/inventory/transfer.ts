/**
 * انتقال بین انبارها.
 *
 * `stock_movement.kind` از روز اول `transfer_in` و `transfer_out` را
 * داشت و هیچ‌چیز آن‌ها را نمی‌نوشت. جابه‌جایی کالا میان قفسه فروشگاه و
 * انبار پشتیبان یا اصلاً ثبت نمی‌شد، یا با دو «تعدیل» دستی که هیچ‌کس
 * بعداً نمی‌فهمید به هم مربوط بوده‌اند.
 *
 * ── این فایل هیچ عدد مالی حساب نمی‌کند ────────────────────────────
 *
 * بهای خروج را `apply_movement` تعیین می‌کند و ورود با **همان ارزش**
 * انجام می‌شود — هر دو داخل `inventory.post_transfer()`. اگر اینجا
 * دوباره حساب می‌شد، دو مرجع برای یک عدد داشتیم و باقی‌ماندهٔ گرد
 * کردن از جمع ارزش موجودی گم می‌شد.
 *
 * ── دامنه شعبه اینجا نیست، ولی **هر دو** انبار مهم‌اند ─────────────
 *
 * دیتابیس نمی‌داند کدام کاربر به کدام انبار دسترسی دارد. لایه مسیر
 * باید مبدأ **و** مقصد را بسنجد: انتقالی که فقط مبدأش سنجیده شود، راهی
 * است برای بیرون‌بردن کالا به انباری که کاربر نمی‌بیند.
 */
import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { Db } from "../db/client.ts";
import type { Database } from "../db/types.ts";
import { parseMoney, serializeMoney } from "../lib/money.ts";
import { setActor } from "../lib/idempotency.ts";

export class TransferError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode = 409) {
    super(message);
    this.name = "TransferError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface TransferLine {
  id: string;
  variationId: string;
  sku: string;
  productName: string;
  color: string;
  size: string;
  qty: string;
  /** تا لحظه ثبت `null` — بها در لحظه خروج معلوم می‌شود. */
  unitCost: string | null;
  valueDelta: string | null;
}

export interface Transfer {
  id: string;
  number: string | null;
  branchId: string;
  fromWarehouseId: string;
  fromWarehouseName: string;
  toWarehouseId: string;
  toWarehouseName: string;
  status: string;
  occurredAt: string;
  postedAt: string | null;
  note: string | null;
  createdByName: string | null;
  lineCount: number;
  totalQty: string;
  totalValue: string;
  lines: TransferLine[];
}

interface HeadRow {
  id: string;
  number: string | null;
  branch_id: string;
  status: string;
  occurred_at: Date;
  posted_at: Date | null;
  note: string | null;
  from_warehouse_id: string;
  from_warehouse_name: string;
  to_warehouse_id: string;
  to_warehouse_name: string;
  created_by_name: string | null;
  line_count: string;
  total_qty: string;
  total_value: string;
}

function toHead(r: HeadRow): Omit<Transfer, "lines"> {
  return {
    id: r.id,
    number: r.number,
    branchId: r.branch_id,
    fromWarehouseId: r.from_warehouse_id,
    fromWarehouseName: r.from_warehouse_name,
    toWarehouseId: r.to_warehouse_id,
    toWarehouseName: r.to_warehouse_name,
    status: r.status,
    occurredAt: r.occurred_at.toISOString(),
    postedAt: r.posted_at === null ? null : r.posted_at.toISOString(),
    note: r.note,
    createdByName: r.created_by_name,
    lineCount: Number(r.line_count),
    totalQty: r.total_qty,
    totalValue: serializeMoney(parseMoney(r.total_value)),
  };
}

export class TransferService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * برگه‌های یک شعبه — تازه‌ترین اول.
   *
   * از نما خوانده می‌شود و نما در `db/types.ts` ثبت نشده (مثل
   * `stock_movement`)، پس SQL خام. ثبت‌کردن یک نما در تایپ‌ها یعنی
   * روزی کسی وسوسه شود رویش بنویسد.
   */
  async list(branchIds: string[] | "all", limit = 50): Promise<Array<Omit<Transfer, "lines">>> {
    // فهرست تهی یعنی «هیچ شعبه‌ای»، نه «همه». حذف شرط، برگه شعبه
    // دیگر را لو می‌داد.
    if (branchIds !== "all" && branchIds.length === 0) return [];

    const rows = await sql<HeadRow>`
      SELECT * FROM inventory.transfer_summary
       WHERE ${branchIds === "all" ? sql`true` : sql`branch_id = ANY(${branchIds}::uuid[])`}
       ORDER BY occurred_at DESC
       LIMIT ${limit}
    `.execute(this.#db);
    return rows.rows.map(toHead);
  }

  async byId(id: string): Promise<Transfer | null> {
    const head = await sql<HeadRow>`
      SELECT * FROM inventory.transfer_summary WHERE id = ${id}::uuid
    `.execute(this.#db);
    const h = head.rows[0];
    if (!h) return null;

    const lines = await sql<{
      id: string;
      variation_id: string;
      sku: string;
      product_name: string;
      color: string;
      size: string;
      qty: string;
      unit_cost: string | null;
      value_delta: string | null;
    }>`
      SELECT l.id, l.variation_id, v.sku, p.name_internal AS product_name,
             v.color, v.size, l.qty::text, l.unit_cost::text, l.value_delta::text
        FROM inventory.transfer_line l
        JOIN catalog.variation v ON v.id = l.variation_id
        JOIN catalog.product   p ON p.id = v.product_id
       WHERE l.transfer_id = ${id}::uuid
       ORDER BY p.name_internal, v.color, v.size
    `.execute(this.#db);

    return {
      ...toHead(h),
      lines: lines.rows.map((l) => ({
        id: l.id,
        variationId: l.variation_id,
        sku: l.sku,
        productName: l.product_name,
        color: l.color,
        size: l.size,
        qty: l.qty,
        unitCost: l.unit_cost,
        valueDelta: l.value_delta,
      })),
    };
  }

  async create(input: {
    branchId: string;
    fromWarehouseId: string;
    toWarehouseId: string;
    note?: string | undefined;
    actorId: string;
  }): Promise<string> {
    if (input.fromWarehouseId === input.toWarehouseId) {
      throw new TransferError(
        "same_warehouse",
        "انبار مبدأ و مقصد یکی است؛ یکی از آن‌ها را عوض کنید.",
        422,
      );
    }
    return await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, input.actorId);
      const r = await trx
        .insertInto("inventory.transfer")
        .values({
          branch_id: input.branchId,
          from_warehouse_id: input.fromWarehouseId,
          to_warehouse_id: input.toWarehouseId,
          created_by: input.actorId,
          note: input.note ?? null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      return r.id;
    });
  }

  /**
   * افزودن یا تغییر یک قلم — **مطلق**، نه افزایشی.
   *
   * انباردار دو بار همان کالا را اسکن می‌کند و منظورش «دو تا» است، نه
   * «دو سطر». قید یکتایی `(transfer_id, variation_id)` سطر دوم را رد
   * می‌کند، پس `ON CONFLICT` تعداد را **جمع** می‌زند — همان رفتار
   * اسکنر در صندوق.
   */
  async addLine(input: {
    transferId: string;
    variationId: string;
    qty: string;
    actorId: string;
  }): Promise<void> {
    await this.#requireDraft(input.transferId);
    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, input.actorId);
      // جمع تعداد در SQL، نه در TypeScript: `platform.qty` اعشاری است.
      await sql`
        INSERT INTO inventory.transfer_line (transfer_id, variation_id, qty)
        VALUES (${input.transferId}::uuid, ${input.variationId}::uuid,
                ${input.qty}::platform.qty)
        ON CONFLICT (transfer_id, variation_id)
        DO UPDATE SET qty = inventory.transfer_line.qty + EXCLUDED.qty
      `.execute(trx);
    });
  }

  /** تعداد **مطلق** یک سطر — کلیک دوم روی «+» دو بار شمرده نمی‌شود. */
  async setLineQty(input: {
    transferId: string;
    lineId: string;
    qty: string;
    actorId: string;
  }): Promise<void> {
    await this.#requireDraft(input.transferId);
    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, input.actorId);
      const r = await sql`
        UPDATE inventory.transfer_line SET qty = ${input.qty}::platform.qty
         WHERE id = ${input.lineId}::uuid AND transfer_id = ${input.transferId}::uuid
      `.execute(trx);
      if (Number(r.numAffectedRows ?? 0n) === 0) {
        throw new TransferError("line_not_found", "این قلم در برگه نیست", 404);
      }
    });
  }

  async removeLine(transferId: string, lineId: string, actorId: string): Promise<void> {
    await this.#requireDraft(transferId);
    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, actorId);
      const r = await trx
        .deleteFrom("inventory.transfer_line")
        .where("id", "=", lineId)
        .where("transfer_id", "=", transferId)
        .executeTakeFirst();
      if (!r.numDeletedRows) {
        throw new TransferError("line_not_found", "این قلم در برگه نیست", 404);
      }
    });
  }

  async discard(transferId: string, actorId: string): Promise<void> {
    await this.#requireDraft(transferId);
    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, actorId);
      await trx.deleteFrom("inventory.transfer").where("id", "=", transferId).execute();
    });
  }

  /**
   * ثبت — همان لحظه‌ای که کالا واقعاً جابه‌جا می‌شود.
   *
   * `trx` از بیرون می‌آید تا با درج Inbox در **یک** تراکنش بنشیند:
   * ثبت دوباره نباید کالا را دو بار جابه‌جا کند.
   */
  async postIn(
    trx: Transaction<Database>,
    input: { transferId: string; actorId: string },
  ): Promise<number> {
    await setActor(trx, input.actorId);
    const r = await sql<{ n: number }>`
      SELECT inventory.post_transfer(${input.transferId}::uuid, ${input.actorId}::uuid) AS n
    `.execute(trx);
    return Number(r.rows[0]?.n ?? 0);
  }

  /** شعبه برگه — برای سنجش دامنه پیش از هر کاری. */
  async branchOf(transferId: string): Promise<{ branchId: string; status: string } | null> {
    const r = await this.#db
      .selectFrom("inventory.transfer")
      .select(["branch_id", "status"])
      .where("id", "=", transferId)
      .executeTakeFirst();
    return r === undefined ? null : { branchId: r.branch_id, status: r.status };
  }

  async #requireDraft(transferId: string): Promise<void> {
    const r = await this.#db
      .selectFrom("inventory.transfer")
      .select(["status", "number"])
      .where("id", "=", transferId)
      .executeTakeFirst();
    if (!r) throw new TransferError("transfer_not_found", "برگه انتقال یافت نشد", 404);
    if (r.status !== "draft") {
      throw new TransferError(
        "transfer_not_draft",
        `برگه در وضعیت «${r.status}» است و دیگر تغییر نمی‌کند. برای اصلاح، یک انتقال معکوس ثبت کنید.`,
      );
    }
  }
}
