/**
 * اعلان «تنظیمی ذخیره شد» میان تب‌های همین مرورگر.
 *
 * صندوقِ باز سیاستش (مثل `pos.require_customer`) را با `focus` پنجره دوباره می‌خواند؛ ولی تبی که
 * کنار تب تنظیمات باز و دیده‌شده است (پنجرهٔ دوم، صفحهٔ دوم) هیچ focusی نمی‌گیرد و تا reload
 * سیاست کهنه نشان می‌داد. فقط نام کلید فرستاده می‌شود، نه مقدار: گیرنده همیشه از سرور می‌خواند و
 * مرجع همان سرور و گارد دیتابیس است. نبودِ BroadcastChannel یعنی همان رفتار پیشین، نه خطا.
 */
const CHANNEL = "labelmod-settings";

export function announceSettingSaved(key: string): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage({ key });
  channel.close();
}

export function onSettingSaved(listener: (key: string) => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event: MessageEvent) => {
    const key = (event.data as { key?: unknown } | null)?.key;
    if (typeof key === "string") listener(key);
  };
  return () => channel.close();
}
