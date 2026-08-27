/**
 * درهم‌سازی رمز و PIN — Argon2id با پارامترهای بند ۱ SECURITY.md.
 *
 *   memory = 65536 KiB · time = 3 · parallelism = 4 · salt ۱۶ بایت
 *
 * حداقل قابل قبول OWASP برای Argon2id `m=47104, t=1, p=1` است. اینجا
 * بالاتر انتخاب شده چون حجم لاگین پایین است (چند نفر پرسنل).
 *
 * ⚠️ روی سرور واقعی زمان بگیرید. هدف ۲۵۰ تا ۵۰۰ میلی‌ثانیه برای هر بار
 *    درهم‌سازی. اگر خیلی سریع‌تر بود، memoryCost را بالا ببرید.
 */
import argon2 from "argon2";
import { timingSafeEqual } from "node:crypto";

const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
} as const;

export async function hashSecret(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

/**
 * تطبیق در زمان ثابت. argon2.verify خودش زمان‌ثابت است؛ پوشش اینجا
 * برای این است که هش نامعتبر یا خالی هم به‌جای پرتاب خطا، «نادرست»
 * برگرداند — وگرنه تفاوت رفتار میان «کاربر بدون رمز» و «رمز غلط» از
 * بیرون قابل تشخیص می‌شود.
 */
export async function verifySecret(hash: string | null, plain: string): Promise<boolean> {
  if (!hash) {
    // کاربر بدون رمز: همان هزینه را بپرداز تا زمان پاسخ لو ندهد.
    await hashSecret(plain).catch(() => undefined);
    return false;
  }
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/** مقایسه زمان‌ثابت دو رشته هم‌طول — برای OTP و توکن. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
