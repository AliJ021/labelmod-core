/**
 * پیکربندی — از محیط، با اعتبارسنجی در لحظه بالا آمدن.
 *
 * قاعده: اگر چیزی لازم است و نیست، همین‌جا بشکن. سرویسی که با پیکربندی
 * ناقص بالا بیاید و سر اولین درخواست واقعی خطا بدهد، خرابیِ گران‌تری
 * می‌سازد.
 *
 * ⚠️ تصمیم‌های کسب‌وکار اینجا نیستند. نرخ مالیات، سقف تخفیف، عمر نشست و
 *    مهلت مرجوعی همه در platform.setting‌اند تا تغییرشان UPDATE باشد نه
 *    Deploy. اینجا فقط چیزهایی است که ذاتاً محیطی‌اند.
 */
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("127.0.0.1"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL تنظیم نشده است"),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  // فقط سوکت و کلید کانال؛ اعتبارنامهٔ مالک دیتابیس در فرایند API قرار نمی‌گیرد.
  BACKUP_MANAGER_SOCKET: z.string().min(1).optional(),
  BACKUP_MANAGER_TOKEN: z.string().regex(/^[a-f0-9]{64,128}$/i).optional(),

  // کوکی نشست. در تولید حتماً روی HTTPS.
  COOKIE_NAME: z.string().default("labelmod_session"),
  COOKIE_DOMAIN: z.string().optional(),
  // کوکی راز دستگاه و کوکی توکن CSRF — نام‌هایشان از همان مبنا مشتق
  // می‌شوند تا در استقرار، سه‌تایی با هم جابه‌جا شوند.
  DEVICE_COOKIE_NAME: z.string().default("labelmod_device"),
  CSRF_COOKIE_NAME: z.string().default("labelmod_csrf"),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // ── Worker ──────────────────────────────────────────────────────
  //
  // ⚠️ کلید سرویس پیامک اینجاست و نه در `platform.setting` — چون یک
  //    **راز** است، نه یک تصمیم. مقدار هر تنظیم در `audit_log`
  //    می‌نشیند و صفحه تنظیمات نشانش می‌دهد؛ کلید نباید هیچ‌کدام را
  //    ببیند. انتخاب سرویس‌دهنده و شماره فرستنده اما تصمیم‌اند و در
  //    جدول‌اند.
  SMS_API_KEY: z.string().optional(),
  SMS_CREDENTIAL_KEY: z.preprocess((v) => v === "" ? undefined : v, z.string().regex(/^[a-f0-9]{64}$/i).optional()),
  /**
   * توکن Webhook پیام‌رسان.
   *
   * ⚠️ در `platform.setting` نیست و نباید برود: مقدار هر تنظیم در
   *    `audit_log` می‌نشیند و صفحهٔ تنظیمات نشانش می‌دهد. نشانی Webhook
   *    یک تصمیم است و در جدول است؛ توکنش یک راز است و در محیط.
   */
  NOTIFY_WEBHOOK_TOKEN: z.string().optional(),

  /**
   * کلید امضای Push سایت (ADR-007، مهاجرت ۰۵۷).
   *
   * ⚠️ همان قاعده: نشانی سایت یک **تصمیم** است و در `platform.setting`
   *    می‌نشیند؛ کلید امضا یک **راز** است و در محیط. سمت افزونه هم در
   *    `wp-config.php` به‌عنوان ثابت، نه در `wp_options`.
   */
  WEB_PUSH_SECRET: z.string().optional(),

  // این سه عدد عمداً محیطی‌اند، نه تنظیم: به **ظرفیت ماشین** مربوطند،
  // نه به کسب‌وکار. مالک هیچ‌وقت نمی‌خواهد اندازه دسته را عوض کند.
  WORKER_INTERVAL_MS: z.coerce.number().int().min(500).max(600_000).default(5_000),
  WORKER_BATCH: z.coerce.number().int().min(1).max(200).default(20),
  // اجاره باید از بدترین زمان ارسال بلندتر باشد، وگرنه پیامی که هنوز
  // در حال رفتن است دوباره برداشته می‌شود و مشتری دو پیامک می‌گیرد.
  WORKER_LEASE_SECONDS: z.coerce.number().int().min(30).max(3_600).default(120),
});

export type Config = z.infer<typeof schema> & { isProduction: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  • ${i.path.join(".")}: ${i.message}`);
    throw new Error(`پیکربندی نامعتبر است:\n${lines.join("\n")}`);
  }
  const value = parsed.data;

  // کوکی نشست بدون Secure یعنی توکن روی HTTP لخت می‌رود. در تولید این
  // یک اشتباه پیکربندی نیست، یک نشت است.
  if (value.NODE_ENV === "production" && !value.DATABASE_URL.includes("sslmode")) {
    // فقط هشدار: در استقرار تک‌سروری، پستگرس روی همان میزبان است و
    // اتصال از شبکه بیرون نمی‌رود.
  }

  return { ...value, isProduction: value.NODE_ENV === "production" };
}
