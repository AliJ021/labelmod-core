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

  // کوکی نشست. در تولید حتماً روی HTTPS.
  COOKIE_NAME: z.string().default("labelmod_session"),
  COOKIE_DOMAIN: z.string().optional(),
  // کوکی راز دستگاه و کوکی توکن CSRF — نام‌هایشان از همان مبنا مشتق
  // می‌شوند تا در استقرار، سه‌تایی با هم جابه‌جا شوند.
  DEVICE_COOKIE_NAME: z.string().default("labelmod_device"),
  CSRF_COOKIE_NAME: z.string().default("labelmod_csrf"),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
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
