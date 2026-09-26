/**
 * ارسال پیامک — یک رابط، چند سرویس‌دهنده.
 *
 * ── چرا انتخاب سرویس‌دهنده یک تنظیم است، نه یک وابستگی ──────────────
 *
 * هیچ‌کدام از سرویس‌های پیامک ایرانی قرارداد پایداری ندارند: قیمت عوض
 * می‌شود، پنل قطع می‌شود، شماره فرستنده باطل می‌شود. اگر نام سرویس در
 * کد بنشیند، عوض‌کردنش یک Deploy است — دقیقاً وقتی که فروشگاه پیامک
 * نمی‌فرستد و مالک عجله دارد.
 *
 * پس `notify.sms_provider` یک تنظیم است و اینجا فقط آداپتور.
 *
 * ── و چرا کلید در محیط است، نه در تنظیمات ───────────────────────────
 *
 * مقدار هر تنظیم در `audit_log` می‌نشیند و صفحه تنظیمات نشانش می‌دهد.
 * کلید سرویس یک **راز** است: از `SMS_API_KEY` می‌آید، مثل رمز دیتابیس.
 * همان تفکیکی که کل این پروژه دارد — تصمیم در جدول، راز در محیط.
 *
 * ── «log» یک آداپتور واقعی است، نه یک Stub ──────────────────────────
 *
 * پیش‌فرض است و باید باشد: تا وقتی مالک اعتبار نخریده و شماره فرستنده
 * تأیید نشده، پیامک واقعی نباید برود. با `log` همه‌چیز کار می‌کند —
 * صف، Backoff، نامه مرده — و فقط عدم ارسال در لاگ ثبت می‌شود. اولین
 * پیامک واقعی آن‌وقت یک تغییر تنظیم است، نه یک استقرار.
 */

/** خطای ارسال، با تفکیکی که کل رفتار Retry رویش می‌ایستد. */
export class SmsError extends Error {
  /** آیا تلاش دوباره معنا دارد؟ شماره غلط با تلاش صدم هم درست نمی‌شود. */
  readonly permanent: boolean;

  constructor(message: string, permanent = false) {
    super(message);
    this.name = "SmsError";
    this.permanent = permanent;
  }
}

export interface SmsConfig {
  provider: string;
  sender: string;
  apiKey: string;
}

export interface SmsSender {
  send(to: string, text: string): Promise<void>;
}

/**
 * شماره موبایل ایرانی → شکل استاندارد `09xxxxxxxxx`.
 *
 * ⚠️ این **دومین** تعریف نرمال‌سازی نیست: `sales.normalize_mobile()` در
 *    دیتابیس شماره را برای **تطبیق مشتری** یکسان می‌کند. اینجا شماره
 *    را برای **سرویس‌دهنده** آماده می‌کنیم، که فرمت خودش را می‌خواهد.
 *    دو کار متفاوت روی یک داده.
 *
 * `null` یعنی شماره اصلاً موبایل ایران نیست — یک خطای دائمی، نه چیزی
 * که با تلاش دوباره درست شود.
 */
export function toLocalMobile(raw: string): string | null {
  // رقم فارسی و عربی هم می‌آید: مشتری در فرم سایت با صفحه‌کلید فارسی
  // تایپ می‌کند و «۰۹۱۲…» برای سرویس‌دهنده یک رشته بی‌معناست.
  const digits = raw
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/\D/g, "");

  // «۰۰۹۸…» هم می‌آید: شکل بین‌المللی که کاربر به‌جای «+» با دو صفر
  // نوشته. اول این، چون «0098…» با الگوی «98…» هم می‌خواند و نتیجه
  // غلط می‌داد.
  if (/^0098\d{10}$/.test(digits)) return `0${digits.slice(4)}`;
  if (/^98\d{10}$/.test(digits)) return `0${digits.slice(2)}`;
  if (/^09\d{9}$/.test(digits)) return digits;
  if (/^9\d{9}$/.test(digits)) return `0${digits}`;
  return null;
}

/** آداپتور بر اساس تنظیم. سرویس ناشناخته یک خطای دائمی است. */
export function makeSender(config: SmsConfig): SmsSender {
  switch (config.provider) {
    case "log":
      return logSender();
    case "kavenegar":
      return kavenegarSender(config);
    case "smsir":
      return smsIrSender(config);
    case "melipayamak":
      return meliPayamakSender(config);
    default:
      // نه یک پیش‌فرض بی‌صدا: سرویس‌دهنده‌ای که نمی‌شناسیم یعنی تنظیم
      // غلط است، و پیامکی که به «log» برود در حالی که مالک فکر می‌کند
      // رفته، از نرفتنش بدتر است.
      throw new SmsError(`سرویس‌دهنده پیامک «${config.provider}» شناخته نشد`, true);
  }
}

/** هیچ پیامکی نمی‌رود؛ متن در خروجی می‌نشیند. پیش‌فرض. */
function logSender(): SmsSender {
  return {
    async send() {
      process.stdout.write(
        "[پیامک — حالت آزمایشی، ارسال نشد]\n",
      );
    },
  };
}

/**
 * پاسخ سرویس‌دهنده → خطای ما.
 *
 * ۴xx یعنی درخواست غلط بود (شماره نامعتبر، اعتبار تمام، فرستنده
 * باطل) و تلاش دوباره همان جواب را می‌گیرد. ۵xx و خطای شبکه یعنی شاید
 * دفعه بعد برود. همان تفکیکی که افزونه ووکامرس دارد.
 */
async function check(res: Response, provider: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => "");
  const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
  throw new SmsError(
    `${provider} پاسخ ${res.status} داد: ${body.slice(0, 200)}`,
    permanent,
  );
}

/** کاوه‌نگار — https://api.kavenegar.com */
function kavenegarSender(config: SmsConfig): SmsSender {
  if (!config.apiKey) {
    throw new SmsError("کلید سرویس پیامک (SMS_API_KEY) تنظیم نشده است", true);
  }
  return {
    async send(to, text) {
      const url = `https://api.kavenegar.com/v1/${encodeURIComponent(
        config.apiKey,
      )}/sms/send.json`;
      const params = new URLSearchParams({ receptor: to, message: text });
      if (config.sender) params.set("sender", config.sender);

      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: params,
        signal: AbortSignal.timeout(20_000),
      });
      await check(res, "کاوه‌نگار");
    },
  };
}

/** sms.ir — https://api.sms.ir */
function smsIrSender(config: SmsConfig): SmsSender {
  if (!config.apiKey) {
    throw new SmsError("کلید سرویس پیامک (SMS_API_KEY) تنظیم نشده است", true);
  }
  return {
    async send(to, text) {
      const res = await fetch("https://api.sms.ir/v1/send/bulk", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-api-key": config.apiKey,
        },
        body: JSON.stringify({
          lineNumber: config.sender || undefined,
          messageText: text,
          mobiles: [to],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      await check(res, "sms.ir");
    },
  };
}

/** ملی‌پیامک — قرارداد کلیددار https://console.melipayamak.com/send/simple */
function meliPayamakSender(config: SmsConfig): SmsSender {
  if (!config.apiKey.trim()) {
    throw new SmsError("کلید سرویس پیامک (SMS_API_KEY) تنظیم نشده است", true);
  }
  if (!/^\d+$/.test(config.sender)) {
    throw new SmsError("شماره فرستنده ملی‌پیامک تنظیم نشده یا نامعتبر است", true);
  }
  return {
    async send(to, text) {
      const mobile = toLocalMobile(to);
      if (!mobile || !/^09\d{9}$/.test(mobile)) {
        throw new SmsError("شماره گیرنده پیامک نامعتبر است", true);
      }
      let res: Response;
      try {
        res = await fetch(
          `https://console.melipayamak.com/api/send/simple/${encodeURIComponent(config.apiKey)}`,
          {
            method: "POST",
            redirect: "error",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ from: config.sender, to: mobile, text }),
            signal: AbortSignal.timeout(20_000),
          },
        );
      } catch {
        // URL حاوی کلید است؛ خطای خام fetch نباید وارد outbox/log شود.
        throw new SmsError("ارتباط با ملی‌پیامک کامل نشد؛ وضعیت ارسال نامشخص است");
      }
      if (!res.ok) {
        throw new SmsError(
          `ملی‌پیامک پاسخ HTTP ${res.status} داد`,
          res.status >= 400 && res.status < 500 && res.status !== 429,
        );
      }
      let payload: unknown;
      try { payload = await res.json(); }
      catch { throw new SmsError("پاسخ ملی‌پیامک JSON معتبر نیست؛ وضعیت ارسال نامشخص است", true); }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new SmsError("پاسخ ملی‌پیامک فاقد تأیید معتبر ارسال است", true);
      }
      const result = payload as { recId?: unknown; status?: unknown };
      const validId = typeof result.recId === "number"
        ? Number.isSafeInteger(result.recId) && result.recId > 0
        : typeof result.recId === "string" && /^[1-9]\d*$/.test(result.recId);
      const noError = result.status === undefined || result.status === null || result.status === "";
      if (!validId || !noError) {
        // متن پاسخ ممکن است شامل شماره/متن/کلید باشد؛ فقط خطای ثابت ثبت می‌شود.
        throw new SmsError("ملی‌پیامک ارسال را تأیید نکرد؛ اعتبار، فرستنده و گزارش پنل را بررسی کنید", true);
      }
    },
  };
}
