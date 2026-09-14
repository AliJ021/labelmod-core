/**
 * تنظیمات اطلاع‌رسانی — از `platform.setting`، در هر دور تازه.
 *
 * ── چرا هر دور، و نه یک بار در آغاز ─────────────────────────────────
 *
 * مالک تنظیم را از صفحه تنظیمات عوض می‌کند و انتظار دارد کار کند.
 * خواندنِ یک‌باره یعنی «پیامک را روشن کردم ولی نمی‌رود» تا وقتی کسی
 * سرویس را دوباره راه‌اندازی کند — و آن کس معمولاً همان مالک است که
 * نمی‌داند باید این کار را بکند.
 *
 * هزینه‌اش یک SELECT کوچک در هر چند ثانیه است. ارزشش را دارد.
 */
import { sql } from "kysely";
import type { Db } from "../db/client.ts";

export interface NotifySettings {
  smsEnabled: boolean;
  provider: string;
  sender: string;
  invoiceSms: boolean;
  invoiceSmsRequiresConsent: boolean;
  chequeDueSms: boolean;
  managerMobile: string;
  publicUrl: string;
  maxAttempts: number;
  /**
   * ⚠️ `notify.webhook_*` از روز اول در تنظیمات بودند و
   *    `makeWebhookSender` هم نوشته و تست شده بود — ولی **هیچ Handlerی
   *    صدایش نمی‌زد**. یعنی روشن‌کردن آن کلید هیچ کاری نمی‌کرد، در حالی
   *    که متن خودش وعدهٔ «ارسال لینک فاکتور» می‌داد. حالا خوانده می‌شود.
   */
  webhookEnabled: boolean;
  webhookUrl: string;
  /** هشدار سلامت سیستم — مهاجرت ۰۵۵. */
  healthAlerts: boolean;
  /** ارسال لحظه‌ای به سایت — ADR-007، مهاجرت ۰۵۷. */
  webPushEnabled: boolean;
  webSiteUrl: string;
}

export async function readNotifySettings(db: Db): Promise<NotifySettings> {
  const r = await sql<{ key: string; value: unknown }>`
    SELECT key, value FROM platform.setting
     WHERE key IN (
       'notify.sms_enabled', 'notify.sms_provider', 'notify.sms_sender',
       'notify.invoice_sms', 'notify.invoice_sms_requires_consent',
       'notify.cheque_due_sms', 'notify.manager_mobile',
       'notify.max_attempts', 'platform.public_url',
       'notify.webhook_enabled', 'notify.webhook_url',
       'notify.health_alerts',
       'web.push_enabled', 'web.site_url'
     )
  `.execute(db);

  const map = new Map(r.rows.map((x) => [x.key, x.value]));
  const bool = (k: string, dflt: boolean): boolean => {
    const v = map.get(k);
    return typeof v === "boolean" ? v : dflt;
  };
  const text = (k: string): string => {
    const v = map.get(k);
    return typeof v === "string" ? v.trim() : "";
  };

  return {
    smsEnabled: bool("notify.sms_enabled", false),
    provider: text("notify.sms_provider") || "log",
    sender: text("notify.sms_sender"),
    invoiceSms: bool("notify.invoice_sms", false),
    // پیش‌فرض سخت‌گیرانه: بدون رضایت، پیامکی نمی‌رود.
    invoiceSmsRequiresConsent: bool("notify.invoice_sms_requires_consent", true),
    chequeDueSms: bool("notify.cheque_due_sms", false),
    managerMobile: text("notify.manager_mobile"),
    // اسلش پایانی برداشته می‌شود تا لینک «…//i/token» نشود.
    publicUrl: text("platform.public_url").replace(/\/+$/, ""),
    maxAttempts: Number(map.get("notify.max_attempts") ?? 8) || 8,
    webhookEnabled: bool("notify.webhook_enabled", false),
    webhookUrl: text("notify.webhook_url"),
    healthAlerts: bool("notify.health_alerts", false),
    webPushEnabled: bool("web.push_enabled", false),
    webSiteUrl: text("web.site_url").replace(/\/+$/, ""),
  };
}
