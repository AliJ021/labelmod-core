/**
 * فرستندهٔ Push به سایت — ADR-007.
 *
 * ── چرا اینجا و نه داخل تراکنش فروش ─────────────────────────────────
 *
 * سه دلیل، هر سه از قواعد موجود همین مخزن:
 *
 * ۱. بودجهٔ ۱۰۰ms صندوق (ADR-002). یک درخواست HTTP به سایت، حتی موفق،
 *    آن را می‌شکند.
 * ۲. قطعی سایت نباید فروش حضوری را متوقف کند.
 * ۳. اثر جانبی ناموفق نباید فروشِ Commit‌شده را نامعتبر کند — همان
 *    قاعده‌ای که برای پیامک هم برقرار است.
 *
 * پس درج در `outbox_message` **داخل** تراکنش، و ارسال **بیرون** از آن.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { SmsError } from "./sms.ts";

export interface WebPushConfig {
  enabled: boolean;
  /** نشانی پایهٔ سایت — `https://shop.example.com` */
  baseUrl: string;
  /** ⚠️ از متغیر محیطی `WEB_PUSH_SECRET`، نه از `platform.setting`. */
  secret: string | undefined;
  timeoutMs?: number;
}

/**
 * محدوده‌های ممنوع مقصد — بند ۶ ADR-007.
 *
 * ⚠️ سنجش روی **IP نهایی پس از DNS** است، نه روی رشتهٔ نشانی: نامی که
 *    به `127.0.0.1` Resolve شود از هر بررسی رشته‌ای رد می‌شود. این
 *    دقیقاً همان کاری است که یک SSRF واقعی می‌کند.
 */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number);
    const [a, b] = [p[0] ?? 0, p[1] ?? 0];
    if (a === 0 || a === 127) return true;              // this-host · loopback
    if (a === 10) return true;                           // 10/8
    if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16/12
    if (a === 192 && b === 168) return true;             // 192.168/16
    if (a === 169 && b === 254) return true;             // link-local · metadata
    if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT 100.64/10
    if (a >= 224) return true;                           // multicast و بالاتر
    return false;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1") return true;
    if (s.startsWith("fe80:")) return true;              // link-local
    // fc00::/7 — یعنی fc.. و fd..
    if (s.startsWith("fc") || s.startsWith("fd")) return true;
    // ::ffff:a.b.c.d — IPv4 در پوشش IPv6؛ بی این، یک حلقهٔ کامل باز بود.
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (m?.[1] !== undefined) return isPrivateAddress(m[1]);
    return false;
  }
  // چیزی که IP نیست، IP امن هم نیست.
  return true;
}

/**
 * نشانی مقصد را می‌سنجد و **IP نهایی** را برمی‌گرداند.
 *
 * ⚠️ خطاها **دائمی**اند: یک نشانی داخلی با تلاش صدم هم بیرونی نمی‌شود.
 *    Backoff گرفتن برایش فقط صف را شلوغ می‌کند.
 */
export async function resolveSafeTarget(rawUrl: string): Promise<{ url: URL; ip: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SmsError("نشانی سایت معتبر نیست", true);
  }
  if (url.protocol !== "https:") {
    throw new SmsError("نشانی سایت باید https باشد", true);
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  let ip: string;
  if (isIP(host)) {
    ip = host;
  } else {
    try {
      ip = (await lookup(host)).address;
    } catch {
      throw new SmsError(`نام «${host}» به هیچ نشانی‌ای Resolve نشد`);
    }
  }

  if (isPrivateAddress(ip)) {
    throw new SmsError(
      `مقصد «${host}» به نشانی داخلی (${ip}) می‌رسد و رد شد`,
      true,
    );
  }
  return { url, ip };
}

/** امضای یک بدنه — همان فرمولی که افزونه می‌سنجد. */
export function signBody(
  secret: string,
  timestamp: string,
  nonce: string,
  body: string,
): string {
  /*
   * ⚠️ روی **بدنهٔ خام** امضا می‌شود، نه روی JSON بازتولیدشده: هر
   *    Serialize دوباره می‌تواند ترتیب کلید یا فاصله را عوض کند و امضا
   *    را بی‌دلیل بشکند. همین رشته است که روی سیم می‌رود.
   *
   * ⚠️ و جداکنندهٔ `.` اجباری است: بی آن،
   *    (ts="1", nonce="23") و (ts="12", nonce="3") یک پیام امضا
   *    می‌ساختند — یک برخورد که مهاجم می‌تواند بسازد.
   */
  return createHmac("sha256", secret)
    .update(`${timestamp}.${nonce}.${body}`, "utf8")
    .digest("hex");
}

/** مقایسهٔ زمان‌ثابت — برای مسیر تأیید (تست و ابزار). */
export function signatureMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface WebPushMessage {
  topic: "web.stock_push" | "web.price_push";
  payload: Record<string, unknown>;
}

export interface WebPushSender {
  send(msg: WebPushMessage): Promise<void>;
}

const PATHS: Record<WebPushMessage["topic"], string> = {
  "web.stock_push": "/wp-json/lmc/v1/stock",
  "web.price_push": "/wp-json/lmc/v1/price",
};

export function makeWebPushSender(
  config: WebPushConfig,
  deps: {
    fetch?: typeof fetch;
    now?: () => number;
    nonce?: () => string;
    resolveTarget?: typeof resolveSafeTarget;
  } = {},
): WebPushSender {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const mintNonce = deps.nonce ?? (() => randomBytes(16).toString("hex"));
  const resolve = deps.resolveTarget ?? resolveSafeTarget;

  return {
    async send(msg) {
      // خاموش‌بودن یک شکست نیست — Handler بالادست `complete` می‌کند.
      if (!config.enabled || config.baseUrl.trim() === "") return;
      if (config.secret === undefined || config.secret === "") {
        throw new SmsError(
          "کلید WEB_PUSH_SECRET تنظیم نشده است — بی آن هیچ پیامی امضا نمی‌شود",
        );
      }

      const base = config.baseUrl.replace(/\/+$/, "") + PATHS[msg.topic];
      const { url } = await resolve(base);

      const body = JSON.stringify(msg.payload);
      const timestamp = String(Math.floor(now() / 1000));
      const nonce = mintNonce();

      const res = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lmc-timestamp": timestamp,
          "x-lmc-nonce": nonce,
          "x-lmc-signature": `sha256=${signBody(config.secret, timestamp, nonce, body)}`,
        },
        body,
        /*
         * ⚠️ `manual` اجباری است. بی آن، یک Redirect به
         *    `169.254.169.254` همهٔ سنجش‌های SSRF بالا را دور می‌زد —
         *    چون آن‌ها روی نشانی **اول** اجرا شده‌اند، نه روی مقصد
         *    نهایی. Redirect یک پاسخ است، نه یک راه.
         */
        redirect: "manual",
        signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
      });

      if (res.status >= 300 && res.status < 400) {
        throw new SmsError(
          `سایت Redirect داد (${res.status}) و دنبال نمی‌شود`,
          true,
        );
      }
      if (!res.ok) {
        // «رد شد» از «نرسید» جدا است — همان قاعدهٔ پیامک و Webhook.
        // ۴xx یعنی امضا یا بدنه ایراد دارد و تلاش صدم هم درستش نمی‌کند.
        const permanent = res.status >= 400 && res.status < 500;
        throw new SmsError(`سایت پاسخ ${res.status} داد`, permanent);
      }
    },
  };
}
