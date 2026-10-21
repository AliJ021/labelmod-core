import { randomBytes } from "node:crypto";
import { request } from "node:https";
import { isIP } from "node:net";
import { z } from "zod";
import { pinnedLookup, resolveSafeTarget, signBody, type PinnedTarget, type HttpRequestFn } from "../worker/web-push.ts";

const uuidOrEmpty = z.union([z.string().uuid(), z.literal("")]);
export const wooReport = z.object({
  protocol: z.literal(1), pluginVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  wooVersion: z.string().regex(/^(?:\d+\.\d+(?:\.\d+)?(?:[-.][a-zA-Z0-9]+)*|unknown)$/).max(40), siteUrl: z.string().url().max(500),
  branchId: uuidOrEmpty, warehouseId: uuidOrEmpty,
  apiKeyConfigured: z.boolean(), pushConfigured: z.boolean().optional(), stockPolling: z.boolean(), pricePolling: z.boolean(),
  cronDisabled: z.boolean(), stockScheduled: z.boolean(),
  mapping: z.object({ linkedProducts: z.number().int().nonnegative().nullable(), orderIdentity: z.literal("sku"), stockIdentity: z.literal("variationId") }),
  order: z.object({
    found: z.boolean(), status: z.enum(["", "pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed", "unknown"]), paymentConfirmed: z.boolean(),
    eligible: z.boolean(), recorded: z.boolean(), scheduled: z.boolean(),
    attempts: z.number().int().nonnegative(), hasError: z.boolean(),
    missingSku: z.number().int().nonnegative(), missingMapping: z.number().int().nonnegative(),
  }).nullable(),
  // تله‌متری صف بحرانی افزونه (سفارش/مرجوعی/رزرو → Core). جدا سنجیده می‌شود (`wooQueueView`): نبود یا
  // نامعتبر بودنش فقط همان بخش را «نامعلوم» می‌کند، نه کل تست اتصال را.
  queue: z.unknown().optional(),
});

const count = z.number().int().nonnegative().nullable();
/**
 * قرارداد فقط‌خواندنی تله‌متری صف افزونه. `null` یعنی «افزونه نتوانست بشمارد»؛ میدانِ ناموجود (نسخهٔ
 * قدیمی‌تر افزونه) هم نامعلوم است — هیچ‌کدام صفر نمی‌شود. `failedActions` **سطر** نگه‌داشتهٔ Action Scheduler
 * است، نه کار منطقی؛ `deadTasks` فقط کارهای متوقف‌شده با شکست غیرمنتظره است، نه شکست قطعیِ تجاری.
 */
export const queueTelemetry = z.object({
  backend: z.enum(["action-scheduler", "wp-cron"]),
  group: z.string().max(64),
  pendingDue: count.optional(), pendingFuture: count.optional(), running: count.optional(),
  deadTasks: count, deadScope: z.literal("unexpected_failure_only"),
  deferredTasks: count, busyTasks: count.optional(),
  failedActions: count, failedActionsScope: z.literal("action_scheduler_retained_rows"),
});

export type WooQueueView =
  | { state: "known"; backend: "action-scheduler" | "wp-cron"; counts: {
      due: number | null; scheduled: number | null; running: number | null; deferred: number | null;
      busy: number | null; stoppedTasks: number | null; failedRows: number | null; } }
  | { state: "unknown"; code: "no_queue_telemetry" | "invalid_queue_telemetry"; message: string };

/** گزارش صف افزونه → نمای داشبورد. میدانِ نبوده `null` (نامعلوم) می‌شود، نه صفر. */
export function wooQueueView(raw: unknown): WooQueueView {
  if (raw === undefined) {
    return { state: "unknown", code: "no_queue_telemetry", message: "این نسخهٔ افزونه وضعیت صف را گزارش نمی‌کند؛ افزونه را به‌روز کنید." };
  }
  const q = queueTelemetry.safeParse(raw);
  if (!q.success) {
    return { state: "unknown", code: "invalid_queue_telemetry", message: "گزارش صف افزونه با قرارداد سازگار نیست؛ نسخهٔ افزونه را بررسی کنید." };
  }
  const v = q.data;
  return { state: "known", backend: v.backend, counts: {
    due: v.pendingDue ?? null, scheduled: v.pendingFuture ?? null, running: v.running ?? null,
    deferred: v.deferredTasks, busy: v.busyTasks ?? null, stoppedTasks: v.deadTasks, failedRows: v.failedActions,
  } };
}

/** بدنه محدود، اتصال پین‌شده، بدون دنبال‌کردن تغییر مسیر یا بازتاب خطای مقصد. */
export function readPinnedJson(target: PinnedTarget, body: string, headers: Record<string, string>, send: HttpRequestFn = request): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const host = target.url.hostname.replace(/^\[|\]$/g, "");
    const req = send({ protocol: "https:", hostname: host,
      port: target.url.port || 443, path: target.url.pathname, method: "POST",
      lookup: pinnedLookup(target.ips), servername: isIP(host) ? undefined : host, headers,
    }, res => {
      let size = 0;
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 32768) {
          clearTimeout(timer);
          const error = new Error("پاسخ بیش از حد بزرگ است");
          reject(error); req.destroy(error); return;
        }
        chunks.push(chunk);
      });
      res.on("error", err => { clearTimeout(timer); reject(err); });
      res.on("aborted", () => { clearTimeout(timer); reject(new Error("پاسخ ناتمام بود")); });
      res.on("end", () => {
        clearTimeout(timer);
        let parsed: unknown = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* پاسخ غیر JSON معتبر نیست. */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("مهلت اتصال تمام شد")), 8000);
    timer.unref();
    req.on("error", err => { clearTimeout(timer); reject(err); });
    req.end(body);
  });
}

export async function testWooConnection(config: { siteUrl: string; secret: string | undefined }, orderId?: number,
  deps: { resolve?: typeof resolveSafeTarget; read?: typeof readPinnedJson } = {}) {
  const failure = (code: string, message: string) => ({ ok: false as const, code, message, remote: null });
  if (!config.secret) return failure("missing_secret", "کلید امضا در محیط API تنظیم نشده؛ WEB_PUSH_SECRET را با Worker و افزونه تطبیق دهید.");
  let target: PinnedTarget;
  try {
    // ابتدا خود نشانی تنظیم‌شده سنجیده می‌شود تا query/fragment/اطلاعات ورود حذف و پنهان نشوند.
    target = await (deps.resolve ?? resolveSafeTarget)(config.siteUrl);
    target.url.pathname = target.url.pathname.replace(/\/+$/, "") + "/wp-json/lmc/v1/diagnostics";
  } catch { return failure("unsafe_target", "نشانی سایت یا DNS معتبر و عمومی نیست؛ HTTPS و دامنهٔ نهایی را در تنظیمات بررسی کنید."); }
  const body = JSON.stringify(orderId === undefined ? {} : { orderId });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString("hex");
  try {
    const response = await (deps.read ?? readPinnedJson)(target, body, {
      "content-type": "application/json", "x-lmc-timestamp": timestamp, "x-lmc-nonce": nonce,
      "x-lmc-signature": "sha256=" + signBody(config.secret, timestamp, nonce, body),
    });
    if (response.status >= 300 && response.status < 400) return failure("redirect", "سایت تغییر مسیر می‌دهد؛ نشانی HTTPS نهایی را وارد کنید. تغییر مسیر دنبال نشد.");
    if ([401, 403].includes(response.status)) return failure("authentication", "امضای اتصال پذیرفته نشد؛ یکسان‌بودن کلید امضا و ساعت دو سرور را بررسی کنید.");
    if (response.status === 404) return failure("plugin_route", "مسیر تست اتصال پیدا نشد؛ نسخهٔ تازهٔ افزونه و تنظیم پیوندهای یکتا را بررسی کنید.");
    if (response.status !== 200) return failure("remote_unavailable", "افزونه پاسخ موفق نداد؛ فعال‌بودن افزونه، کلید امضا و جدول Nonce را بررسی کنید.");
    const parsed = wooReport.safeParse(response.body);
    if (!parsed.success) return failure("invalid_response", "پاسخ با قرارداد تست اتصال سازگار نیست؛ نسخهٔ افزونه را بررسی کنید.");
    const expected = new URL(config.siteUrl);
    const actual = new URL(parsed.data.siteUrl);
    if (actual.username || actual.password || actual.search || actual.hash || actual.origin !== expected.origin || actual.pathname.replace(/\/+$/, "") !== expected.pathname.replace(/\/+$/, "")) {
      return failure("site_mismatch", "هویت سایت پاسخ‌دهنده با نشانی تنظیم‌شده یکسان نیست؛ دامنه و مسیر نصب را بررسی کنید.");
    }
    return { ok: true as const, code: "connected", message: "امضا و هویت سایت تأیید شد؛ ثبت سفارش و اجرای Worker با این آزمون اثبات نمی‌شود.", remote: parsed.data };
  } catch { return failure("network", "اتصال کامل نشد؛ دسترسی شبکه، گواهی TLS و زمان پاسخ سایت را بررسی کنید."); }
}
