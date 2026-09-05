/**
 * چک دریافتی و پرداختی.
 *
 * `treasury.post_cheque_event()` از مهاجرت ۰۰۵ وجود داشت، ماشین وضعیت
 * کاملش تست داشت، و `treasury.cheque_due` هم نمای سررسید را می‌داد —
 * ولی **هیچ مسیر API نداشت**. یعنی ثبت چک، وصول چک و برگشت چک همه
 * فقط از psql ممکن بودند.
 *
 * ── چرا این فایل هیچ وضعیتی را خودش عوض نمی‌کند ─────────────────────
 *
 * `cheque.status` یک Projection از زنجیره `cheque_event` است، نه یک
 * ستون آزاد. `UPDATE` مستقیم رویش با `CONSTRAINT TRIGGER` معوق رد
 * می‌شود (ADR-004). پس تنها کار این فایل صدا زدن
 * `treasury.post_cheque_event()` است — و همان تابع تصمیم می‌گیرد کدام
 * گذار مجاز است:
 *
 *   دریافتی  draft → in_hand → deposited → cleared
 *                              deposited → bounced → settled
 *                    in_hand  → endorsed → bounced
 *   پرداختی  draft → issued → cleared | bounced
 *
 * ── چک تا وصول نشود پول نیست ────────────────────────────────────────
 *
 * قاعده ADR-004: چک هرگز مستقیم به صندوق یا بانک نمی‌رود. `receive`
 * فقط بدهی مشتری را به «اسناد دریافتنی» منتقل می‌کند؛ پول واقعی در
 * `clear` می‌آید و آن هم به حساب بانکیِ واگذاری، نه به کشو.
 */
import { sql } from "kysely";
import type { Db } from "../db/client.ts";
import { parseMoney, serializeMoney } from "../lib/money.ts";
import { setActor } from "../lib/idempotency.ts";

export class ChequeError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode = 409) {
    super(message);
    this.name = "ChequeError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * اعمال ماشین وضعیت — دقیقاً همان‌هایی که
 * `treasury.post_cheque_event()` می‌شناسد.
 *
 * فهرست اینجا **دروازه نیست**، فقط اعتبارسنجی ورودی است تا خطای Zod
 * فارسی بگیرد به‌جای خطای دیتابیس. دروازه واقعی همان تابع است.
 */
export const CHEQUE_ACTIONS = [
  "receive",
  "deposit",
  "clear",
  "bounce",
  "endorse",
  "settle",
  "issue",
  "pay",
  "cancel",
] as const;

export type ChequeAction = (typeof CHEQUE_ACTIONS)[number];

export interface ChequeInput {
  direction: "received" | "issued";
  branchId: string;
  chequeNo: string;
  sayadId?: string | undefined;
  bankName: string;
  bankBranch?: string | undefined;
  accountNo?: string | undefined;
  drawerName?: string | undefined;
  amount: bigint;
  issuedOn: string;
  dueOn: string;
  partyType: "customer" | "supplier";
  partyId: string;
  bankAccountId?: string | undefined;
  note?: string | undefined;
  actorId: string;
}

export interface ChequeRow {
  id: string;
  number: string | null;
  direction: string;
  branchId: string;
  chequeNo: string;
  sayadId: string | null;
  bankName: string;
  bankBranch: string | null;
  drawerName: string | null;
  amount: string;
  issuedOn: string;
  dueOn: string;
  partyType: string;
  partyId: string;
  partyName: string | null;
  bankAccountId: string | null;
  depositAccountId: string | null;
  depositAccountName: string | null;
  status: string;
  note: string | null;
  createdAt: string;
}

export interface ChequeEventRow {
  action: string;
  fromStatus: string | null;
  toStatus: string;
  occurredOn: string;
  note: string | null;
  byUser: string | null;
  entryId: string | null;
}

export interface DueRow {
  id: string;
  chequeNo: string;
  direction: string;
  bankName: string;
  amount: string;
  dueOn: string;
  status: string;
  partyName: string | null;
  /** `overdue` | `today` | `soon` | `future` — از نمای دیتابیس. */
  urgency: string;
}

const day = (v: Date | string): string =>
  typeof v === "string" ? v.slice(0, 10) : v.toISOString().slice(0, 10);

export class ChequeService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * ثبت چک تازه — به‌شکل `draft`، بدون هیچ سندی.
   *
   * برگه‌ای که هنوز نه دریافت شده نه صادر، هیچ اثر مالی ندارد. اولین
   * سند با `receive` یا `issue` می‌خورد.
   */
  async create(input: ChequeInput): Promise<string> {
    if (input.amount <= 0n) {
      throw new ChequeError("bad_amount", "مبلغ چک باید بزرگ‌تر از صفر باشد", 400);
    }
    if (input.dueOn < input.issuedOn) {
      throw new ChequeError(
        "bad_due",
        "تاریخ سررسید نمی‌تواند پیش از تاریخ صدور باشد",
        400,
      );
    }

    return this.#db.transaction().execute(async (trx) => {
      await setActor(trx, input.actorId);
      const row = await trx
        .insertInto("treasury.cheque")
        .values({
          direction: input.direction,
          branch_id: input.branchId,
          cheque_no: input.chequeNo,
          sayad_id: input.sayadId ?? null,
          bank_name: input.bankName,
          bank_branch: input.bankBranch ?? null,
          account_no: input.accountNo ?? null,
          drawer_name: input.drawerName ?? null,
          amount: serializeMoney(input.amount),
          issued_on: input.issuedOn,
          due_on: input.dueOn,
          party_type: input.partyType,
          party_id: input.partyId,
          bank_account_id: input.bankAccountId ?? null,
          note: input.note ?? null,
          created_by: input.actorId,
        })
        .returning("id")
        .executeTakeFirst();

      if (!row) throw new ChequeError("insert_failed", "ثبت چک انجام نشد", 500);
      return row.id;
    });
  }

  /**
   * یک گذار روی ماشین وضعیت.
   *
   * هیچ شرطی اینجا بررسی نمی‌شود — همه‌اش در
   * `treasury.post_cheque_event()` است و باید همان‌جا بماند: تابع
   * دیتابیس تنها چیزی است که psql هم نمی‌تواند دورش بزند.
   */
  async postEvent(input: {
    chequeId: string;
    action: ChequeAction;
    accountId?: string | undefined;
    partyId?: string | undefined;
    on?: string | undefined;
    note?: string | undefined;
    actorId: string;
  }): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, input.actorId);
      await sql`
        SELECT treasury.post_cheque_event(
          ${input.chequeId}::uuid, ${input.action}, ${input.actorId}::uuid,
          ${input.accountId ?? null}::uuid, ${input.partyId ?? null}::uuid,
          ${input.on ?? null}::date, ${input.note ?? null})
      `.execute(trx);
    });
  }

  async list(opts: {
    branchIds?: string[] | undefined;
    direction?: "received" | "issued" | undefined;
    status?: string | undefined;
    limit?: number | undefined;
  } = {}): Promise<ChequeRow[]> {
    let q = this.#db
      .selectFrom("treasury.cheque as c")
      .leftJoin("treasury.account as da", "da.id", "c.deposit_account_id")
      .select([
        "c.id",
        "c.number",
        "c.direction",
        "c.branch_id",
        "c.cheque_no",
        "c.sayad_id",
        "c.bank_name",
        "c.bank_branch",
        "c.drawer_name",
        "c.amount",
        "c.issued_on",
        "c.due_on",
        "c.party_type",
        "c.party_id",
        "c.bank_account_id",
        "c.deposit_account_id",
        "da.name as deposit_name",
        "c.status",
        "c.note",
        "c.created_at",
        sql<string | null>`CASE c.party_type
             WHEN 'supplier' THEN (SELECT s.name      FROM purchasing.supplier s WHERE s.id = c.party_id)
             WHEN 'customer' THEN (SELECT cu.full_name FROM sales.customer    cu WHERE cu.id = c.party_id)
           END`.as("party_name"),
      ])
      .orderBy("c.due_on")
      .limit(Math.min(opts.limit ?? 200, 500));

    if (opts.branchIds !== undefined) {
      q =
        opts.branchIds.length === 0
          ? q.where(sql<boolean>`false`)
          : q.where("c.branch_id", "in", opts.branchIds);
    }
    if (opts.direction !== undefined) q = q.where("c.direction", "=", opts.direction);
    if (opts.status !== undefined) q = q.where("c.status", "=", opts.status);

    const rows = await q.execute();
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      direction: r.direction,
      branchId: r.branch_id,
      chequeNo: r.cheque_no,
      sayadId: r.sayad_id,
      bankName: r.bank_name,
      bankBranch: r.bank_branch,
      drawerName: r.drawer_name,
      amount: serializeMoney(parseMoney(r.amount)),
      issuedOn: day(r.issued_on),
      dueOn: day(r.due_on),
      partyType: r.party_type,
      partyId: r.party_id,
      partyName: r.party_name,
      bankAccountId: r.bank_account_id,
      depositAccountId: r.deposit_account_id,
      depositAccountName: r.deposit_name,
      status: r.status,
      note: r.note,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  /** زنجیره رویداد یک چک — همان چیزی که `status` از آن ساخته می‌شود. */
  async events(chequeId: string): Promise<ChequeEventRow[]> {
    const rows = await this.#db
      .selectFrom("treasury.cheque_event as e")
      .leftJoin("identity.app_user as u", "u.id", "e.created_by")
      .select([
        "e.action",
        "e.from_status",
        "e.to_status",
        "e.occurred_on",
        "e.note",
        "e.entry_id",
        "u.full_name as by_user",
      ])
      .where("e.cheque_id", "=", chequeId)
      .orderBy("e.seq")
      .execute();

    return rows.map((r) => ({
      action: r.action,
      fromStatus: r.from_status,
      toStatus: r.to_status,
      occurredOn: day(r.occurred_on),
      note: r.note,
      byUser: r.by_user,
      entryId: r.entry_id,
    }));
  }

  /**
   * سررسیدها — از نمای `treasury.cheque_due`.
   *
   * ⚠️ `urgency` را دیتابیس حساب می‌کند، نه مرورگر. «امروز» یک تعریف
   *    دارد (`platform.business_date()` و منطقه زمانی تنظیمات)؛ حساب
   *    کردنش در کلاینت یعنی چکی که روی سرور «سررسیدشده» است در مرورگر
   *    کاربر «فردا» دیده شود.
   */
  async due(branchIds?: string[]): Promise<DueRow[]> {
    // ⚠️ نما `branch_id` ندارد، پس دامنه شعبه با Join به خودِ چک
    //    اعمال می‌شود — نه با حذف شرط. حذفش یعنی چک شعبه دیگر لو برود.
    let q = this.#db
      .selectFrom("treasury.cheque_due as d")
      .innerJoin("treasury.cheque as c", "c.id", "d.id")
      .select([
        "d.id",
        "d.cheque_no",
        "d.direction",
        "d.bank_name",
        "d.amount",
        "d.due_on",
        "d.status",
        "d.party_name",
        "d.urgency",
      ])
      .orderBy("d.due_on")
      .limit(500);
    if (branchIds !== undefined) {
      q =
        branchIds.length === 0
          ? q.where(sql<boolean>`false`)
          : q.where("c.branch_id", "in", branchIds);
    }
    const rows = await q.execute();
    return rows.map((r) => ({
      id: r.id,
      chequeNo: r.cheque_no,
      direction: r.direction,
      bankName: r.bank_name,
      amount: serializeMoney(parseMoney(r.amount)),
      dueOn: day(r.due_on),
      status: r.status,
      partyName: r.party_name,
      urgency: r.urgency,
    }));
  }
}
