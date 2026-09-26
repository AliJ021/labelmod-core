/**
 * مسیرهای دوره ثبت.
 *
 * دو کار: دیدن درآمدی که هنوز به دفتر نرفته، و بستن دوره کانال آنلاین.
 *
 * بستن دوره، `period.close` می‌خواهد — نه `shift.close`. بستن کشو کار
 * صندوق است و بستن دوره کار حسابدار؛ در `permission_rule` هم همین
 * است. اگر یکی شوند، صندوق‌دار می‌تواند سند فروش سایت بزند.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AuthError } from "../auth/service.ts";
import { requireForSession } from "../auth/permission.ts";
import type { Db } from "../db/client.ts";
import { runOnce } from "../lib/idempotency.ts";
import { assertBranch, branchesOf } from "../sales/scope.ts";
import {
  BatchError,
  unpostedToJson,
  type PostingBatchService,
} from "../sales/posting-batch.ts";

const uuid = z.string().uuid("شناسه نامعتبر");
// تقویم واقعی، نه فقط شکل رشته: «۲۰۲۶-۱۳-۴۵» شکل درستی دارد ولی
// تاریخ نیست، و تا `::date` در `close_channel_day` می‌رفت و آنجا ۵۰۰
// می‌داد نه ۴۰۰. `z.iso.date()` ماه، روزِ ماه و کبیسه را می‌سنجد.
const isoDate = z.iso.date("تاریخ باید یک تاریخ معتبر YYYY-MM-DD باشد");

const closeChannelDayBody = z.object({
  branchId: uuid,
  channel: z.enum(["web", "phone", "pos"]),
  date: isoDate,
});

export interface PostingRouteDeps {
  db: Db;
  batches: PostingBatchService;
}

export function registerPostingRoutes(app: FastifyInstance, deps: PostingRouteDeps): void {
  const { db, batches } = deps;

  const session = (req: { session: unknown }) => {
    const s = req.session as
      | { userId: string; pinUnlocked: boolean; fullName: string }
      | null;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    return s;
  };

  /**
   * درآمد ثبت‌نشده — همان زنگ خطری که README وعده‌اش را داده بود.
   *
   * فقط شعبه‌های خود کاربر. مدیر و حسابدار (`branch_id IS NULL`) همه را
   * می‌بینند.
   */
  app.get("/posting-batches/unposted", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "cost.view");
    const scope = await branchesOf(db, s.userId);
    return { rows: unpostedToJson(await batches.unposted(scope)) };
  });

  /**
   * بستن همه دوره‌های کانالِ روزهای گذشته — مسیرِ کار شبانه.
   *
   * **موجودی را دست نمی‌زند.** کالا همان لحظه فروش از انبار خارج
   * شده؛ اینجا فقط سند حسابداری بسته می‌شود.
   *
   * عمداً `Idempotency-Key` نمی‌گیرد: خودِ عملیات تکرارپذیر است —
   * `post_batch` دوره `posted` را دوباره ثبت نمی‌کند و اجرای دوم
   * فهرست خالی برمی‌گرداند.
   *
   * پشت `period.close` است، نه `shift.close`: بستن دوره کار حسابدار
   * است، نه کار صندوق.
   */
  app.post("/posting-batches/close-due", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "period.close");
    const scope = await branchesOf(db, s.userId);
    const closed = await batches.closeDue(s.userId, scope);
    return {
      closed: closed.filter((c) => c.skipped === null),
      skipped: closed.filter((c) => c.skipped !== null),
    };
  });

  /**
   * بستن دوره کانال — سند فروش و COGS یک روز از یک کانال.
   *
   * Idempotent با کلیدی که **از خودِ عملیات** ساخته می‌شود، نه از هدر:
   * هویت این کار همان (شعبه، کانال، تاریخ) است و دو بار بستنِ یک روز
   * باید همان یک سند را بدهد — حتی اگر فراخوان هدر نفرستد یا دو هدر
   * متفاوت بفرستد. هدر اینجا عمداً نادیده گرفته می‌شود؛ پذیرفتنش تنها
   * راهِ دور زدن این قفل بود.
   *
   * `post_batch` هم دوره `posted` را دوباره ثبت نمی‌کند، ولی آن لایه
   * دوم است نه اول.
   */
  app.post("/posting-batches/close-channel-day", async (req) => {
    const s = session(req);
    const body = closeChannelDayBody.parse(req.body);
    await assertBranch(db, s.userId, body.branchId);
    await requireForSession(db, s, "period.close");

    const existing = await batches.channelDay(body.branchId, body.channel, body.date);
    if (!existing) {
      throw new BatchError(
        "batch_not_found",
        `دوره ثبتی برای کانال «${body.channel}» در تاریخ ${body.date} وجود ندارد (هیچ فاکتوری نهایی نشده است).`,
        404,
      );
    }

    const key = `channel-day:${body.branchId}:${body.channel}:${body.date}`;

    const out = await runOnce<{ saleEntry: string | null; cogsEntry: string | null }>(
      db,
      {
        key,
        source: "api.batch.close_channel_day",
        payload: { branchId: body.branchId, channel: body.channel, date: body.date },
        run: async (trx) => {
          const r = await batches.closeChannelDayIn(trx, {
            branchId: body.branchId,
            channel: body.channel,
            date: body.date,
            actorId: s.userId,
          });
          return { value: r, ref: existing.id };
        },
        replay: async () => {
          const b = await db
            .selectFrom("ledger.posting_batch")
            .select(["sale_entry_id", "cogs_entry_id"])
            .where("id", "=", existing.id)
            .executeTakeFirst();
          return {
            saleEntry: b?.sale_entry_id ?? null,
            cogsEntry: b?.cogs_entry_id ?? null,
          };
        },
      },
    );

    return {
      batchId: existing.id,
      branchId: body.branchId,
      channel: body.channel,
      date: body.date,
      saleEntry: out.value.saleEntry,
      cogsEntry: out.value.cogsEntry,
      replayed: out.replayed,
    };
  });
}
