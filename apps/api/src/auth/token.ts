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
