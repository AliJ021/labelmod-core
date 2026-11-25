/**
 * شیفت صندوق.
 *
 * شیفت، کشوی پول یک صندوق‌دار است — نه دوره ثبت سند. آن دو در ADR-003
 * عمداً از هم جدا شدند و این لایه نباید دوباره قاطیشان کند.
 *
 * تمام منطق مالی بستن شیفت در `sales.close_shift` است: شمارش مورد
 * انتظار، مغایرت، سند تجمیعی و COGS. اینجا فقط مجوز، ورودی و ترجمه.
 */
import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { Db } from "../db/client.ts";
import type { Database } from "../db/types.ts";
import { parseMoney, serializeMoney } from "../lib/money.ts";
import { setActor } from "../lib/idempotency.ts";

export interface Shift {
  id: string;
  branchId: string;
  userId: string;
  openedAt: Date;
  saleCutoffAt: Date | null;
  openingCash: bigint;
  closedAt: Date | null;
  countedCash: bigint | null;
  expectedCash: bigint | null;
  variance: bigint | null;
  status: string;
  /** شمارش پایان شیفت قبل هنگام باز شدن؛ `null` یعنی سنجش نشد. */
  openingExpected: bigint | null;
  openingVariance: bigint | null;
  openingNote: string | null;
}

export class ShiftError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode = 409) {
    super(message);
    this.name = "ShiftError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class ShiftService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * شیفت باز کاربر، اگر دارد.
   *
   * قید `one_open_shift_per_user` در دیتابیس تضمین می‌کند بیش از یکی
   * نباشد، پس اینجا لازم نیست حالت «چند شیفت باز» را مدیریت کنیم.
   */
  async current(userId: string, branchId: string): Promise<Shift | null> {
    const row = await this.#db
      .selectFrom("sales.cash_shift")
      .selectAll()
      .where("user_id", "=", userId)
      .where("branch_id", "=", branchId)
      .where("status", "=", "open")
      .where("sale_ended_at", "is", null)
      .where(sql<boolean>`(sale_cutoff_at IS NULL OR sale_cutoff_at > clock_timestamp())`)
      .executeTakeFirst();
    return row ? toShift(row) : null;
  }

  /**
   * همه شیفت‌های **باز** یک شعبه — نه فقط شیفت خودِ کاربر.
   *
   * `one_open_shift_per_user` فقط می‌گوید هر کاربر یک شیفت باز دارد؛
   * دو صندوق‌دار می‌توانند هم‌زمان دو کشوی جدا داشته باشند.
   *
   * لازمش این است: پول نقدی که از کشو خارج می‌شود، لزوماً به دست
   * صاحب همان کشو خارج نمی‌شود. مدیر برای کرایه پیک از کشوی
   * صندوق‌دار برمی‌دارد و خودش شیفتی ندارد. بدون این تابع، آن هزینه
   * یا اصلاً ثبت نمی‌شد یا بی‌شیفت ثبت می‌شد — و شمارش پایان شیفت
   * مغایرت کاذب می‌داد.
   */
  async openInBranch(branchId: string): Promise<Shift[]> {
    const rows = await this.#db
      .selectFrom("sales.cash_shift")
      .selectAll()
      .where("branch_id", "=", branchId)
      .where("status", "=", "open")
      .where("sale_ended_at", "is", null)
      .where(sql<boolean>`(sale_cutoff_at IS NULL OR sale_cutoff_at > clock_timestamp())`)
      .orderBy("opened_at")
      .execute();
    return rows.map(toShift);
  }

  async byId(shiftId: string): Promise<Shift | null> {
    const row = await this.#db
      .selectFrom("sales.cash_shift")
      .selectAll()
      .where("id", "=", shiftId)
      .executeTakeFirst();
    return row ? toShift(row) : null;
  }

  /**
   * باز کردن شیفت — با سنجش پیوستگی نقد (مهاجرت ۱۲۰، تصمیم مالک ۲۰۲۶/۱۱/۱۵).
   *
   * اگر موجودی اول با شمارش پایان آخرین شیفت بستهٔ شعبه نخواند، بی دلیل
   * ۴۲۲ `opening_cash_mismatch` می‌گیرد و با دلیل پذیرفته می‌شود و سند
   * مغایرت می‌خورد. «انتظار» یک تعریف دارد: `sales.shift_opening_expected`؛
   * پیش‌سنجش اینجا فقط برای پاسخ خوانا است و `sales.open_shift` زیر قفل
   * دوباره می‌سنجد.
   *
   * ⚠️ پیام عدد مورد انتظار را **نمی‌گوید** (شمارش کور): اگر بگوید،
   *    صندوق‌دار به‌جای شمردن همان را تایپ می‌کند.
   */
  async open(input: {
    userId: string;
    branchId: string;
    openingCash: bigint;
    openingNote?: string | undefined;
  }): Promise<Shift> {
    if (input.openingCash < 0n) {
      throw new ShiftError("bad_opening_cash", "موجودی اول شیفت منفی نمی‌شود", 400);
    }

    // At midnight the next cashier may arrive before the worker's next tick.
    await sql`SELECT sales.auto_close_due_shifts('00000000-0000-7000-8000-0000000000f1'::uuid,
      ${input.userId}::uuid, ${input.branchId}::uuid)`.execute(this.#db);
    const existing = await this.current(input.userId, input.branchId);
    if (existing) {
      throw new ShiftError(
        "shift_already_open",
        `شیفت باز دارید (از ${existing.openedAt.toISOString()}). ابتدا آن را ببندید.`,
      );
    }

    const note = input.openingNote?.trim() ?? "";
    if (note === "") {
      const expected = (await sql<{ expected: string | null }>`
        SELECT sales.shift_opening_expected(${input.branchId}::uuid)::text AS expected`
        .execute(this.#db)).rows[0]?.expected ?? null;
      if (expected !== null && parseMoney(expected) !== input.openingCash) {
        throw new ShiftError(
          "opening_cash_mismatch",
          "موجودی اول شیفت با شمارش پایان شیفت قبل نمی‌خواند. دوباره بشمارید، یا اگر درست است دلیل اختلاف را بنویسید.",
          422,
        );
      }
    }

    const row = await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, input.userId);
      const id = (await sql<{ id: string }>`
        SELECT sales.open_shift(${input.branchId}::uuid, ${input.userId}::uuid,
          ${serializeMoney(input.openingCash)}::numeric, ${note === "" ? null : note}) AS id`
        .execute(trx)).rows[0]!.id;
      return trx.selectFrom("sales.cash_shift").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    });

    return toShift(row);
  }

  /**
   * بستن شیفت با شمارش واقعی کشو.
   *
   * `sales.close_shift` مغایرت را حساب می‌کند و — اگر صفر نباشد — سند
   * مستقل مغایرت می‌زند. آن سند عمداً با سند فروش قاطی نمی‌شود.
   */
  async close(input: {
    shiftId: string;
    countedCash: bigint;
    actorId: string;
    note?: string | undefined;
  }): Promise<Shift> {
    await this.#db.transaction().execute((trx) => this.closeIn(trx, input));

    const closed = await this.byId(input.shiftId);
    if (!closed) throw new ShiftError("shift_not_found", "شیفت یافت نشد", 404);
    return closed;
  }

  /**
   * همان بستن شیفت، داخل تراکنش فراخوان.
   *
   * `runOnce` باید درج Inbox و سند بستن را در یک تراکنش انجام دهد.
   * بستن شیفت سند فروش، COGS و مغایرت می‌زند؛ رد بدون سند یا سند
   * بدون رد، هر دو بدتر از تکرارند.
   */
  async closeIn(
    trx: Transaction<Database>,
    input: {
      shiftId: string;
      countedCash: bigint;
      actorId: string;
      note?: string | undefined;
    },
  ): Promise<void> {
    if (input.countedCash < 0n) {
      throw new ShiftError("bad_counted_cash", "شمارش نقد منفی نمی‌شود", 400);
    }

    // سنجش وضعیت **داخل** همین متد است، نه در مسیر HTTP: مسیر Replay
    // اصلاً اینجا نمی‌رسد، پس شیفتی که خودمان بسته‌ایم پاسخ قبلی را
    // می‌گیرد، در حالی که بستن دوم بدون کلید همچنان `shift_not_open`
    // می‌شود — نه پیام عمومی نگهبان دیتابیس.
    const shift = await trx.selectFrom("sales.cash_shift").select(["id", "status"])
      .where("id", "=", input.shiftId).forUpdate().executeTakeFirst();
    if (!shift) throw new ShiftError("shift_not_found", "شیفت یافت نشد", 404);
    if (shift.status !== "open") {
      throw new ShiftError("shift_not_open", "این شیفت پیش از این بسته شده است");
    }

    await setActor(trx, input.actorId);
    await sql`SELECT sales.close_shift(
      ${input.shiftId}::uuid,
      ${serializeMoney(input.countedCash)}::numeric,
      ${input.actorId}::uuid,
      ${input.note ?? null}::text)`.execute(trx);
  }
}

function toShift(row: {
  id: string;
  branch_id: string;
  user_id: string;
  opened_at: Date;
  sale_cutoff_at: Date | null;
  opening_cash: string;
  closed_at: Date | null;
  counted_cash: string | null;
  expected_cash: string | null;
  variance: string | null;
  status: string;
  opening_expected: string | null;
  opening_variance: string | null;
  opening_note: string | null;
}): Shift {
  return {
    id: row.id,
    branchId: row.branch_id,
    userId: row.user_id,
    openedAt: row.opened_at,
    saleCutoffAt: row.sale_cutoff_at,
    openingCash: parseMoney(row.opening_cash),
    closedAt: row.closed_at,
    countedCash: row.counted_cash === null ? null : parseMoney(row.counted_cash),
    expectedCash: row.expected_cash === null ? null : parseMoney(row.expected_cash),
    variance: row.variance === null ? null : parseMoney(row.variance),
    status: row.status,
    openingExpected: row.opening_expected === null ? null : parseMoney(row.opening_expected),
    openingVariance: row.opening_variance === null ? null : parseMoney(row.opening_variance),
    openingNote: row.opening_note,
  };
}

/** شکل JSON — پول همیشه رشته. */
export function shiftToJson(s: Shift) {
  return {
    id: s.id,
    branchId: s.branchId,
    userId: s.userId,
    openedAt: s.openedAt.toISOString(),
    saleCutoffAt: s.saleCutoffAt?.toISOString() ?? null,
    openingCash: serializeMoney(s.openingCash),
    closedAt: s.closedAt?.toISOString() ?? null,
    countedCash: s.countedCash === null ? null : serializeMoney(s.countedCash),
    expectedCash: s.expectedCash === null ? null : serializeMoney(s.expectedCash),
    variance: s.variance === null ? null : serializeMoney(s.variance),
    status: s.status,
    openingExpected: s.openingExpected === null ? null : serializeMoney(s.openingExpected),
    openingVariance: s.openingVariance === null ? null : serializeMoney(s.openingVariance),
    openingNote: s.openingNote,
  };
}
