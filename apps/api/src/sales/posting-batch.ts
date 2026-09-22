/**
 * دوره ثبت — جایی که درآمد به دفتر می‌رسد.
 *
 * ADR-003: دوره ثبت از شیفت صندوق جداست. فاکتور صندوق به دوره شیفت
 * می‌چسبد و با بستن کشو ثبت می‌شود؛ فاکتور آنلاین به دوره
 * (شعبه، کانال، روز) می‌چسبد و با یک کار زمان‌بندی‌شده شبانه بسته
 * می‌شود (`closeDue`، مهاجرت ۰۱۳).
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

/** نتیجه یک دوره در اجرای بستن خودکار. */
export interface ClosedBatch {
  batchId: string;
  branchId: string;
  channel: string;
  businessDate: string;
  saleEntry: string | null;
  cogsEntry: string | null;
  /** اگر پر باشد یعنی این دوره بسته **نشد** و دلیلش همین است. */
  skipped: string | null;
}

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
        // `business_date` را **در SQL** به متن می‌بریم، نه با Date
        // جاوااسکریپت: تاریخِ دوره، هویت دوره ثبت است و نباید به
        // منطقه زمانی سرور یا رفتار درایور وابسته باشد.
        sql<string>`business_date::text`.as("business_date"),
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
      businessDate: r.business_date,
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

  /**
   * بستن همه دوره‌های کانالِ روزهای گذشته — کار زمان‌بندی‌شده شبانه.
   *
   * **موجودی را دست نمی‌زند.** کالا در همان لحظه فروش از انبار خارج
   * شده؛ آنچه اینجا بسته می‌شود فقط سند حسابداری است.
   *
   * کل اجرا در **یک تراکنش** است: یا همه دوره‌های واجد شرایط بسته
   * می‌شوند یا هیچ‌کدام. دوره مشکل‌دار (فاکتور نیمه‌کاره، یا بدون
   * فاکتور نهایی‌شده) رد می‌شود و دلیلش برمی‌گردد — نه اینکه کل
   * اجرا را بشکند.
   */
  async closeDue(actorId: string): Promise<ClosedBatch[]> {
    return this.#db.transaction().execute(async (trx) => {
      await setActor(trx, actorId);
      const res = await sql<{
        batch_id: string;
        branch_id: string;
        channel: string;
        business_date: string;
        sale_entry: string | null;
        cogs_entry: string | null;
        skipped: string | null;
      }>`SELECT * FROM sales.close_due_channel_days(${actorId}::uuid)`.execute(trx);

      return res.rows.map((r) => ({
        batchId: r.batch_id,
        branchId: r.branch_id,
        channel: r.channel,
        // تاریخ کاری، نه لحظه — `toISOString` آن را به UTC می‌برد و
        // ممکن است یک روز عقب بیفتد.
        businessDate: formatDate(r.business_date),
        saleEntry: r.sale_entry,
        cogsEntry: r.cogs_entry,
        skipped: r.skipped,
      }));
    });
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

/**
 * `date` پستگرس → «YYYY-MM-DD»، بدون عبور از UTC.
 *
 * `toISOString()` تاریخ را به UTC می‌برد؛ برای یک `date` که درایور
 * آن را نیمه‌شب **محلی** می‌سازد، این یعنی در تهران یک روز عقب
 * می‌افتد. تاریخ کاری باید همان چیزی بماند که در دیتابیس است.
 */
function formatDate(d: Date | string): string {
  if (typeof d === "string") return d;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
