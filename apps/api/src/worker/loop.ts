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
  log: (line: string) => void;
}

export interface TickResult {
  claimed: number;
  sent: number;
  failed: number;
  dead: number;
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
    enqueuedCheques: 0,
    enqueuedAlerts: 0,
  };

  const settings = await readNotifySettings(opts.db);

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

  const claimed = await sql<{
    id: string;
    topic: string;
    payload: Record<string, unknown>;
    attempts: number;
  }>`
    SELECT * FROM platform.claim_outbox(
      ${opts.batchSize}::int, ${opts.workerName}::text, ${opts.leaseSeconds}::int)
  `.execute(opts.db);

  out.claimed = claimed.rows.length;
  if (claimed.rows.length === 0) return out;

  // ⚠️ ساخت فرستنده **بعد از** برداشتن پیام‌ها و داخل try: تنظیم
  //    غلط سرویس‌دهنده نباید کل دور را بشکند و پیام‌ها را در
  //    `sending` رها کند تا اجاره‌شان تمام شود.
  let sender;
  try {
    sender = makeSender({
      provider: settings.provider,
      sender: settings.sender,
      apiKey: opts.smsApiKey,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    for (const row of claimed.rows) {
      const status = await failMessage(opts, row.id, message, settings.maxAttempts, true);
      if (status === "dead") out.dead++;
      else out.failed++;
    }
    opts.log(`✗ سرویس‌دهنده پیامک: ${message}`);
    return out;
  }

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

  const ctx = { db: opts.db, settings, sms: sender, webhook, webPush };

  for (const row of claimed.rows) {
    const msg: OutboxMessage = {
      id: row.id,
      topic: row.topic,
      payload: row.payload ?? {},
      attempts: row.attempts,
    };

    const handler = HANDLERS[msg.topic];
    if (!handler) {
      // موضوع ناشناخته با تلاش دوباره شناخته نمی‌شود. مستقیم نامه
      // مرده، تا در `platform.outbox_dead` دیده شود.
      await failMessage(
        opts,
        msg.id,
        `موضوع ناشناخته: ${msg.topic}`,
        settings.maxAttempts,
        true,
      );
      out.dead++;
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
      await complete(opts, msg.id);
      out.sent++;
      continue;
    }

    try {
      const result = await handler(ctx, msg);
      await complete(opts, msg.id);
      out.sent++;
      opts.log(`✓ ${msg.topic} #${msg.id} — ${result.note}`);
    } catch (err) {
      const permanent = err instanceof SmsError && err.permanent;
      const message = err instanceof Error ? err.message : String(err);
      const status = await failMessage(
        opts,
        msg.id,
        message,
        settings.maxAttempts,
        permanent,
      );
      if (status === "dead") out.dead++;
      else out.failed++;
      opts.log(`✗ ${msg.topic} #${msg.id} — ${message}${status === "dead" ? " (مرده)" : ""}`);
    }
  }

  return out;
}

async function complete(opts: LoopOptions, id: string): Promise<void> {
  await sql`SELECT platform.complete_outbox(${id}::bigint)`.execute(opts.db);
}

async function failMessage(
  opts: LoopOptions,
  id: string,
  error: string,
  maxAttempts: number,
  permanent: boolean,
): Promise<string> {
  const r = await sql<{ fail_outbox: string }>`
    SELECT platform.fail_outbox(
      ${id}::bigint, ${error}::text, ${maxAttempts}::int, ${permanent}::boolean)
  `.execute(opts.db);
  return r.rows[0]?.fail_outbox ?? "pending";
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
  let running = true;
  let current: Promise<unknown> = Promise.resolve();

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      // تایمر نباید فرآیند را زنده نگه دارد وقتی همه‌چیز تمام شده.
      t.unref?.();
    });

  const loop = async () => {
    while (running) {
      try {
        current = tick(opts);
        const r = (await current) as TickResult;
        // دور خالی لاگ نمی‌خورد: Workerی که هر پنج ثانیه «کاری نبود»
        // بنویسد، لاگ را طوری پر می‌کند که خطای واقعی گم شود.
        if (r.claimed > 0 || r.enqueuedCheques > 0) {
          opts.log(
            `دور: ${r.claimed} برداشته، ${r.sent} فرستاده، ${r.failed} ناموفق، ` +
              `${r.dead} مرده، ${r.enqueuedCheques} هشدار چک تازه`,
          );
        }
      } catch (err) {
        // یک دور شکسته نباید Worker را بکشد: قطعی لحظه‌ای دیتابیس
        // عادی است و دور بعد معمولاً کار می‌کند.
        opts.log(`✗ دور ناموفق: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (running) await sleep(opts.intervalMs);
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
