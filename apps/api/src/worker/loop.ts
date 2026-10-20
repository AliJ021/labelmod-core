/**
 * حلقه Worker — برداشتن، فرستادن، بستن.
 *
 * ── چرا Polling و نه LISTEN/NOTIFY ──────────────────────────────────
 *
 * `LISTEN/NOTIFY` پستگرس سریع‌تر است ولی **تحویل تضمین‌شده ندارد**:
 * اگر Worker در لحظه NOTIFY وصل نباشد، آن اعلان برای همیشه رفته و
 * پیام تا وقتی کسی دستی نگاه نکند در صف می‌ماند. آن‌وقت باید یک
 * Polling پشتیبان هم می‌داشتیم — یعنی دو مسیر به‌جای یکی.
 *
 * برای فروشگاهی با چند ده پیام در روز، یک SELECT هر چند ثانیه هیچ
 * هزینه‌ای نیست. سادگی برنده است.
 *
 * ── و چرا تولیدکننده هشدار چک هم اینجاست ────────────────────────────
 *
 * چک برخلاف فاکتور رویدادی ندارد که هشدارش را بزند؛ فقط تاریخ نزدیک
 * می‌شود. یک cron جدا می‌شد یک قطعه متحرک تازه که ممکن است نصب نشود.
 * `enqueue_due_cheque_alerts()` روی کلید (چک، روز کاری) Idempotent است،
 * پس فراخوانی ساعتی‌اش بی‌ضرر است.
 */
import { sql } from "kysely";
import type { Db } from "../db/client.ts";
import { HANDLERS, type OutboxMessage } from "./handlers.ts";
import { readMeliKey } from "../platform/melipayamak-credential.ts";
import { makeSender, SmsError } from "./sms.ts";
import { readNotifySettings } from "./settings.ts";
import { makeWebhookSender } from "./webhook.ts";
import { makeWebPushSender } from "./web-push.ts";

export interface LoopOptions {
  db: Db;
  /** نام این Worker — در `claimed_by` می‌نشیند، برای وقتی دوتا بالاست. */
  workerName: string;
  /** کلید سرویس پیامک. راز است و از محیط می‌آید، نه از تنظیمات. */
  smsApiKey: string;
  smsCredentialKey?: string | undefined;
  /**
   * توکن Webhook. مثل کلید پیامک راز است و از محیط می‌آید
   * (`NOTIFY_WEBHOOK_TOKEN`)، نه از `platform.setting` — مقدار هر تنظیم
   * در `audit_log` می‌نشیند و صفحهٔ تنظیمات نشانش می‌دهد.
   */
  webhookToken: string | undefined;
  /**
   * کلید امضای Push سایت — از `WEB_PUSH_SECRET`.
   *
   * ⚠️ همان قاعدهٔ `SMS_API_KEY`: مقدار هر `platform.setting` در
   *    `audit_log` می‌نشیند و صفحهٔ تنظیمات نشانش می‌دهد. یک راز
   *    نباید هیچ‌کدام را ببیند.
   */
  webPushSecret: string | undefined;
  /**
   * وابستگی‌های فرستندهٔ Push — **فقط برای تست یکپارچه**.
   *
   * ⚠️ هیچ مسیر تولیدی این را ست نمی‌کند و `worker.ts` اصلاً پاسش
   *    نمی‌دهد؛ یک بند در `source-hygiene.test.ts` همین را قفل کرده.
   *    دلیل وجودش این است که تست یکپارچه باید به یک گیرندهٔ **واقعی
   *    روی 127.0.0.1** برسد، و نگهبان SSRF (به‌درستی) نشانی داخلی را
   *    رد می‌کند. ضعیف‌کردن آن نگهبان برای تست، همان کلاسی است که این
   *    مخزن جای دیگر ممنوع کرده — پس به‌جایش مقصد در خودِ تست نگاشت
   *    می‌شود و نگهبان دست‌نخورده می‌ماند.
   */
  webPushDeps?: Parameters<typeof makeWebPushSender>[1];
  batchSize: number;
  leaseSeconds: number;
  /**
   * کدام خطِ موضوع‌ها (`WORKER_LANES`). پیش‌فرض `all`: یک Worker برای همه،
   * همان رفتار پیش از تفکیک.
   */
  lane?: WorkerLane | undefined;
  log: (line: string) => void;
}

/**
 * موضوع‌های Push سایت — خطِ `web`.
 *
 * ⚠️ تقسیم با **مکمل** است، نه با دو فهرست: خط `notify` همه‌چیز است جز
 *    همین‌ها (`p_exclude`). پس دو خط هرگز هم‌پوشانی ندارند و با هم کامل‌اند،
 *    حتی برای موضوعی که فردا اضافه شود یا اصلاً Handler نداشته باشد (آن
 *    در `notify` نامهٔ مرده می‌شود، نه اینکه هیچ‌کس برش ندارد).
 *    `worker-lanes.test.ts` همین را روی `HANDLERS` می‌سنجد.
 */
export const WEB_TOPICS = ["web.stock_push", "web.price_push", "web.instore_push"] as const;

export type WorkerLane = "all" | "web" | "notify";

export const WORKER_LANES: Record<WorkerLane, {
  topics: readonly string[] | null;
  exclude: readonly string[] | null;
  /** هشدار چک و سلامت را می‌سازد؟ فقط خطی که مصرف‌کنندهٔ همان موضوع‌هاست. */
  producers: boolean;
}> = {
  all: { topics: null, exclude: null, producers: true },
  web: { topics: WEB_TOPICS, exclude: null, producers: false },
  notify: { topics: null, exclude: WEB_TOPICS, producers: true },
};

/**
 * بیشینهٔ زمان یک پیام: پیامک ۲۰ ثانیه + Webhook ۱۰ ثانیه برای فاکتور،
 * با حاشیهٔ دوبرابر. اجاره پیش از **هر** پیام تمدید می‌شود، پس فقط باید
 * یک پیام را بپوشاند، نه کل دسته — ولی کمتر از این یعنی پیام وسط ارسال
 * به Worker دیگری برسد.
 */
export const MESSAGE_BUDGET_SECONDS = 60;

export interface TickResult {
  claimed: number;
  sent: number;
  failed: number;
  dead: number;
  /** پیامی که اجاره‌اش به Worker دیگری رسید؛ این Worker هیچ وضعیتی از آن را عوض نکرد. */
  lost: number;
  enqueuedCheques: number;
  enqueuedAlerts: number;
}

/**
 * یک دور کامل.
 *
 * جدا از حلقه است تا تست بتواند **یک دور** را بدون تایمر و بدون
 * انتظار اجرا کند. حلقه‌ای که فقط با `setInterval` وجود داشته باشد،
 * فقط با `sleep` تست می‌شود — و تستی که `sleep` دارد، دیر یا زود
 * ناپایدار می‌شود.
 */
/**
 * موضوع‌هایی که **تنها** کانالشان پیامک است.
 *
 * ⚠️ افزودن موضوع تازه به اینجا یعنی «اگر پیامک خاموش باشد، این پیام
 *    اصلاً کاری ندارد». برای موضوعی که کانال دیگری هم دارد (Webhook،
 *    Push سایت) این **غلط** است و پیام را بی‌صدا می‌بلعد.
 */
const SMS_ONLY_TOPICS = new Set(["invoice.finalized", "cheque.due"]);

export async function tick(opts: LoopOptions): Promise<TickResult> {
  const out: TickResult = {
    claimed: 0,
    sent: 0,
    failed: 0,
    dead: 0,
    lost: 0,
    enqueuedCheques: 0,
    enqueuedAlerts: 0,
  };

  assertLease(opts.leaseSeconds);
  const lane = WORKER_LANES[opts.lane ?? "all"];
  const settings = await readNotifySettings(opts.db);

  // تولیدکننده‌ها فقط در خطی که مصرف‌کنندهٔ پیامشان است (نه `web`).
  if (lane.producers) {
    // هشدار چک: تولید پیام، پیش از مصرف. اگر همین دور تولید شود، همین
    // دور هم فرستاده می‌شود.
    const cheques = await sql<{ n: number }>`
      SELECT treasury.enqueue_due_cheque_alerts() AS n
    `.execute(opts.db);
    out.enqueuedCheques = Number(cheques.rows[0]?.n ?? 0);

    /*
     * زنگ خطر سیستم — همان‌جا و به همان دلیل که هشدار چک اینجاست.
     *
     * هشت زنگ از قبل بودند و کار می‌کردند؛ آنچه نبود، رسیدنشان به آدم
     * بود: همه فقط با اجرای دستی `ops/deploy.sh status` دیده می‌شدند.
     * `enqueue_health_alerts()` روی کلید (کد زنگ، روز کاری) Idempotent
     * است، پس فراخوانی ساعتی‌اش حداکثر یک پیام در روز می‌سازد.
     */
    const alerts = await sql<{ n: number }>`
      SELECT platform.enqueue_health_alerts() AS n
    `.execute(opts.db);
    out.enqueuedAlerts = Number(alerts.rows[0]?.n ?? 0);
  }

  const claimed = await sql<{
    id: string;
    topic: string;
    payload: Record<string, unknown>;
    attempts: number;
    claim_token: string;
  }>`
    SELECT * FROM platform.claim_outbox(
      ${opts.batchSize}::int, ${opts.workerName}::text, ${opts.leaseSeconds}::int,
      ${lane.topics === null ? null : [...lane.topics]}::text[],
      ${lane.exclude === null ? null : [...lane.exclude]}::text[])
  `.execute(opts.db);

  out.claimed = claimed.rows.length;
  if (claimed.rows.length === 0) return out;

  // خطای تنظیم پیامک فقط هنگام ارسال همان پیام اثر دارد؛ Push سایت مستقل است.
  const sender = {
    async send(to: string, text: string) {
      const apiKey = settings.provider === "melipayamak"
        ? await readMeliKey(opts.db, opts.smsCredentialKey) : opts.smsApiKey;
      await makeSender({ provider: settings.provider, sender: settings.sender, apiKey }).send(to, text);
    },
  };

  /*
   * ⚠️ فرستندهٔ Webhook هم مثل فرستندهٔ پیامک **بعد از** برداشتن پیام‌ها
   *    ساخته می‌شود. خاموش‌بودنش خطا نیست — `makeWebhookSender` خودش
   *    بی‌صدا برمی‌گردد — پس اینجا `try` لازم ندارد.
   */
  const webhook = makeWebhookSender({
    enabled: settings.webhookEnabled,
    url: settings.webhookUrl,
    token: opts.webhookToken,
  });

  const webPush = makeWebPushSender({
    enabled: settings.webPushEnabled,
    baseUrl: settings.webSiteUrl,
    secret: opts.webPushSecret,
  }, opts.webPushDeps);

  const ctx = { db: opts.db, settings, sms: sender, smsCredentialKey: opts.smsCredentialKey, webhook, webPush };

  for (const row of claimed.rows) {
    const msg: OutboxMessage = {
      id: row.id,
      topic: row.topic,
      payload: row.payload ?? {},
      attempts: row.attempts,
    };
    const lease: Lease = { id: row.id, token: row.claim_token };

    /*
     * ⚠️ تمدید پیش از هر پیام، با همان توکن. دسته پشت سر هم فرستاده
     *    می‌شود و انتهایش ممکن است پیش از نوبتش منقضی و به Worker دیگری
     *    رسیده باشد. `false` یعنی مالک دیگری دارد: نه فرستاده می‌شود، نه
     *    بسته — وگرنه همان تحویل دوگانه‌ای بود که اجاره برای جلوگیری از آن
     *    است.
     */
    if (!(await renew(opts, lease))) {
      out.lost++;
      opts.log(`↷ ${msg.topic} #${msg.id} — اجاره به Worker دیگری رسید؛ فرستاده نشد`);
      continue;
    }

    const handler = HANDLERS[msg.topic];
    if (!handler) {
      // موضوع ناشناخته با تلاش دوباره شناخته نمی‌شود. مستقیم نامه
      // مرده، تا در `platform.outbox_dead` دیده شود.
      const status = await failMessage(
        opts,
        lease,
        `موضوع ناشناخته: ${msg.topic}`,
        settings.maxAttempts,
        true,
        null,
      );
      if (status === "lost") out.lost++;
      else out.dead++;
      continue;
    }

    /*
     * ⚠️ خاموش‌بودن پیامک یک شکست نیست: پیام موفق بسته می‌شود.
     *
     * ⚠️ **ولی فقط برای موضوع‌هایی که تنها کانالشان پیامک است.** نسخهٔ
     *    قبلی این شرط را روی **همهٔ** موضوع‌ها می‌زد، و آن یک باگ واقعی
     *    بود که با ADR-007 پیدا شد:
     *
     *      notify.sms_enabled = false  +  notify.webhook_enabled = true
     *      → هشدار سلامت **بی‌صدا بسته می‌شد** و هیچ Webhookی نمی‌رفت.
     *
     *    یعنی همان کلاس FND-021 دوباره: یک کلید تنظیم که روشن است و
     *    هیچ کاری نمی‌کند. Push سایت هم از همین‌جا رد می‌شد — پیام
     *    `sent` علامت می‌خورد بی‌آنکه هرگز فرستاده شود.
     */
    if (!settings.smsEnabled && SMS_ONLY_TOPICS.has(msg.topic)) {
      if (await complete(opts, lease)) out.sent++;
      else out.lost++;
      continue;
    }

    let result: Awaited<ReturnType<typeof handler>>;
    try {
      result = await handler(ctx, msg);
    } catch (err) {
      const permanent = err instanceof SmsError && err.permanent;
      const retryAfter = err instanceof SmsError ? err.retryAfterSeconds : null;
      const message = err instanceof Error ? err.message : String(err);
      const status = await failMessage(
        opts,
        lease,
        message,
        settings.maxAttempts,
        permanent,
        retryAfter,
      );
      if (status === "lost") {
        out.lost++;
        opts.log(`↷ ${msg.topic} #${msg.id} — شکست خورد ولی اجاره دیگر مال این Worker نبود؛ ثبت نشد`);
        continue;
      }
      if (status === "dead") out.dead++;
      else out.failed++;
      opts.log(`✗ ${msg.topic} #${msg.id} — ${message}${status === "dead" ? " (مرده)" : ""}`);
      continue;
    }

    /*
     * ⚠️ فرستاده شد ولی بستن رد شد: اجاره وسط ارسال به Worker دیگری رسید.
     *    وضعیت مال مالک تازه است و دست نمی‌خورد؛ تحویل «حداقل یک بار» است
     *    و Handlerها Idempotent‌اند. این «فرستاده» شمرده نمی‌شود.
     */
    if (await complete(opts, lease)) {
      out.sent++;
      opts.log(`✓ ${msg.topic} #${msg.id} — ${result.note}`);
    } else {
      out.lost++;
      opts.log(`↷ ${msg.topic} #${msg.id} — فرستاده شد ولی اجاره به Worker دیگری رسیده بود؛ بسته نشد`);
    }
  }

  return out;
}

/** شناسه و توکن اجارهٔ همین برداشت — بستن و تمدید فقط با هر دو. */
interface Lease {
  id: string;
  token: string;
}

export function assertLease(leaseSeconds: number): void {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < MESSAGE_BUDGET_SECONDS || leaseSeconds > 3600) {
    throw new Error(
      `مهلت اجارهٔ Worker باید بین ${MESSAGE_BUDGET_SECONDS} و ۳۶۰۰ ثانیه باشد تا یک پیام را بپوشاند: ${leaseSeconds}`,
    );
  }
}

async function renew(opts: LoopOptions, lease: Lease): Promise<boolean> {
  const r = await sql<{ ok: boolean }>`
    SELECT platform.renew_outbox(
      ${lease.id}::bigint, ${lease.token}::uuid, ${opts.leaseSeconds}::int) AS ok
  `.execute(opts.db);
  return r.rows[0]?.ok === true;
}

async function complete(opts: LoopOptions, lease: Lease): Promise<boolean> {
  const r = await sql<{ ok: boolean }>`
    SELECT platform.complete_outbox(${lease.id}::bigint, ${lease.token}::uuid) AS ok
  `.execute(opts.db);
  return r.rows[0]?.ok === true;
}

async function failMessage(
  opts: LoopOptions,
  lease: Lease,
  error: string,
  maxAttempts: number,
  permanent: boolean,
  retryAfterSeconds: number | null,
): Promise<"pending" | "dead" | "lost"> {
  const r = await sql<{ status: string }>`
    SELECT platform.fail_outbox(
      ${lease.id}::bigint, ${lease.token}::uuid, ${error}::text, ${maxAttempts}::int,
      ${permanent}::boolean, ${retryAfterSeconds}::int) AS status
  `.execute(opts.db);
  const status = r.rows[0]?.status;
  if (status === "pending" || status === "dead" || status === "lost") return status;
  throw new Error(`پاسخ نامعتبر fail_outbox: ${String(status)}`);
}

/**
 * زمان دور بعد — محدود در هر سه حالت.
 *
 * - **دستهٔ پر** یعنی صف عقب است: دور بعد بی‌درنگ، ولی حداکثر
 *   `MAX_BACKLOG_STREAK` بار پیاپی؛ بعد یک فاصلهٔ عادی تا دیتابیس و لاگ
 *   نفس بکشند.
 * - **دستهٔ ناقص یا خالی**: همان `intervalMs` (پیکربندی ۵۰۰ تا ۶۰۰٬۰۰۰).
 * - **خطای دور** (قطعی دیتابیس): دو برابر شونده از `intervalMs` با سقف
 *   `max(intervalMs, MAX_ERROR_BACKOFF_MS)`؛ اولین دور سالم صفرش می‌کند.
 */
export const MAX_BACKLOG_STREAK = 50;
export const MAX_ERROR_BACKOFF_MS = 60_000;

export interface PaceState {
  backlog: number;
  errors: number;
}

export function nextPace(
  state: PaceState,
  outcome: { ok: true; claimed: number } | { ok: false },
  intervalMs: number,
  batchSize: number,
): { delayMs: number; state: PaceState } {
  if (!outcome.ok) {
    const errors = state.errors + 1;
    const cap = Math.max(intervalMs, MAX_ERROR_BACKOFF_MS);
    return { delayMs: Math.min(intervalMs * 2 ** Math.min(errors, 20), cap), state: { backlog: 0, errors } };
  }
  if (outcome.claimed >= batchSize && state.backlog < MAX_BACKLOG_STREAK) {
    return { delayMs: 0, state: { backlog: state.backlog + 1, errors: 0 } };
  }
  return { delayMs: intervalMs, state: { backlog: 0, errors: 0 } };
}

/**
 * حلقه بی‌پایان، تا وقتی `stop` صدا زده شود.
 *
 * ── خاموشی تمیز، و چرا اهمیت دارد ───────────────────────────────────
 *
 * `docker compose down` یک `SIGTERM` می‌فرستد و ده ثانیه صبر می‌کند.
 * Workerی که وسط ارسال کشته شود، پیامش در `sending` می‌ماند و تا
 * پایان اجاره دوباره برداشته نمی‌شود — یعنی پیامک فاکتور دو دقیقه دیر
 * می‌رسد. با خاموشی تمیز، دورِ جاری تمام می‌شود و بعد بیرون می‌آییم.
 */
export function runLoop(
  opts: LoopOptions & { intervalMs: number },
): { stop: () => Promise<void> } {
  assertLease(opts.leaseSeconds);
  let running = true;
  let current: Promise<unknown> = Promise.resolve();
  let pace: PaceState = { backlog: 0, errors: 0 };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      // صفر هم یک بار Event Loop را آزاد می‌کند؛ صف عقب‌افتاده خاموشی را
      // گروگان نمی‌گیرد.
      if (ms === 0) { setImmediate(resolve); return; }
      const t = setTimeout(resolve, ms);
      // تایمر نباید فرآیند را زنده نگه دارد وقتی همه‌چیز تمام شده.
      t.unref?.();
    });

  const loop = async () => {
    while (running) {
      let outcome: { ok: true; claimed: number } | { ok: false };
      try {
        current = tick(opts);
        const r = (await current) as TickResult;
        outcome = { ok: true, claimed: r.claimed };
        // دور خالی لاگ نمی‌خورد: Workerی که هر پنج ثانیه «کاری نبود»
        // بنویسد، لاگ را طوری پر می‌کند که خطای واقعی گم شود.
        if (r.claimed > 0 || r.enqueuedCheques > 0) {
          opts.log(
            `دور: ${r.claimed} برداشته، ${r.sent} فرستاده، ${r.failed} ناموفق، ` +
              `${r.dead} مرده، ${r.lost} اجارهٔ ازدست‌رفته، ${r.enqueuedCheques} هشدار چک تازه`,
          );
        }
      } catch (err) {
        // یک دور شکسته نباید Worker را بکشد: قطعی لحظه‌ای دیتابیس
        // عادی است و دور بعد معمولاً کار می‌کند.
        outcome = { ok: false };
        opts.log(`✗ دور ناموفق: ${err instanceof Error ? err.message : String(err)}`);
      }
      const next = nextPace(pace, outcome, opts.intervalMs, opts.batchSize);
      pace = next.state;
      if (running) await sleep(next.delayMs);
    }
  };

  const done = loop();

  return {
    async stop() {
      running = false;
      await current.catch(() => undefined);
      await done.catch(() => undefined);
    },
  };
}
