/**
 * مسیرهای برگشت از فروش.
 *
 * چهار دروازه پیش از هر نوشتنی، به همین ترتیب:
 *
 * ۱. **دامنه شعبه** — فاکتور باید شعبه‌ای باشد که کاربر به آن دسترسی دارد.
 * ۲. **مهلت** — داخل مهلت `return.same_day`، خارج از آن `return.late`.
 * ۳. **بازپرداخت** — هر پول برگشتی `refund.cash` می‌خواهد.
 * ۴. **کشو** — بازپرداخت نقدی بدون شیفت باز، شمارش صندوق را می‌شکند.
 *
 * دروازه چهارم در دیتابیس نیست و نمی‌تواند باشد: `post_return` یک
 * `treasury.payment` با `shift_id` برگ مرجوعی می‌سازد و اگر آن `NULL`
 * یا متعلق به شیفتِ بسته باشد، پول از کشو رفته ولی در شمارش نیامده
 * است. مغایرت کاذبی که هیچ‌کس نمی‌تواند توضیحش دهد.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AuthError } from "../auth/service.ts";
import { requireForSession } from "../auth/permission.ts";
import type { Db } from "../db/client.ts";
import { parseMoney } from "../lib/money.ts";
import { runOnce } from "../lib/idempotency.ts";
import { assertBranch, assertWarehouseInBranch } from "../sales/scope.ts";
import {
  ReturnError,
  returnToJson,
  returnableToJson,
  type ReturnService,
} from "../sales/return.ts";
import type { ShiftService } from "../sales/shift.ts";

const moneyString = z
  .string()
  .regex(/^\d+$/, "مبلغ باید رقم صحیح باشد (ریال، بدون اعشار)");

const uuid = z.string().uuid("شناسه نامعتبر");

/**
 * محدودیت نرخ روی مسیرهایی که پول را از کسب‌وکار خارج می‌کنند.
 *
 * `.claude/rules/api.md` آن را برای «Endpointهای پرداخت» خواسته و
 * بازپرداخت سنگین‌ترینشان است. سقف عمداً بالاست: یک صندوق‌دار در
 * شلوغ‌ترین ساعت هم چند مرجوعی در دقیقه نمی‌زند، ولی یک حلقه خودکار
 * صدها. محدودیتی که وسط شیفت واقعی فعال شود، از نبودش بدتر است.
 */
const MONEY_OUT_LIMIT = { rateLimit: { max: 30, timeWindow: "1 minute" } };

/**
 * شناسه‌های داده‌ای — کد علت و کد روش پرداخت.
 *
 * محدود به حروف کوچک، رقم و زیرخط. دو دلیل، هر دو واقعی:
 *
 * ۱. هر مقدار موجود در `return.reason_codes` و `treasury.payment_method`
 *    همین شکل را دارد، پس محدودیت چیزی را نمی‌شکند.
 * ۲. پیام خطای «این کد مجاز نیست» همان کد را به کاربر برمی‌گرداند.
 *    بازتاب ورودی خام در پاسخ، همان جایی است که XSS از آن شروع می‌شود
 *    — حتی اگر امروز UI نداریم و CSP هم بدون unsafe-inline است.
 *    ارزان‌ترین دفاع این است که چیزی برای بازتاب نماند.
 */
const dataCode = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/, "کد باید فقط حروف کوچک لاتین، رقم و زیرخط باشد");

const createReturnBody = z.object({
  invoiceId: uuid,
  reasonCode: dataCode,
  reasonNote: z.string().max(500).optional(),
  refundAmount: moneyString.default("0"),
  refundMethod: dataCode.optional(),
  lines: z
    .array(
      z.object({
        invoiceLineId: uuid,
        qty: z.string().regex(/^\d+(\.\d{1,3})?$/, "تعداد نامعتبر"),
        restock: z.boolean().optional(),
        condition: z.enum(["sellable", "defective"]).optional(),
      }),
    )
    .min(1, "برگ مرجوعی بدون قلم ساخته نمی‌شود")
    .max(200),
});

export interface ReturnRouteDeps {
  db: Db;
  returns: ReturnService;
  shifts: ShiftService;
}

export function registerReturnRoutes(app: FastifyInstance, deps: ReturnRouteDeps): void {
  const { db, returns } = deps;

  const session = (req: { session: unknown }) => {
    const s = req.session as
      | { userId: string; pinUnlocked: boolean; fullName: string }
      | null;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    return s;
  };

  /** آنچه از فاکتور هنوز قابل برگشت است — پیش‌نمایش صندوق. */
  app.get("/invoices/:id/returnable", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);

    const inv = await db
      .selectFrom("sales.invoice")
      .select(["branch_id", "status"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!inv) throw new ReturnError("invoice_not_found", "فاکتور یافت نشد", 404);
    await assertBranch(db, s.userId, inv.branch_id);

    const window = await returns.returnWindow(id);
    return {
      invoiceId: id,
      invoiceStatus: inv.status,
      // هر دو برمی‌گردند: صندوق‌دار «۲ روز پیش» را راحت‌تر می‌خواند،
      // ولی تصمیم «دیرهنگام» فقط از ساعت می‌آید — مهلت ۴۸ ساعته با
      // شمارش روز بیان‌شدنی نیست.
      daysSinceSale: window.daysSince,
      hoursSinceSale: window.hoursSince,
      late: window.late,
      lines: returnableToJson(await returns.returnable(id)),
    };
  });

  /**
   * ساخت برگ مرجوعی (پیش‌نویس).
   *
   * هنوز نه کالایی برمی‌گردد نه پولی — ولی مجوزها **همین‌جا** سنجیده
   * می‌شوند، چون همین‌جاست که تصمیم گرفته می‌شود. در `/post` دوباره
   * سنجیده می‌شوند، چون بین این دو ممکن است دسترسی پس گرفته شده باشد.
   */
  app.post("/returns", { config: MONEY_OUT_LIMIT }, async (req, reply) => {
    const s = session(req);
    const body = createReturnBody.parse(req.body);
    const refund = parseMoney(body.refundAmount);

    const inv = await db
      .selectFrom("sales.invoice")
      .select(["branch_id"])
      .where("id", "=", body.invoiceId)
      .executeTakeFirst();
    if (!inv) throw new ReturnError("invoice_not_found", "فاکتور یافت نشد", 404);
    await assertBranch(db, s.userId, inv.branch_id);

    const gate = await returnGate(deps, s, {
      invoiceId: body.invoiceId,
      branchId: inv.branch_id,
      refund,
      ...(body.refundMethod === undefined ? {} : { refundMethod: body.refundMethod }),
    });

    const r = await returns.createDraft({
      invoiceId: body.invoiceId,
      reasonCode: body.reasonCode,
      refundAmount: refund,
      lines: body.lines,
      actorId: s.userId,
      ...(body.reasonNote === undefined ? {} : { reasonNote: body.reasonNote }),
      ...(body.refundMethod === undefined ? {} : { refundMethod: body.refundMethod }),
      ...(gate.shiftId === undefined ? {} : { shiftId: gate.shiftId }),
    });
    return reply.code(201).send(returnToJson(r));
  });

  app.get("/returns/:id", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await returns.byId(id);
    if (!r) throw new ReturnError("return_not_found", "برگ مرجوعی یافت نشد", 404);
    await assertBranch(db, s.userId, r.branchId);
    return returnToJson(r);
  });

  /**
   * مقصد کالای سالمِ برگشتی — قفسه یا آوتلت.
   *
   * ⚠️ کالای **معیوب** اینجا نمی‌آید: `post_return` خودش هر سطری را
   * که `condition = 'defective'` باشد به انبار معیوب می‌فرستد، فارغ
   * از این انتخاب. مقصد اینجا فقط برای کالای قابل فروش است.
   *
   * تصمیم «به قفسه یا به آوتلت» انسانی است، نه نتیجه یک محاسبه —
   * مثل بستن سفارش خرید. سیستمی که خودش تصمیم بگیرد، کالای نو را
   * حراج می‌کند یا کالای فصل‌گذشته را به قفسه برمی‌گرداند.
   *
   * `Idempotency-Key` نمی‌خواهد: تعیین مقصد مطلق است نه افزایشی، و
   * ارسال دوباره همان نتیجه را می‌دهد. به همین دلیل `PUT` است.
   */
  app.put("/returns/:id/warehouse", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ warehouseId: uuid }).parse(req.body);

    const r = await returns.byId(id);
    if (!r) throw new ReturnError("return_not_found", "برگ مرجوعی یافت نشد", 404);

    // سه سنجش، نه یکی — همان الگوی `transfer-routes.ts`:
    // شعبه برگه، مجوز عملیات، و انبار مقصد.
    //
    // ⚠️ مجوزش همان `return.same_day` / `return.late` است که ساخت
    // پیش‌نویس می‌خواهد، نه یک عملیات تازه: تعیین مقصد بخشی از همان
    // برگه است و هیچ پولی جابه‌جا نمی‌کند. یک مجوز تازه یعنی یک ردیف
    // بیشتر در `permission_rule` که هیچ تصمیم متمایزی را نمایندگی
    // نمی‌کند — و مالک باید بفهمد تفاوتش با آن یکی چیست.
    await assertBranch(db, s.userId, r.branchId);
    const w = await returns.returnWindow(r.invoiceId);
    await requireForSession(db, s, w.late ? "return.late" : "return.same_day");
    await assertWarehouseInBranch(db, body.warehouseId, r.branchId);

    await returns.setWarehouse({
      id,
      warehouseId: body.warehouseId,
      actorId: s.userId,
    });
    const after = await returns.byId(id);
    return returnToJson(after!);
  });

  /**
   * ثبت مرجوعی — تنها جایی که کالا برمی‌گردد و پول خارج می‌شود.
   *
   * Idempotent با `Idempotency-Key`: کلیک دوم یا Retry شبکه نباید کالا
   * را دو بار به انبار برگرداند و دو بار پول بدهد. خودِ `post_return`
   * هم برگ ثبت‌شده را دوباره ثبت نمی‌کند، ولی آن لایه دوم است نه اول.
   */
  app.post("/returns/:id/post", { config: MONEY_OUT_LIMIT }, async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);

    const r = await returns.byId(id);
    if (!r) throw new ReturnError("return_not_found", "برگ مرجوعی یافت نشد", 404);
    await assertBranch(db, s.userId, r.branchId);

    if (r.status === "cancelled") {
      throw new ReturnError("return_cancelled", "برگ مرجوعی باطل‌شده ثبت نمی‌شود");
    }

    if (r.status !== "posted") {
      // مجوز دوباره سنجیده می‌شود: میان ساخت پیش‌نویس و ثبت آن،
      // ممکن است نقش کاربر عوض شده یا شیفتش بسته شده باشد.
      await returnGate(deps, s, {
        invoiceId: r.invoiceId,
        branchId: r.branchId,
        refund: r.refundAmount,
        ...(r.refundMethod === null ? {} : { refundMethod: r.refundMethod }),
        expectShiftId: r.shiftId,
      });
    }

    const out = await runOnce<{ number: string }>(db, {
      key: idempotencyKey(req),
      source: "api.return.post",
      payload: { returnId: id },
      run: async (trx) => {
        const number = await returns.postIn(trx, id, s.userId);
        return { value: { number }, ref: id };
      },
      replay: async (ref) => {
        const done = await returns.byId(ref);
        return { number: done?.number ?? "" };
      },
    });

    const posted = await returns.byId(id);
    return {
      ...returnToJson(posted as NonNullable<typeof posted>),
      replayed: out.replayed,
    };
  });

  /** رها کردن پیش‌نویس. مثل ابطال سبد، اثر مالی ندارد. */
  app.post("/returns/:id/cancel", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await returns.byId(id);
    if (!r) throw new ReturnError("return_not_found", "برگ مرجوعی یافت نشد", 404);
    await assertBranch(db, s.userId, r.branchId);
    await requireForSession(db, s, "sale.create");
    return returnToJson(await returns.cancelDraft(id, s.userId));
  });

  // ── دروازه مشترک ساخت و ثبت ─────────────────────────────────────

  /**
   * مهلت، مجوز بازپرداخت و شیفت — یک جا، تا ساخت و ثبت نتوانند از هم
   * جدا بیفتند.
   *
   * برمی‌گرداند: شیفتی که برگ مرجوعی باید به آن بچسبد (اگر لازم است).
   */
  async function returnGate(
    d: ReturnRouteDeps,
    s: { userId: string; pinUnlocked: boolean },
    input: {
      invoiceId: string;
      branchId: string;
      refund: bigint;
      refundMethod?: string | undefined;
      expectShiftId?: string | null | undefined;
    },
  ): Promise<{ shiftId: string | undefined }> {
    // ۱. مهلت. `return.same_day` را صندوق‌دار دارد؛ `return.late` را نه
    //    — یعنی مرجوعی دیرهنگام تصمیم سرپرست است. این داده است نه کد.
    const window = await d.returns.returnWindow(input.invoiceId);
    await requireForSession(
      db,
      s,
      window.late ? "return.late" : "return.same_day",
      { amount: input.refund },
    );

    if (input.refund === 0n) return { shiftId: undefined };

    // ۲. هر بازپرداختی — نقدی، کارتی یا کارت‌به‌کارت — `refund.cash`
    //    می‌خواهد. تنها مجوز بازپرداخت در `permission_rule` همین است و
    //    صندوق‌دار آن را ندارد. پول برگشتی، هر شکلی که داشته باشد،
    //    پولی است که از کسب‌وکار خارج می‌شود.
    await requireForSession(db, s, "refund.cash", { amount: input.refund });

    const method = input.refundMethod ?? "cash";
    const { kind } = await d.returns.assertRefundMethod(method);
    if (kind !== "cash") return { shiftId: undefined };

    // ۳. بازپرداخت نقدی باید در یک شیفت **باز** بنشیند.
    const shift = await d.shifts.current(s.userId, input.branchId);
    if (!shift) {
      throw new ReturnError(
        "no_open_shift",
        "بازپرداخت نقدی بدون شیفت باز ممکن نیست — پول از کشو خارج می‌شود و در شمارش نمی‌آید.",
        422,
      );
    }
    // پیش‌نویسی که برای شیفت دیروز ساخته شده، امروز ثبت نمی‌شود:
    // شیفت دیروز بسته و شمارشش انجام شده است.
    if (input.expectShiftId !== undefined && input.expectShiftId !== shift.id) {
      throw new ReturnError(
        "shift_changed",
        "شیفت این برگ مرجوعی دیگر باز نیست. برگ تازه بزنید.",
        409,
      );
    }
    return { shiftId: shift.id };
  }
}

function idempotencyKey(req: { headers: Record<string, unknown> }): string | undefined {
  const raw = req.headers["idempotency-key"];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}
