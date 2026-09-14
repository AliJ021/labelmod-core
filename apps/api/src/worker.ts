/**
 * نقطه ورود Worker.
 *
 *   node --experimental-strip-types apps/api/src/worker.ts
 *
 * ── چرا داخل همین بسته و نه یک بسته جدا ─────────────────────────────
 *
 * ADR-001 صریح گفته: «Worker: همان کدبیس». دلیلش اینجا خیلی ملموس
 * است — این کد `platform.setting`، `Db`، `parseMoney` و صفحه فاکتور
 * را با API **مشترک** دارد. بسته جدا یعنی یا کپی، یا یک بسته سومِ
 * مشترک برای صرفه‌جویی در چیزی که مشکلی نبود.
 *
 * در استقرار، همان ایمیج با دستور دیگری بالا می‌آید.
 *
 * ── و چرا یک فرآیند جدا از API ──────────────────────────────────────
 *
 * ارسال پیامک ثانیه‌ها طول می‌کشد. داخل فرآیند API، همان Event Loop
 * که باید فاکتور صندوق را جواب بدهد منتظر سرویس پیامک می‌ماند —
 * بودجه «افزودن قلم زیر ۱۰۰ میلی‌ثانیه» (ADR-002) با یک قطعی سرویس
 * پیامک از بین می‌رفت.
 */
import { hostname } from "node:os";
import { loadConfig } from "./lib/config.ts";
import { createDb } from "./db/client.ts";
import { runLoop } from "./worker/loop.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  // استخر کوچک: Worker یک حلقه ترتیبی است، نه یک سرور همزمان.
  const handle = createDb(config.DATABASE_URL, 3);

  const workerName = `${hostname()}:${process.pid}`;
  const log = (line: string) => process.stdout.write(`${line}\n`);

  log(`Worker لیبل مد بالا آمد — ${workerName}`);
  if (!config.SMS_API_KEY) {
    log(
      "⚠️  SMS_API_KEY تنظیم نشده. با سرویس‌دهنده «log» مشکلی نیست؛" +
        " برای ارسال واقعی لازم است.",
    );
  }

  const loop = runLoop({
    db: handle.db,
    workerName,
    smsApiKey: config.SMS_API_KEY ?? "",
    webhookToken: config.NOTIFY_WEBHOOK_TOKEN,
    webPushSecret: config.WEB_PUSH_SECRET,
    batchSize: config.WORKER_BATCH,
    leaseSeconds: config.WORKER_LEASE_SECONDS,
    intervalMs: config.WORKER_INTERVAL_MS,
    log,
  });

  // خاموشی تمیز: دورِ جاری تمام شود، بعد بیرون. پیامی که وسط ارسال
  // رها شود تا پایان اجاره دوباره برداشته نمی‌شود.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} — در حال خاموشی…`);
    await loop.stop();
    await handle.close();
    log("خاموش شد.");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

if (process.argv[1]?.endsWith("worker.ts")) {
  await main();
}
