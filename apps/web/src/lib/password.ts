/** ۱۲۸ بیت تصادف از مرورگر؛ پیشنهاد رمز هیچ درخواست تغییردهنده‌ای ندارد. */
export function suggestPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
