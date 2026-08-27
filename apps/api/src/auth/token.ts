/**
 * توکن نشست — ۳۲ بایت تصادفی امن، و فقط SHA-256 آن در دیتابیس.
 *
 * چرا JWT نیست: بند ۶ سند اصلی «خروج اجباری همه نشست‌ها و قطع دسترسی
 * گوشی مفقودی» را الزام کرده. یک JWT صادرشده تا انقضایش معتبر است و
 * باطل‌کردنش نیازمند فهرست ابطال سمت سرور است — که آن‌وقت همان نشست سمت
 * سرور است با پیچیدگی اضافه. اینجا ابطال یک UPDATE است.
 *
 * چرا هش: دامپ دیتابیس، بکاپ یا یک SELECT ناخواسته نباید بتواند نشست
 * کسی را بدزدد. همان منطق رمز عبور.
 */
import { createHash, randomBytes } from "node:crypto";

const TOKEN_BYTES = 32;

export function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * گزینه‌های کوکی نشست — بند ۱ و ۶ SECURITY.md.
 * SameSite=Strict به‌علاوه توکن Double-Submit، پایه دفاع CSRF است.
 */
export function sessionCookieOptions(opts: {
  secure: boolean;
  maxAgeSeconds: number;
  domain?: string | undefined;
}) {
  return {
    httpOnly: true,
    secure: opts.secure,
    sameSite: "strict" as const,
    path: "/",
    maxAge: opts.maxAgeSeconds,
    ...(opts.domain ? { domain: opts.domain } : {}),
  };
}

/**
 * کوکی راز ثبت‌نام دستگاه.
 *
 * عمر بلند و مستقل از نشست: دستگاه بین شیفت‌ها و کاربران مختلف همان
 * دستگاه می‌ماند. HttpOnly است تا اسکریپت صفحه — خودی یا تزریق‌شده —
 * نتواند بخواندش و به جای دیگری ببرد.
 */
export function deviceCookieOptions(opts: {
  secure: boolean;
  domain?: string | undefined;
}) {
  return {
    httpOnly: true,
    secure: opts.secure,
    sameSite: "strict" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    ...(opts.domain ? { domain: opts.domain } : {}),
  };
}

/**
 * کوکی توکن CSRF — عمداً **بدون** HttpOnly.
 *
 * الگوی Double-Submit به این نیاز دارد که کد صفحه بتواند مقدار را
 * بخواند و در سرآیند برگرداند. خواندنی‌بودنش ضعف نیست: این مقدار به
 * تنهایی هیچ دسترسی‌ای نمی‌دهد؛ ارزشش در این است که یک سایت دیگر
 * نمی‌تواند بخواندش، پس نمی‌تواند سرآیند درست را بسازد.
 */
export function csrfCookieOptions(opts: {
  secure: boolean;
  maxAgeSeconds: number;
  domain?: string | undefined;
}) {
  return {
    httpOnly: false,
    secure: opts.secure,
    sameSite: "strict" as const,
    path: "/",
    maxAge: opts.maxAgeSeconds,
    ...(opts.domain ? { domain: opts.domain } : {}),
  };
}
