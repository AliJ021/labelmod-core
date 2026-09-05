/**
 * TOTP — RFC 6238، بدون هیچ وابستگی.
 *
 * ── چرا بدون کتابخانه ─────────────────────────────────────────────
 *
 * کل الگوریتم سی خط است و ورودی‌اش کاملاً مشخص: HMAC-SHA1 روی شماره
 * گام زمانی، بعد Dynamic Truncation. `node:crypto` هر دو را دارد.
 * یک وابستگی تازه برای این، هزینه زنجیره تأمین بی‌دلیل است — و
 * `docs/SECURITY.md` بند ۵ می‌گوید «هیچ وابستگی‌ای بدون دلیل مشخص».
 *
 * و مهم‌تر: **بردارهای آزمون خودِ RFC** اینجا اجرا می‌شوند. یعنی
 * درستی‌اش ادعا نیست، سنجیده است. کتابخانه هم همین را می‌کرد.
 *
 * ── چرا SHA-1، در ۲۰۲۶ ───────────────────────────────────────────
 *
 * چون Google Authenticator، Authy، Microsoft Authenticator و
 * ۱Password همه SHA-1 را پیش‌فرض می‌گیرند و اکثرشان الگوریتم دیگری
 * را از QR نمی‌خوانند. TOTP از SHA-1 مقاومت در برابر برخورد
 * نمی‌خواهد — فقط PRF می‌خواهد، و HMAC-SHA1 هنوز امن است.
 * انتخاب SHA-256 اینجا یعنی نصف کاربران کد اشتباه بگیرند.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** الفبای Base32 استاندارد (RFC 4648) — همان که اپ‌های Authenticator می‌فهمند. */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  // فاصله و `=` را اپ‌ها و کاربرها هر دو تولید می‌کنند؛ حذفشان
  // بخشی از پذیرش ورودی است، نه سهل‌گیری.
  const clean = s.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("رشته Base32 نامعتبر است");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** راز تازه — ۲۰ بایت، همان طولی که RFC 4226 برای HMAC-SHA1 توصیه می‌کند. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export interface TotpOptions {
  /** طول گام زمانی به ثانیه. RFC 6238 پیش‌فرض ۳۰ می‌گذارد. */
  step?: number;
  digits?: number;
  algorithm?: "sha1" | "sha256" | "sha512";
}

/**
 * کد این لحظه (یا هر گام دلخواه).
 *
 * `counter` شماره گام است، نه زمان: `floor(unixSeconds / step)`.
 */
export function hotp(
  secret: Buffer,
  counter: number,
  digits = 6,
  algorithm: "sha1" | "sha256" | "sha512" = "sha1",
): string {
  const msg = Buffer.alloc(8);
  // شماره گام ۶۴ بیتی است. `writeBigUInt64BE` تنها راه درست است:
  // `<<` جاوااسکریپت روی ۳۲ بیت می‌شکند و سال ۲۱۰۶ نیست که مسئله
  // شود — همین حالا برای گام‌های بزرگ‌تر از ۲^۳۱ غلط می‌داد.
  msg.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac(algorithm, secret).update(msg).digest();
  // Dynamic Truncation — RFC 4226 بند ۵.۳
  const offset = digest[digest.length - 1]! & 0x0f;
  const bin =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function totp(secretBase32: string, at: Date = new Date(), opts: TotpOptions = {}): string {
  const step = opts.step ?? 30;
  const counter = Math.floor(at.getTime() / 1000 / step);
  return hotp(base32Decode(secretBase32), counter, opts.digits ?? 6, opts.algorithm ?? "sha1");
}

/**
 * سنجش کد — با تحمل ±۱ گام و مقایسه **زمان‌ثابت**.
 *
 * تحمل یک گام (۳۰ ثانیه هر طرف) در بند ۱ SECURITY.md نوشته شده و
 * دلیلش انحراف ساعت گوشی است. بیشتر از آن، پنجره حمله را بی‌دلیل
 * باز می‌کند.
 *
 * مقایسه زمان‌ثابت اینجا شاید بیش از حد به‌نظر برسد — کد فقط شش رقم
 * است — ولی `===` روی رشته از اولین کاراکتر متفاوت برمی‌گردد، و آن
 * یک نشت است که هزینه بستنش صفر است.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  at: Date = new Date(),
  opts: TotpOptions & { window?: number } = {},
): boolean {
  const digits = opts.digits ?? 6;
  const clean = code.replace(/\s/g, "");
  if (!new RegExp(`^\\d{${digits}}$`).test(clean)) return false;

  const step = opts.step ?? 30;
  const window = opts.window ?? 1;
  const secret = base32Decode(secretBase32);
  const now = Math.floor(at.getTime() / 1000 / step);
  const given = Buffer.from(clean, "utf8");

  let ok = false;
  for (let i = -window; i <= window; i++) {
    const expected = Buffer.from(
      hotp(secret, now + i, digits, opts.algorithm ?? "sha1"),
      "utf8",
    );
    // بدون `break` — تا تعداد تکرارها به درست یا غلط بودن کد وابسته
    // نباشد.
    if (expected.length === given.length && timingSafeEqual(expected, given)) ok = true;
  }
  return ok;
}

/**
 * URI ثبت‌نام — همان چیزی که در QR می‌رود.
 *
 * `issuer` هم در مسیر و هم در پارامتر می‌آید: بعضی اپ‌ها اولی را
 * می‌خوانند و بعضی دومی، و نبودش یعنی همه حساب‌ها در فهرست کاربر
 * «ناشناس» دیده شوند.
 */
export function otpauthUri(input: {
  secret: string;
  account: string;
  issuer: string;
  digits?: number;
  step?: number;
}): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const q = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(input.digits ?? 6),
    period: String(input.step ?? 30),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}
