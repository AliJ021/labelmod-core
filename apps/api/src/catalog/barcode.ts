/**
 * بارکد داخلی فروشگاه — EAN-13 با پیشوند «حلقه محدود».
 *
 * چرا EAN-13 و نه یک رشته دلخواه: هر بارکدخوان ارزانی EAN-13 را
 * می‌خواند و رقم کنترلش را خودش می‌سنجد. یعنی اگر برچسب خط بخورد یا
 * کج چاپ شود، دستگاه **خطا می‌دهد** به‌جای اینکه عدد غلط بخواند و
 * کالای دیگری را بفروشد.
 *
 * چرا پیشوند ۲۰: استاندارد GS1 محدوده ۰۲ و ۲۰ تا ۲۹ را برای «گردش
 * محدود در یک شرکت» کنار گذاشته است. یعنی بارکدی که ما می‌سازیم هرگز
 * با بارکد واقعی یک تولیدکننده اشتباه گرفته نمی‌شود — حتی اگر روزی
 * کالای برچسب‌دار کارخانه هم بفروشیم.
 */

/** پیشوند گردش محدود در شرکت — GS1. */
const IN_STORE_PREFIX = "20";

/** بیشترین شماره‌ای که در ۱۰ رقم جا می‌شود. */
export const MAX_SERIAL = 9_999_999_999;

/**
 * رقم کنترل EAN-13.
 *
 * وزن ارقام از چپ: ۱، ۳، ۱، ۳ … و رقم کنترل مکمل ده است.
 */
export function ean13CheckDigit(twelveDigits: string): string {
  if (!/^\d{12}$/.test(twelveDigits)) {
    throw new Error("رقم کنترل EAN-13 روی ۱۲ رقم حساب می‌شود");
  }
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = twelveDigits.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  return String((10 - (sum % 10)) % 10);
}

/** شماره سریال داخلی → بارکد ۱۳ رقمی معتبر. */
export function makeEan13(serial: number): string {
  if (!Number.isInteger(serial) || serial < 0 || serial > MAX_SERIAL) {
    throw new Error(`شماره سریال بارکد خارج از محدوده است: ${serial}`);
  }
  const body = IN_STORE_PREFIX + String(serial).padStart(10, "0");
  return body + ean13CheckDigit(body);
}

/** آیا این یک بارکد داخلی ساخته‌شده توسط ماست؟ */
export function isInStoreBarcode(barcode: string): boolean {
  return (
    /^\d{13}$/.test(barcode) &&
    barcode.startsWith(IN_STORE_PREFIX) &&
    ean13CheckDigit(barcode.slice(0, 12)) === barcode[12]
  );
}

/** شماره سریال داخلِ یک بارکد ساخته‌شده توسط ما. */
export function serialOf(barcode: string): number | null {
  if (!isInStoreBarcode(barcode)) return null;
  return Number(barcode.slice(2, 12));
}
