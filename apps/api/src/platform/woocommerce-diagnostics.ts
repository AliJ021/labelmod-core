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
  apiKeyConfigured: z.boolean(), stockPolling: z.boolean(), pricePolling: z.boolean(),
  cronDisabled: z.boolean(), stockScheduled: z.boolean(),
  mapping: z.object({ linkedProducts: z.number().int().nonnegative().nullable(), orderIdentity: z.literal("sku"), stockIdentity: z.literal("variationId") }),
  order: z.object({
    found: z.boolean(), status: z.enum(["", "pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed", "unknown"]), paymentConfirmed: z.boolean(),
    eligible: z.boolean(), recorded: z.boolean(), scheduled: z.boolean(),
    attempts: z.number().int().nonnegative(), hasError: z.boolean(),
    missingSku: z.number().int().nonnegative(), missingMapping: z.number().int().nonnegative(),
  }).nullable(),
});

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
