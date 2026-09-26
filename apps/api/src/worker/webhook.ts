/**
 * پل به پیام‌رسان — یک Webhook، نه یک ادغام.
 *
 * ── چرا Webhook و نه واتساپ یا تلگرام مستقیم ────────────────────────
 *
 * هر پیام‌رسان قواعد تجاری، مجوز و محدودیت خودش را دارد: واتساپ
 * Business API حساب تأییدشده می‌خواهد، تلگرام Bot Token، و هر دو
 * ممکن است فردا شرایطشان عوض شود. نوشتن یکی‌شان در این کدبیس یعنی
 * انتخاب مالک را قفل کنیم و هر تغییرِ آن سرویس، یک Deploy بخواهد.
 *
 * پس اینجا فقط یک `POST` با بدنه JSON می‌رود. اتصالش به هر
 * پیام‌رسانی کارِ همان سرویس است — n8n، Make، یا یک اسکریپت ده‌خطی.
 *
 * ── چرا این با «خاموش‌بودن یک شکست نیست» می‌خواند ───────────────────
 *
 * اگر Webhook خاموش باشد یا نشانی نداشته باشد، پیام با
 * `complete_outbox` بسته می‌شود نه `fail_outbox` — وگرنه
 * `platform.outbox_dead` پر می‌شد از چیزهایی که قرار نبود بروند و
 * خطای واقعی همان‌جا گم می‌شد.
 */
import { SmsError } from "./sms.ts";

export interface WebhookConfig {
  enabled: boolean;
  url: string;
  /** ⚠️ از متغیر محیطی، نه از `platform.setting`. */
  token: string | undefined;
}

/**
 * بدنهٔ Webhook — یک Union، نه یک شکل با میدان‌های اختیاری.
 *
 * دو نوع پیام از این پل می‌روند و هیچ میدان مشترکی جز `kind` ندارند.
 * یک Interface با همه‌چیزِ اختیاری یعنی هر مصرف‌کننده باید حدس بزند
 * کدام میدان‌ها پر است؛ Union یعنی کامپایلر خودش می‌گوید.
 */
export type WebhookPayload =
  | {
      kind: "invoice";
      invoiceNumber: string | null;
      customerName: string | null;
      mobile: string | null;
      amountRial: string;
      link: string;
    }
  | {
      kind: "health";
      /** کد زنگ — همان کدهای `platform.health_alerts()`. */
      code: string;
      severity: string;
      title: string;
      /** شمار سطرهای مشکل‌دار. عدد است نه پول. */
      count: number;
      detail: string;
      businessDate: string;
    };

export interface WebhookSender {
  send(payload: WebhookPayload): Promise<void>;
}

/**
 * ⚠️ نشانی باید `https` باشد.
 *
 * لینک فاکتور یک توکن دارد؛ فرستادنش روی HTTP لخت یعنی همان توکن
 * روی شبکه رمزنشده. همان دلیلی که کوکی نشست در تولید `Secure` است.
 */
export function assertHttps(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SmsError("نشانی Webhook معتبر نیست", true);
  }
  if (parsed.protocol !== "https:") {
    throw new SmsError("نشانی Webhook باید https باشد", true);
  }
}

export function makeWebhookSender(config: WebhookConfig): WebhookSender {
  return {
    async send(payload) {
      // خاموش بودن یک شکست نیست — Handler بالادست این را
      // `complete` می‌کند، نه `fail`.
      if (!config.enabled || config.url.trim() === "") return;

      assertHttps(config.url);
      if (config.token === undefined || config.token.trim() === "") {
        throw new SmsError("کلید NOTIFY_WEBHOOK_TOKEN تنظیم نشده است؛ ارسال انجام نشد");
      }

      const res = await fetch(config.url, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.token}`,
        },
        body: JSON.stringify(payload),
        // بدون مهلت، یک سرویس کند کل Worker را می‌خواباند.
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        // ⚠️ «رد شد» از «نرسید» جدا است — همان قاعده پیامک.
        //
        // ۴xx یعنی نشانی یا بدنه ایراد دارد و تلاش صدم هم درستش
        // نمی‌کند: مستقیم نامه مرده. ۵xx یعنی سرویس بالا نبود:
        // Backoff بگیرد و دوباره تلاش شود.
        const permanent = res.status >= 400 && res.status < 500;
        throw new SmsError(
          `Webhook پاسخ ${res.status} داد`,
          permanent,
        );
      }
    },
  };
}
