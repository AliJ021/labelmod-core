/**
 * دوره ثبت — جایی که درآمد به دفتر می‌رسد.
 *
 * ADR-003: دوره ثبت از شیفت صندوق جداست. فاکتور صندوق به دوره شیفت
 * می‌چسبد و با بستن کشو ثبت می‌شود؛ فاکتور آنلاین به دوره
 * (شعبه، کانال، روز) می‌چسبد و **هیچ‌چیز خودکار آن را نمی‌بندد**.
 *
 * تا پیش از این، لایه API فقط بستن شیفت را داشت. یعنی فروش سایت
 * نهایی می‌شد، کالا از انبار خارج می‌شد، پول می‌آمد — و سند فروش و
 * COGS هرگز زده نمی‌شد. `sales.unposted_revenue` پر می‌ماند و کسی
 * نمی‌دید. این ماژول همان شکاف است.
 */
import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { Db } from "../db/client.ts";
import type { Database } from "../db/types.ts";
import { parseMoney, serializeMoney } from "../lib/money.ts";
import { setActor } from "../lib/idempotency.ts";

export class BatchError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode = 409) {
    super(message);
    this.name = "BatchError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface UnpostedRow {
  batchId: string | null;
  batchKind: string | null;
  branchId: string;
  channel: string;
  businessDate: string | null;
  invoiceCount: number;
  payableAmount: bigint;
  cogsAmount: bigint;
}

export class PostingBatchService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * درآمدی که هنوز به دفتر نرفته، گروه‌شده بر دوره ثبت.
   *
   * README این را یک زنگ خطر اعلام کرده: «اگر `sales.unposted_revenue`
   * خالی نباشد، درآمدی به دفتر نرفته است». تا وقتی راهی برای دیدنش
   * نباشد، آن جمله فقط یک جمله است.
   */
  async unposted(branchIds: string[] | "all"): Promise<UnpostedRow[]> {
    let q = this.#db
      .selectFrom("sales.unposted_revenue")
      .select([
        "batch_id",
        "batch_kind",
        "branch_id",
        "channel",
        "business_date",
        (eb) => eb.fn.countAll<string>().as("invoice_count"),
        (eb) => eb.fn.sum<string>("payable_amount").as("payable_amount"),
        (eb) => eb.fn.sum<string>("cogs_amount").as("cogs_amount"),
      ])
      .groupBy(["batch_id", "batch_kind", "branch_id", "channel", "business_date"])
      .orderBy("business_date", "desc");

    if (branchIds !== "all") {
      if (branchIds.length === 0) return [];
      q = q.where("branch_id", "in", branchIds);
    }

    const rows = await q.execute();
    return rows.map((r) => ({
      batchId: r.batch_id,
      batchKind: r.batch_kind,
      branchId: r.branch_id,
      channel: r.channel,
      businessDate: r.business_date === null ? null : isoDate(r.business_date),
      invoiceCount: Number(r.invoice_count),
      payableAmount: parseMoney(r.payable_amount ?? "0"),
      cogsAmount: parseMoney(r.cogs_amount ?? "0"),
    }));
  }

  /**
   * بستن دوره کانال — سند فروش و COGS یک روز از یک کانال.
   *
   * `trx` از بیرون می‌آید تا با Inbox در یک تراکنش بنشیند: بستن دوره
   * سند می‌سازد و سند دوباره‌ساخته نمی‌شود.
   */
  async closeChannelDayIn(
    trx: Transaction<Database>,
    input: { branchId: string; channel: string; date: string; actorId: string },
  ): Promise<{ saleEntry: string | null; cogsEntry: string | null }> {
    await setActor(trx, input.actorId);
    const res = await sql<{ sale_entry: string | null; cogs_entry: string | null }>`
      SELECT sale_entry, cogs_entry
        FROM sales.close_channel_day(
               ${input.branchId}::uuid, ${input.channel}::text,
               ${input.date}::date, ${input.actorId}::uuid)
    `.execute(trx);

    const row = res.rows[0];
    if (!row) throw new BatchError("close_failed", "بستن دوره کانال ناموفق بود", 500);
    return { saleEntry: row.sale_entry, cogsEntry: row.cogs_entry };
  }

  /** دوره یک (شعبه، کانال، روز)، اگر ساخته شده باشد. */
  async channelDay(
    branchId: string,
    channel: string,
    date: string,
  ): Promise<{ id: string; status: string } | null> {
    const row = await this.#db
      .selectFrom("ledger.posting_batch")
      .select(["id", "status"])
      .where("kind", "=", "channel_day")
      .where("branch_id", "=", branchId)
      .where("channel", "=", channel)
      .where("business_date", "=", date)
      .executeTakeFirst();
    return row ?? null;
  }
}

/** `date` پستگرس در درایور `Date` می‌شود؛ فقط بخش تاریخ لازم است. */
function isoDate(v: Date | string): string {
  if (typeof v === "string") return v.slice(0, 10);
  // بخش تاریخ در وقت محلی سرور — همان چیزی که پستگرس برگردانده بود.
  const y = v.getFullYear();
  const m = String(v.getMonth() + 1).padStart(2, "0");
  const d = String(v.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function unpostedToJson(rows: UnpostedRow[]) {
  return rows.map((r) => ({
    batchId: r.batchId,
    batchKind: r.batchKind,
    branchId: r.branchId,
    channel: r.channel,
    businessDate: r.businessDate,
    invoiceCount: r.invoiceCount,
    payableAmount: serializeMoney(r.payableAmount),
    cogsAmount: serializeMoney(r.cogsAmount),
  }));
}
