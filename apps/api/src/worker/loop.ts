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

export interface LoopOptions {
  db: Db;
  /** نام این Worker — در `claimed_by` می‌نشیند، برای وقتی دوتا بالاست. */
  workerName: string;
  /** کلید سرویس پیامک. راز است و از محیط می‌آید، نه از تنظیمات. */
  smsApiKey: string;
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
}

/**
 * یک دور کامل.
 *
 * جدا از حلقه است تا تست بتواند **یک دور** را بدون تایمر و بدون
 * انتظار اجرا کند. حلقه‌ای که فقط با `setInterval` وجود داشته باشد،
 * فقط با `sleep` تست می‌شود — و تستی که `sleep` دارد، دیر یا زود
 * ناپایدار می‌شود.
 */
export async function tick(opts: LoopOptions): Promise<TickResult> {
  const out: TickResult = {
    claimed: 0,
    sent: 0,
    failed: 0,
    dead: 0,
    enqueuedCheques: 0,
  };

  const settings = await readNotifySettings(opts.db);

  // هشدار چک: تولید پیام، پیش از مصرف. اگر همین دور تولید شود، همین
  // دور هم فرستاده می‌شود.
  const cheques = await sql<{ n: number }>`
    SELECT treasury.enqueue_due_cheque_alerts() AS n
  `.execute(opts.db);
  out.enqueuedCheques = Number(cheques.rows[0]?.n ?? 0);

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

  const ctx = { db: opts.db, settings, sms: sender };

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

    // ⚠️ خاموش‌بودن پیامک یک شکست نیست: پیام موفق بسته می‌شود.
    //    Handler هم خودش همین را می‌کند، ولی این بررسی زودتر است و
    //    یک رفت‌وبرگشت دیتابیس کمتر می‌خورد.
    if (!settings.smsEnabled) {
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
