/**
 * مسیرهای خزانه و چک.
 *
 * دو حوزه‌ای که تابع دیتابیس و تست کامل داشتند و **هیچ مسیر API**:
 * `treasury.post_transaction()` از مهاجرت ۰۰۴ و
 * `treasury.post_cheque_event()` از ۰۰۵.
 *
 * ── چهار دروازه ─────────────────────────────────────────────────────
 *
 * ۱. **مجوز.** `treasury.manage` برای حرکت نقد، `cheque.manage` برای
 *    چک. هر دو در Seed، هیچ‌کدام در کد.
 *
 * ۲. **دامنه شعبه.** `assertBranch` — همان چیزی که فروش و خرید دارند.
 *
 * ۳. **کشو.** پول نقدی که از کشوی یک شیفت باز رد شود و `shift_id`
 *    نگیرد، شمارش پایان شیفت را می‌شکند. این دروازه در دیتابیس نیست و
 *    نمی‌تواند باشد: دیتابیس نمی‌داند کدام کاربر کدام شیفت را باز
 *    دارد. دقیقاً مثل بازپرداخت نقدی در `return-routes.ts`.
 *
 * ۴. **Idempotency.** هر مسیر تغییردهنده وضعیت.
 *
 * ── چرا چک مسیر «ثبت و ثبت» ندارد ───────────────────────────────────
 *
 * برخلاف حرکت نقد که ساخت و ثبتش یک لحظه است، چک عمداً دو گام دارد:
 * `POST /cheques` برگه را به‌شکل `draft` ثبت می‌کند — بدون هیچ سندی —
 * و `POST /cheques/:id/events` ماشین وضعیت را حرکت می‌دهد. برگه‌ای که
 * هنوز نه دریافت شده نه صادر، هیچ اثر مالی ندارد.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AuthError } from "../auth/service.ts";
import { requireForSession } from "../auth/permission.ts";
import type { Db } from "../db/client.ts";
import { parseMoney } from "../lib/money.ts";
import { runOnce } from "../lib/idempotency.ts";
import { resolveCashDrawer } from "../treasury/cash-drawer.ts";
import { assertBranch, branchesOf } from "../sales/scope.ts";
import type { ShiftService } from "../sales/shift.ts";
import {
  TreasuryError,
  type Purpose,
  type TreasuryService,
} from "../treasury/transaction.ts";
import { CHEQUE_ACTIONS, ChequeError, type ChequeService } from "../treasury/cheque.ts";
import { CONTROL_CHARS } from "../lib/text.ts";

const uuid = z.string().uuid("شناسه نامعتبر");

/** پول در JSON رشته است — رقم صحیح ریالی، بدون اعشار و جداکننده. */
const moneyString = z
  .string()
  .regex(/^\d+$/, "مبلغ باید رقم صحیح باشد (ریال، بدون اعشار)")
  .refine((v) => v.length <= 18, { message: "مبلغ بزرگ‌تر از حد مجاز است" });

/** نویسه‌های کنترلی و جهت‌دهی — همان فهرست بقیه مرزهای API. */
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `حداکثر ${max} نویسه`)
    .refine((v) => !CONTROL_CHARS.test(v), { message: "شامل نویسه کنترلی است" });

const optionalText = (max: number) =>
  text(max)
    .transform((v) => (v === "" ? undefined : v))
    .optional();

const requiredText = (max: number) => text(max).min(1, "نمی‌تواند خالی باشد");

/** تاریخ میلادی ISO — کلاینت تقویم فارسی را خودش تبدیل می‌کند. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "تاریخ باید به شکل YYYY-MM-DD باشد")
  .refine((v) => {
    const date = new Date(`${v}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === v;
  }, "تاریخ تقویمی معتبر نیست");

/**
 * محدودیت نرخ روی مسیرهایی که پول جابه‌جا می‌کنند.
 *
 * سقف عمداً بالاست: یک مدیر در شلوغ‌ترین روز هم چند پرداخت در دقیقه
 * نمی‌زند، ولی یک حلقه خودکار صدها. محدودیتی که وسط کار واقعی فعال
 * شود، از نبودش بدتر است.
 */
const MONEY_LIMIT = { rateLimit: { max: 30, timeWindow: "1 minute" } };

/**
 * بدنه حرکت نقد.
 *
 * شکل حساب‌ها را دیتابیس اجبار می‌کند (`transaction_direction_shape`)،
 * ولی اینجا هم سنجیده می‌شود تا کاربر پیام فارسی بگیرد نه نقض قید.
 * **دو نسخه از یک قاعده نیست**: دیتابیس مرجع است و این فقط بازخورد
 * زودتر — اگر روزی قید عوض شود، دیتابیس همچنان جلویش را می‌گیرد.
 */
const txBody = z
  .object({
    branchId: uuid,
    purpose: z.enum([
      "supplier_payment",
      "customer_receipt",
      "expense",
      "capital",
      "transfer",
    ]),
    amount: moneyString,
    fromAccountId: uuid.optional(),
    toAccountId: uuid.optional(),
    partyType: z.enum(["supplier", "customer", "user", "other"]).optional(),
    partyId: uuid.optional(),
    expenseAccountCode: optionalText(20),
    shiftId: uuid.optional(),
    occurredAt: z.string().datetime().optional(),
    refNo: optionalText(60),
    note: optionalText(300),
  })
  .refine(
    (v) =>
      v.purpose !== "transfer" ||
      (v.fromAccountId !== undefined &&
        v.toAccountId !== undefined &&
        v.fromAccountId !== v.toAccountId),
    { message: "انتقال به دو حساب متفاوت نیاز دارد" },
  )
  .refine(
    (v) =>
      !["supplier_payment", "expense"].includes(v.purpose) ||
      (v.fromAccountId !== undefined && v.toAccountId === undefined),
    { message: "پرداخت و هزینه فقط حساب مبدأ می‌گیرند" },
  )
  .refine(
    (v) =>
      !["customer_receipt", "capital"].includes(v.purpose) ||
      (v.toAccountId !== undefined && v.fromAccountId === undefined),
    { message: "دریافت و آورده فقط حساب مقصد می‌گیرند" },
  )
  .refine((v) => v.purpose !== "expense" || v.expenseAccountCode !== undefined, {
    message: "برای هزینه، سرفصل هزینه لازم است",
  })
  .refine(
    (v) =>
      !["supplier_payment", "customer_receipt"].includes(v.purpose) ||
      v.partyId !== undefined,
    { message: "پرداخت به تأمین‌کننده و دریافت از مشتری، شخص لازم دارند" },
  );

const chequeBody = z.object({
  direction: z.enum(["received", "issued"]),
  branchId: uuid,
  chequeNo: requiredText(30),
  sayadId: optionalText(16),
  bankName: requiredText(60),
  bankBranch: optionalText(60),
  accountNo: optionalText(40),
  drawerName: optionalText(80),
  amount: moneyString,
  issuedOn: isoDate,
  dueOn: isoDate,
  partyType: z.enum(["customer", "supplier"]),
  partyId: uuid,
  bankAccountId: uuid.optional(),
  note: optionalText(300),
});

const eventBody = z.object({
  action: z.enum(CHEQUE_ACTIONS),
  /** حساب بانکی — برای `deposit`، `clear` و `pay`. */
  accountId: uuid.optional(),
  /** تأمین‌کننده‌ای که چک به او خرج می‌شود — فقط `endorse`. */
  partyId: uuid.optional(),
  on: isoDate.optional(),
  note: optionalText(300),
});

export interface TreasuryRouteDeps {
  db: Db;
  treasury: TreasuryService;
  cheques: ChequeService;
  shifts: ShiftService;
}

export function registerTreasuryRoutes(
  app: FastifyInstance,
  deps: TreasuryRouteDeps,
): void {
  const { db, treasury, cheques, shifts } = deps;

  const session = (req: { session: unknown }) => {
    const s = req.session as { userId: string; pinUnlocked: boolean } | null;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    return s;
  };

  /** شعبه‌های این کاربر — `undefined` یعنی همه. */
  const scopeOf = async (userId: string): Promise<string[] | undefined> => {
    const scope = await branchesOf(db, userId);
    return scope === "all" ? undefined : scope;
  };

  // ── حساب‌های خزانه ─────────────────────────────────────────────────

  app.get("/treasury/accounts", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "treasury.manage");
    const q = z
      .object({
        kind: z.enum(["cash_box", "bank", "card_terminal", "gateway"]).optional(),
      })
      .parse(req.query ?? {});
    const branchIds = await scopeOf(s.userId);
    return {
      accounts: await treasury.accounts({
        ...q,
        ...(branchIds === undefined ? {} : { branchIds }),
      }),
    };
  });

  // ── حرکت نقد ───────────────────────────────────────────────────────

  app.get("/treasury/transactions", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "treasury.manage");
    const q = z
      .object({
        shiftId: uuid.optional(),
        purpose: z
          .enum([
            "supplier_payment",
            "customer_receipt",
            "expense",
            "capital",
            "transfer",
          ])
          .optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query ?? {});

    const branchIds = await scopeOf(s.userId);
    return {
      transactions: await treasury.list({
        ...(branchIds === undefined ? {} : { branchIds }),
        ...q,
      }),
    };
  });

  /**
   * ثبت حرکت نقد — ساخت و ثبت در یک تراکنش.
   *
   * ⚠️ دروازه کشو اینجاست: اگر حسابِ درگیر `cash_box` باشد و کاربر
   *    شیفت باز داشته باشد، `shift_id` **اجباری** است و باید همان
   *    شیفت باشد. بدون این، پول از کشو می‌رود و در شمارش پایان شیفت
   *    نمی‌آید — یک مغایرت کاذب که هیچ‌کس نمی‌تواند توضیحش بدهد.
   */
  app.post("/treasury/transactions", { config: MONEY_LIMIT }, async (req, reply) => {
    const s = session(req);
    const body = txBody.parse(req.body);
    await requireForSession(db, s, "treasury.manage", {
      amount: parseMoney(body.amount),
    });
    await assertBranch(db, s.userId, body.branchId);

    const input = {
      branchId: body.branchId,
      purpose: body.purpose as Purpose,
      amount: parseMoney(body.amount),
      fromAccountId: body.fromAccountId,
      toAccountId: body.toAccountId,
      partyType: body.partyType,
      partyId: body.partyId,
      expenseAccountCode: body.expenseAccountCode,
      refNo: body.refNo,
      note: body.note,
      actorId: s.userId,
      ...(body.occurredAt === undefined
        ? {}
        : { occurredAt: new Date(body.occurredAt) }),
    };

    const shiftId = await resolveShift(body.shiftId);
    const out = await runOnce<string>(db, {
      key: idempotencyKey(req),
      source: "api.treasury.transaction",
      payload: { actorId: s.userId, ...body, shiftId },
      run: async () => {
        const id = await treasury.createAndPost({
          ...input,
          ...(shiftId === null ? {} : { shiftId }),
        });
        return { value: id, ref: id };
      },
      replay: async (ref) => ref,
    });

    return reply
      .code(out.replayed ? 200 : 201)
      .send({ id: out.value, replayed: out.replayed });

    /**
     * دروازه کشو — بازگشت `null` یعنی این حرکت به شیفت ربطی ندارد.
     *
     * ⚠️ شیفت از **شعبه** گرفته می‌شود، نه از کاربر عامل. پولی که از
     *    کشو خارج می‌شود لزوماً به دست صاحب همان کشو خارج نمی‌شود:
     *    مدیر برای کرایه پیک از کشوی صندوق‌دار برمی‌دارد و خودش
     *    شیفتی ندارد. نسخه اول این دروازه شیفتِ خودِ کاربر را
     *    می‌خواست و همان هزینه واقعی را رد می‌کرد.
     */
    async function resolveShift(given: string | undefined): Promise<string | null> {
      if (!(await treasury.touchesCashBox(input))) {
        // حساب بانکی شیفت نمی‌خواهد. اگر کلاینت شیفت فرستاده، رد
        // می‌شود: شیفتی که به پول کشو ربط ندارد، شمارش را گمراه می‌کند.
        if (given !== undefined) {
          throw new TreasuryError(
            "shift_not_applicable",
            "این حرکت از کشوی صندوق رد نمی‌شود، پس شیفت نمی‌گیرد.",
            422,
          );
        }
        return null;
      }

      // تصمیم «کدام کشو» یک تعریف دارد: `treasury/cash-drawer.ts`.
      // مسیر مرجوعی هم از همان می‌گذرد — نسخه دومش شیفتِ خودِ کاربر را
      // می‌خواست و بازپرداخت نقدی را عملاً ناممکن کرده بود.
      const drawer = await resolveCashDrawer(shifts, body.branchId, given);
      if (!drawer.ok) throw new TreasuryError(drawer.code, drawer.message, drawer.status);
      return drawer.shiftId;
    }
  });

  // ── چک ─────────────────────────────────────────────────────────────

  app.get("/cheques", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "cheque.manage");
    const q = z
      .object({
        direction: z.enum(["received", "issued"]).optional(),
        status: optionalText(20),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      })
      .parse(req.query ?? {});

    const branchIds = await scopeOf(s.userId);
    return {
      cheques: await cheques.list({
        ...(branchIds === undefined ? {} : { branchIds }),
        ...q,
      }),
    };
  });

  /**
   * سررسیدها.
   *
   * ⚠️ `urgency` را دیتابیس حساب می‌کند، نه مرورگر. «امروز» یک تعریف
   *    دارد (`platform.business_date()`)؛ حساب‌کردنش در کلاینت یعنی
   *    چکی که روی سرور سررسیدشده است در مرورگر «فردا» دیده شود.
   */
  app.get("/cheques/due", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "cheque.manage");
    const branchIds = await scopeOf(s.userId);
    return { due: await cheques.due(branchIds) };
  });

  app.get("/cheques/:id", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "cheque.manage");
    const { id } = z.object({ id: uuid }).parse(req.params);

    const branchIds = await scopeOf(s.userId);
    const rows = await cheques.list({
      ...(branchIds === undefined ? {} : { branchIds }),
      limit: 500,
    });
    const found = rows.find((c) => c.id === id);
    if (!found) throw new ChequeError("cheque_not_found", "چک یافت نشد", 404);

    return { cheque: found, events: await cheques.events(id) };
  });

  app.post("/cheques", { config: MONEY_LIMIT }, async (req, reply) => {
    const s = session(req);
    const body = chequeBody.parse(req.body);
    await requireForSession(db, s, "cheque.manage", {
      amount: parseMoney(body.amount),
    });
    await assertBranch(db, s.userId, body.branchId);

    const out = await runOnce<string>(db, {
      key: idempotencyKey(req),
      source: "api.cheque.create",
      payload: { actorId: s.userId, ...body },
      run: async () => {
        const id = await cheques.create({
          ...body,
          amount: parseMoney(body.amount),
          actorId: s.userId,
        });
        return { value: id, ref: id };
      },
      replay: async (ref) => ref,
    });

    return reply
      .code(out.replayed ? 200 : 201)
      .send({ id: out.value, replayed: out.replayed });
  });

  /**
   * یک گذار روی ماشین وضعیت چک.
   *
   * کلید Idempotency از **خودِ عملیات** ساخته می‌شود اگر کلاینت
   * نفرستد: (چک، عمل) هویت این کار است. دو بار زدن «وصول شد» نباید
   * دو سند بزند — و `post_cheque_event` هم خودش گذار تکراری را رد
   * می‌کند، پس دو لایه دفاع.
   */
  app.post("/cheques/:id/events", { config: MONEY_LIMIT }, async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = eventBody.parse(req.body);
    await requireForSession(db, s, "cheque.manage");

    const out = await runOnce<{ ok: true }>(db, {
      key: idempotencyKey(req) ?? `cheque:${id}:${body.action}`,
      source: "api.cheque.event",
      payload: { actorId: s.userId, chequeId: id, ...body },
      run: async () => {
        await cheques.postEvent({
          chequeId: id,
          action: body.action,
          accountId: body.accountId,
          partyId: body.partyId,
          on: body.on,
          note: body.note,
          actorId: s.userId,
        });
        return { value: { ok: true as const }, ref: id };
      },
      replay: async () => ({ ok: true as const }),
    });

    return { ok: out.value.ok, replayed: out.replayed };
  });
}

function idempotencyKey(req: { headers: Record<string, unknown> }): string | undefined {
  const raw = req.headers["idempotency-key"];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}
