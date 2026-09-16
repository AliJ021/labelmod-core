/**
 * حرکت نقدِ غیرفروشی — پرداخت به تأمین‌کننده، هزینه، آورده، انتقال.
 *
 * `treasury.post_transaction()` از مهاجرت ۰۰۴ وجود داشت و تست هم داشت،
 * ولی **هیچ مسیر API نداشت**. یعنی تا امروز:
 *
 *   · پرداخت به تأمین‌کننده هیچ‌جا ثبت نمی‌شد
 *   · هزینه صندوق (کرایه، ناهار، پیک) هیچ‌جا ثبت نمی‌شد
 *   · انتقال بین صندوق و بانک هیچ‌جا ثبت نمی‌شد
 *
 * و چون پول واقعاً از کشو خارج می‌شد، شمارش پایان شیفت **مغایرت کاذب**
 * می‌داد — همان چیزی که هیچ‌کس نمی‌تواند توضیحش بدهد.
 *
 * ── دروازه‌ای که در دیتابیس نیست و نمی‌تواند باشد ────────────────────
 *
 * قاعده حاکم پروژه: «هر حرکت نقدِ غیرفروشی باید `treasury.transaction`
 * با `shift_id` باشد، وگرنه شمارش صندوق مغایرت کاذب می‌دهد».
 *
 * دیتابیس نمی‌داند کدام کاربر کدام شیفت را باز دارد — این را فقط لایه
 * نشست می‌داند. پس دروازه‌اش اینجاست، دقیقاً مثل بازپرداخت نقدی در
 * `http/return-routes.ts`:
 *
 *   اگر حسابِ درگیر `cash_box` است و شیفت باز وجود دارد → `shift_id`
 *   اجباری و باید همان شیفت باشد.
 *
 * حساب بانکی شیفت نمی‌خواهد: پول از کشو رد نشده.
 */
import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { Db } from "../db/client.ts";
import type { Database } from "../db/types.ts";
import { parseMoney, serializeMoney } from "../lib/money.ts";
import { setActor } from "../lib/idempotency.ts";

export class TreasuryError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode = 409) {
    super(message);
    this.name = "TreasuryError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type Purpose =
  | "supplier_payment"
  | "customer_receipt"
  | "expense"
  | "capital"
  | "transfer";

export interface TreasuryAccount {
  id: string;
  code: string;
  name: string;
  kind: string;
  branchId: string | null;
  ledgerAccountCode: string;
  isActive: boolean;
}

export interface TransactionInput {
  branchId: string;
  purpose: Purpose;
  amount: bigint;
  fromAccountId?: string | undefined;
  toAccountId?: string | undefined;
  partyType?: "supplier" | "customer" | "user" | "other" | undefined;
  partyId?: string | undefined;
  expenseAccountCode?: string | undefined;
  shiftId?: string | undefined;
  occurredAt?: Date | undefined;
  refNo?: string | undefined;
  note?: string | undefined;
  actorId: string;
}

export interface TransactionRow {
  id: string;
  number: string | null;
  branchId: string;
  purpose: string;
  amount: string;
  fromAccountId: string | null;
  fromAccountName: string | null;
  toAccountId: string | null;
  toAccountName: string | null;
  partyType: string | null;
  partyId: string | null;
  partyName: string | null;
  expenseAccountCode: string | null;
  expenseAccountName: string | null;
  shiftId: string | null;
  occurredAt: string;
  status: string;
  entryId: string | null;
  refNo: string | null;
  note: string | null;
}

/** کدام حساب‌ها در این عملیات دخیل‌اند — برای دروازه شیفت. */
function accountsOf(input: TransactionInput): string[] {
  const out: string[] = [];
  if (input.fromAccountId !== undefined) out.push(input.fromAccountId);
  if (input.toAccountId !== undefined) out.push(input.toAccountId);
  return out;
}

export class TreasuryService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** حساب‌های خزانه — صندوق، بانک، کارت‌خوان، درگاه. */
  async accounts(
    opts: { kind?: string | undefined; branchIds?: string[] | undefined } = {},
  ): Promise<TreasuryAccount[]> {
    let q = this.#db
      .selectFrom("treasury.account")
      .select([
        "id",
        "code",
        "name",
        "kind",
        "branch_id",
        "ledger_account_code",
        "is_active",
      ])
      .where("is_active", "=", true)
      .orderBy("kind")
      .orderBy("code");

    if (opts.kind !== undefined) q = q.where("kind", "=", opts.kind);
    // حساب سراسری (`NULL`) در همه شعب قابل استفاده است؛ حساب شعبه‌ای
    // فقط باید برای شعب مجاز کاربر دیده شود. آرایه تهی یعنی فقط سراسری.
    const branchIds = opts.branchIds;
    if (branchIds !== undefined) {
      q =
        branchIds.length === 0
          ? q.where("branch_id", "is", null)
          : q.where((eb) =>
              eb.or([
                eb("branch_id", "is", null),
                eb("branch_id", "in", branchIds),
              ]),
            );
    }

    const rows = await q.execute();
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      kind: r.kind,
      branchId: r.branch_id,
      ledgerAccountCode: r.ledger_account_code,
      isActive: r.is_active,
    }));
  }

  /**
   * آیا این عملیات از کشوی صندوق پول جابه‌جا می‌کند؟
   *
   * پاسخ فقط از **نوع حساب** می‌آید، نه از نام یا کد — تا افزودن
   * صندوق دوم چیزی را نشکند.
   */
  async touchesCashBox(input: TransactionInput): Promise<boolean> {
    const ids = accountsOf(input);
    if (ids.length === 0) return false;
    const rows = await this.#db
      .selectFrom("treasury.account")
      .select("id")
      .where("id", "in", ids)
      .where("kind", "=", "cash_box")
      .where((eb) =>
        eb.or([
          eb("branch_id", "is", null),
          eb("branch_id", "=", input.branchId),
        ]),
      )
      .execute();
    return rows.length > 0;
  }

  /**
   * ساخت و ثبت — در **یک** تراکنش.
   *
   * پیش‌نویسِ ثبت‌نشده اینجا معنا ندارد: برخلاف رسید خرید که انباردار
   * ساعت‌ها رویش کار می‌کند، یک پرداخت یا هزینه در همان لحظه کامل است.
   * نگه‌داشتنش به‌شکل پیش‌نویس فقط راهی می‌شد برای پولی که از کشو رفته
   * ولی در دفتر نیست.
   */
  async createAndPost(input: TransactionInput): Promise<string> {
    if (input.amount <= 0n) {
      throw new TreasuryError("bad_amount", "مبلغ باید بزرگ‌تر از صفر باشد", 400);
    }

    await this.#assertReferences(input);

    return this.#db.transaction().execute(async (trx) => {
      await setActor(trx, input.actorId);
      const id = await this.#insert(trx, input);
      await sql`SELECT treasury.post_transaction(${id}::uuid, ${input.actorId}::uuid)`
        .execute(trx);
      return id;
    });
  }

  /**
   * حساب‌ها را پیش از درج می‌سنجد.
   *
   * ⚠️ بدون این، یک کد حساب هزینه غلط به نقض کلید خارجی می‌خورد و
   *    کاربر **۵۰۰** می‌گیرد — همان چیزی که `.claude/rules/api.md`
   *    ممنوع کرده: «نگهبان دیتابیس ۴۰۹ می‌دهد، نه ۵۰۰. دفاعی که شبیه
   *    خرابی سرور گزارش شود، در عمل خاموش است.»
   *
   *    نگاشت کورِ هر ۲۳۵۰۳ در `errors.ts` هم راه‌حل نبود: آن‌وقت هر
   *    کلید خارجی دیگری همان پیام را می‌گرفت. تصمیم از روی همان
   *    میدانی گرفته می‌شود که واقعاً اشتباه است.
   */
  async #assertReferences(input: TransactionInput): Promise<void> {
    const ids = accountsOf(input);
    if (ids.length > 0) {
      const found = await this.#db
        .selectFrom("treasury.account")
        .select(["id", "is_active", "branch_id"])
        .where("id", "in", ids)
        .execute();
      for (const id of ids) {
        const row = found.find((x) => x.id === id);
        if (!row) {
          throw new TreasuryError("account_not_found", "حساب خزانه یافت نشد", 404);
        }
        if (!row.is_active) {
          throw new TreasuryError(
            "account_inactive",
            "این حساب خزانه غیرفعال است و پول از آن جابه‌جا نمی‌شود.",
            422,
          );
        }
        if (row.branch_id !== null && row.branch_id !== input.branchId) {
          throw new TreasuryError(
            "account_branch_mismatch",
            "حساب خزانه متعلق به شعبه این تراکنش نیست.",
            403,
          );
        }
      }
    }

    if (input.expenseAccountCode !== undefined) {
      const acc = await this.#db
        .selectFrom("ledger.account")
        .select(["code", "is_postable", "is_active"])
        .where("code", "=", input.expenseAccountCode)
        .executeTakeFirst();
      if (!acc) {
        throw new TreasuryError(
          "expense_account_not_found",
          `سرفصل هزینه «${input.expenseAccountCode}» در کدینگ حساب نیست.`,
          422,
        );
      }
      // حساب گروه (غیرقابل ثبت) سند نمی‌گیرد — دیتابیس هم ردش می‌کند،
      // ولی اینجا پیامش می‌گوید **چرا**.
      if (!acc.is_postable) {
        throw new TreasuryError(
          "expense_account_not_postable",
          `«${input.expenseAccountCode}» یک حساب گروه است؛ سرفصل قابل ثبت انتخاب کنید.`,
          422,
        );
      }
      if (!acc.is_active) {
        throw new TreasuryError(
          "expense_account_inactive",
          `سرفصل هزینه «${input.expenseAccountCode}» غیرفعال است.`,
          422,
        );
      }
    }
  }

  async #insert(
    trx: Transaction<Database>,
    input: TransactionInput,
  ): Promise<string> {
    const row = await trx
      .insertInto("treasury.transaction")
      .values({
        branch_id: input.branchId,
        purpose: input.purpose,
        amount: serializeMoney(input.amount),
        from_account_id: input.fromAccountId ?? null,
        to_account_id: input.toAccountId ?? null,
        party_type: input.partyType ?? null,
        party_id: input.partyId ?? null,
        expense_account_code: input.expenseAccountCode ?? null,
        shift_id: input.shiftId ?? null,
        ...(input.occurredAt === undefined ? {} : { occurred_at: input.occurredAt }),
        ref_no: input.refNo ?? null,
        note: input.note ?? null,
        created_by: input.actorId,
      })
      .returning("id")
      .executeTakeFirst();

    if (!row) {
      throw new TreasuryError("insert_failed", "ثبت تراکنش انجام نشد", 500);
    }
    return row.id;
  }

  async byId(id: string): Promise<TransactionRow | null> {
    const rows = await this.#base().where("t.id", "=", id).execute();
    return rows.map(toRow)[0] ?? null;
  }

  /**
   * فهرست تراکنش‌ها.
   *
   * `shiftId` برای صفحه بستن شیفت است: صندوق‌دار باید بتواند ببیند چه
   * پولی غیر از فروش از کشو رفته، وگرنه مغایرت را نمی‌فهمد.
   */
  async list(
    opts: {
      branchIds?: string[] | undefined;
      shiftId?: string | undefined;
      purpose?: Purpose | undefined;
      limit?: number | undefined;
    } = {},
  ): Promise<TransactionRow[]> {
    let q = this.#base()
      .orderBy("t.occurred_at", "desc")
      .limit(Math.min(opts.limit ?? 100, 500));

    // دامنه شعبه: فهرست تهی یعنی «هیچ شعبه‌ای» — نه «همه». حذف شرط
    // اینجا، تراکنش‌های شعبه دیگر را لو می‌داد.
    if (opts.branchIds !== undefined) {
      q =
        opts.branchIds.length === 0
          ? q.where(sql<boolean>`false`)
          : q.where("t.branch_id", "in", opts.branchIds);
    }
    if (opts.shiftId !== undefined) q = q.where("t.shift_id", "=", opts.shiftId);
    if (opts.purpose !== undefined) q = q.where("t.purpose", "=", opts.purpose);

    return (await q.execute()).map(toRow);
  }

  #base() {
    return this.#db
      .selectFrom("treasury.transaction as t")
      .leftJoin("treasury.account as fa", "fa.id", "t.from_account_id")
      .leftJoin("treasury.account as ta", "ta.id", "t.to_account_id")
      .leftJoin("ledger.account as ea", "ea.code", "t.expense_account_code")
      .select([
        "t.id",
        "t.number",
        "t.branch_id",
        "t.purpose",
        "t.amount",
        "t.from_account_id",
        "fa.name as from_name",
        "t.to_account_id",
        "ta.name as to_name",
        "t.party_type",
        "t.party_id",
        "t.expense_account_code",
        "ea.name as expense_name",
        "t.shift_id",
        "t.occurred_at",
        "t.status",
        "t.entry_id",
        "t.ref_no",
        "t.note",
        // نام شخص از سه جدول می‌آید و کدام‌یک، به `party_type` بستگی
        // دارد. زیرپرس‌وجوی شرطی اینجا از سه JOIN تهی ساده‌تر است و
        // ستون تهی می‌ماند اگر شخصی در کار نباشد.
        sql<string | null>`CASE t.party_type
             WHEN 'supplier' THEN (SELECT s.name      FROM purchasing.supplier s WHERE s.id = t.party_id)
             WHEN 'customer' THEN (SELECT c.full_name FROM sales.customer     c WHERE c.id = t.party_id)
             WHEN 'user'     THEN (SELECT u.full_name FROM identity.app_user  u WHERE u.id = t.party_id)
           END`.as("party_name"),
      ]);
  }
}

/** سطر دیتابیس → شکل JSON. پول رشته می‌ماند، نه عدد. */
function toRow(r: {
  id: string;
  number: string | null;
  branch_id: string;
  purpose: string;
  amount: string;
  from_account_id: string | null;
  from_name: string | null;
  to_account_id: string | null;
  to_name: string | null;
  party_type: string | null;
  party_id: string | null;
  party_name: string | null;
  expense_account_code: string | null;
  expense_name: string | null;
  shift_id: string | null;
  occurred_at: Date;
  status: string;
  entry_id: string | null;
  ref_no: string | null;
  note: string | null;
}): TransactionRow {
  return {
    id: r.id,
    number: r.number,
    branchId: r.branch_id,
    purpose: r.purpose,
    amount: serializeMoney(parseMoney(r.amount)),
    fromAccountId: r.from_account_id,
    fromAccountName: r.from_name,
    toAccountId: r.to_account_id,
    toAccountName: r.to_name,
    partyType: r.party_type,
    partyId: r.party_id,
    partyName: r.party_name,
    expenseAccountCode: r.expense_account_code,
    expenseAccountName: r.expense_name,
    shiftId: r.shift_id,
    occurredAt: new Date(r.occurred_at).toISOString(),
    status: r.status,
    entryId: r.entry_id,
    refNo: r.ref_no,
    note: r.note,
  };
}
