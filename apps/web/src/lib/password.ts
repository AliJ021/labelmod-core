/** ۲۵۶ بیت تصادف؛ ۶۴ نویسه برای بیشترین حداقل مجاز سیاست، بدون تغییر حساب. */
export function suggestPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
