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
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";
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
 * نشانی مقصد را می‌سنجد و **همهٔ** IPهای نهایی را برمی‌گرداند.
 *
 * ⚠️ خطاها **دائمی**اند: یک نشانی داخلی با تلاش صدم هم بیرونی نمی‌شود.
 *    Backoff گرفتن برایش فقط صف را شلوغ می‌کند.
 *
 * ⚠️ **همهٔ پاسخ‌های DNS سنجیده می‌شوند، نه فقط اولی** (یافتهٔ
 *    FND-R60-02). نسخهٔ اول `lookup(host)` می‌زد که تنها یک نشانی
 *    برمی‌گرداند؛ نامی که هم‌زمان یک نشانی عمومی و یک نشانی داخلی
 *    بدهد، بسته به ترتیب پاسخ DNS گاهی رد می‌شد و گاهی نه. یک نگهبان
 *    که **گاهی** کار کند، نگهبان نیست.
 *
 * ⚠️ و `ips` برگشتی تزئین نیست: `makePinnedPost` اتصال را به همین
 *    فهرست **پین** می‌کند. بی آن، بین این سنجش و لحظهٔ اتصال یک
 *    Resolve دوبارهٔ کامل فاصله بود — یعنی همان پنجره‌ای که
 *    DNS Rebinding از آن رد می‌شود.
 */
export type LookupAll = (host: string) => Promise<string[]>;

/** همهٔ نشانی‌های یک نام — پیش‌فرضِ تولیدی. */
const dnsLookupAll: LookupAll = async (host) =>
  (await lookup(host, { all: true })).map((a) => a.address);

export async function resolveSafeTarget(
  rawUrl: string,
  /*
   * ⚠️ این پارامتر یک درِ پشتی برای «ضعیف‌کردن» نگهبان نیست: فقط
   *    **منبع پاسخ DNS** را جابه‌جا می‌کند و هر سنجشِ پایین دست‌نخورده
   *    می‌ماند. بی آن، ادعای «همهٔ پاسخ‌ها سنجیده می‌شوند» فقط با یک
   *    نام واقعیِ چندنشانی‌ای سنجیدنی بود — یعنی یک تست وابسته به
   *    اینترنت، که در CI یا شکننده است یا خاموش.
   */
  lookupAll: LookupAll = dnsLookupAll,
): Promise<{ url: URL; ip: string; ips: string[] }> {
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
  let ips: string[];
  if (isIP(host)) {
    ips = [host];
  } else {
    try {
      ips = await lookupAll(host);
    } catch {
      throw new SmsError(`نام «${host}» به هیچ نشانی‌ای Resolve نشد`);
    }
  }

  // پاسخ خالی یک «شاید» نیست: چیزی برای پین‌کردن نیست، پس اتصالی هم
  // نباید برقرار شود.
  if (ips.length === 0) {
    throw new SmsError(`نام «${host}» به هیچ نشانی‌ای Resolve نشد`);
  }

  // ⚠️ **یکی هم کافی است برای رد.** اگر فقط «اولی» سنجیده شود، مهاجمی
  //    که DNS را کنترل کند کافی است یک نشانی عمومی جلوی فهرست بگذارد.
  for (const ip of ips) {
    if (isPrivateAddress(ip)) {
      throw new SmsError(
        `مقصد «${host}» به نشانی داخلی (${ip}) می‌رسد و رد شد`,
        true,
      );
    }
  }

  return { url, ip: ips[0] as string, ips };
}

/**
 * یک `lookup` که هر نامی را به **همین فهرست** برمی‌گرداند.
 *
 * این تنها نقطه‌ای است که IP سنجیده‌شده را به اتصال می‌چسباند. نامِ
 * میزبان دست‌نخورده می‌ماند و برای SNI و بررسی گواهی به‌کار می‌رود، پس
 * پین‌کردن IP **TLS را ضعیف نمی‌کند** — گواهی هنوز باید برای همان نام
 * صادر شده باشد.
 *
 * ⚠️ `options.all` هر دو حالت دارد و هر دو لازم‌اند: `net.connect` در
 *    حالت `autoSelectFamily` آرایه می‌خواهد و در غیر آن یک رشته. اگر
 *    فقط یکی پیاده شود، اتصال در همان حالت دیگر با خطای مبهم
 *    «Invalid address» می‌شکند — و آن‌وقت وسوسهٔ برگرداندن پین است.
 */
export function pinnedLookup(ips: string[]): LookupFunction {
  const answers = ips.map((address) => {
    const family = isIP(address);
    if (family === 0) {
      throw new Error(`نشانی پین‌شدهٔ «${address}» یک IP نیست`);
    }
    return { address, family };
  });

  return (_hostname, options, callback) => {
    const wanted = options.family === 4 || options.family === 6
      ? answers.filter((a) => a.family === options.family)
      : answers;

    if (wanted.length === 0) {
      callback(new Error("هیچ نشانی پین‌شده‌ای برای این اتصال نیست"), "");
      return;
    }
    if (options.all === true) {
      callback(null, wanted);
      return;
    }
    const first = wanted[0] as { address: string; family: number };
    callback(null, first.address, first.family);
  };
}

export interface PinnedTarget {
  url: URL;
  /** IPهای سنجیده‌شده — اتصال به همین‌ها و فقط همین‌ها می‌رود. */
  ips: string[];
}

export interface PinnedPostInit {
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export type PinnedPost = (
  target: PinnedTarget,
  init: PinnedPostInit,
) => Promise<{ status: number }>;

/**
 * امضای `http.request`/`https.request` به شکلی که این ماژول استفاده
 * می‌کند — فقط حالت «شیء گزینه‌ها + Callback».
 *
 * ⚠️ باریک‌کردنش لازم است: هر دو تابع چند Overload دارند (از جمله
 *    `request(url, …)`) و TypeScript روی اجتماعشان Overload اشتباه را
 *    برمی‌گزیند. اینجا فقط یک شکل استفاده می‌شود، پس همان یک شکل
 *    نوشته می‌شود.
 */
export type HttpRequestFn = (
  options: RequestOptions,
  callback: (res: IncomingMessage) => void,
) => ClientRequest;

/**
 * POST به نشانی، با اتصال **پین‌شده** به IPهای سنجیده‌شده.
 *
 * ⚠️ چرا `node:https` و نه `fetch`: پین‌کردن IP در fetch به یک
 *    Dispatcher از `undici` نیاز دارد و Node آن را صادر نمی‌کند —
 *    افزودن یک وابستگی تازه فقط برای این، خلاف بند ۵ SECURITY.md بود.
 *    `https.request` گزینهٔ `lookup` را از روز اول دارد.
 *
 * ⚠️ **و Redirect اینجا ساختاری بسته است**، نه با یک گزینه:
 *    `https.request` هرگز Redirect را دنبال نمی‌کند. پاسخ ۳xx بالادست
 *    یک شکست دائمی شمرده می‌شود، مثل قبل.
 *
 * ⚠️ `https` یا `http` از **پروتکل خودِ نشانی** می‌آید و اجبار https
 *    جای دیگری است (`resolveSafeTarget`). دو جا نوشتنش یعنی یکی‌شان
 *    عقب بماند؛ و تست یکپارچه عمداً یک گیرندهٔ محلی http دارد.
 */
export function makePinnedPost(
  requestImpl?: HttpRequestFn,
): PinnedPost {
  return (target, init) =>
    new Promise<{ status: number }>((resolve, reject) => {
      const host = target.url.hostname.replace(/^\[|\]$/g, "");
      const secure = target.url.protocol === "https:";
      const send: HttpRequestFn = requestImpl
        ?? ((secure ? httpsRequest : httpRequest) as HttpRequestFn);

      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const req = send(
        {
          protocol: target.url.protocol,
          hostname: host,
          port: target.url.port === "" ? (secure ? 443 : 80) : Number(target.url.port),
          path: `${target.url.pathname}${target.url.search}`,
          method: "POST",
          headers: init.headers,
          // ← همین یک سطر، پنجرهٔ بین «سنجش» و «اتصال» را می‌بندد.
          lookup: pinnedLookup(target.ips),
          // SNI و بررسی گواهی روی **نام** می‌مانند، نه روی IP.
          servername: secure && !isIP(host) ? host : undefined,
        },
        (res) => {
          // بدنه خوانده و دور انداخته می‌شود؛ بی این، Socket باز می‌ماند.
          res.resume();
          res.on("end", () => finish(() => resolve({ status: res.statusCode ?? 0 })));
        },
      );

      // ⚠️ مهلت **کل عملیات**، نه بی‌کاریِ Socket: سروری که هر چند ثانیه
      //    یک بایت بفرستد، `options.timeout` را هرگز فعال نمی‌کند.
      const timer = setTimeout(() => {
        req.destroy(new Error("مهلت ارسال به سایت تمام شد"));
      }, init.timeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      req.on("error", (err: Error) => finish(() => reject(err)));
      req.end(init.body);
    });
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
    /**
     * ⚠️ جای `fetch` را گرفت (FND-R60-02). `fetch` نمی‌تواند اتصال را
     *    به یک IP پین کند، پس هر فراخوان دوباره DNS می‌زد و IPی که
     *    سنجیده شده بود هرگز به اتصال نمی‌رسید.
     */
    post?: PinnedPost;
    now?: () => number;
    nonce?: () => string;
    resolveTarget?: typeof resolveSafeTarget;
  } = {},
): WebPushSender {
  const post = deps.post ?? makePinnedPost();
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
      /*
       * ⚠️ **هر بار دوباره Resolve می‌شود، و این عمدی است.** نتیجه
       *    Cache نمی‌شود: هر تلاش مجدد صف، یک سنجش تازه می‌گیرد. اگر
       *    نتیجه نگه داشته می‌شد، نشانی‌ای که امروز عمومی است و فردا
       *    داخلی می‌شود تا ابد از نگهبان رد بود.
       */
      const { url, ips } = await resolve(base);

      const body = JSON.stringify(msg.payload);
      const timestamp = String(Math.floor(now() / 1000));
      const nonce = mintNonce();

      /*
       * ⚠️ اتصال به **همان IPهایی** می‌رود که همین حالا سنجیده شدند.
       *    نسخهٔ قبلی `ip` را می‌گرفت و دور می‌انداخت و `fetch` دوباره
       *    DNS می‌زد — یعنی سنجش روی یک پاسخ انجام می‌شد و اتصال روی
       *    پاسخ **بعدی**. همان پنجرهٔ DNS Rebinding.
       *
       * ⚠️ و Redirect: `https.request` هرگز دنبالش نمی‌کند، پس آن
       *    دفاع حالا ساختاری است نه یک گزینه. ۳xx همچنان یک شکست
       *    دائمی شمرده می‌شود.
       */
      const res = await post({ url, ips }, {
        headers: {
          "content-type": "application/json",
          "x-lmc-timestamp": timestamp,
          "x-lmc-nonce": nonce,
          "x-lmc-signature": `sha256=${signBody(config.secret, timestamp, nonce, body)}`,
        },
        body,
        timeoutMs: config.timeoutMs ?? 10_000,
      });

      if (res.status >= 300 && res.status < 400) {
        throw new SmsError(
          `سایت Redirect داد (${res.status}) و دنبال نمی‌شود`,
          true,
        );
      }
      if (res.status < 200 || res.status >= 300) {
        // «رد شد» از «نرسید» جدا است — همان قاعدهٔ پیامک و Webhook.
        // ۴xx یعنی امضا یا بدنه ایراد دارد و تلاش صدم هم درستش نمی‌کند.
        const permanent = res.status >= 400 && res.status < 500;
        throw new SmsError(`سایت پاسخ ${res.status} داد`, permanent);
      }
    },
  };
}
