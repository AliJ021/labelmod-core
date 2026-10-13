/**
 * پروفایل لیبل میان تب‌ها گم نمی‌شود — read-merge-write روی localStorage.
 *
 * کنترل منفی: با نسخهٔ پیشین (`{...choice, ...patch}` از حافظهٔ همین تب)، نوشتن تب دیگر
 * (لاینر ۱۰۵ و فاصله ۴) با یک تغییر کوچک در این تب پاک می‌شد.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear(), key: () => null, length: 0,
} as Storage;
const KEY = "labelmod.label-size.v1";

test("تب دیگر لاینر/فاصله را ذخیره کرده؛ تغییر جابه‌جایی در این تب آن‌ها را بازنویسی نمی‌کند", async () => {
  const { labelSize, DEFAULT_SIZE_CHOICE } = await import("../src/lib/label-size.ts");
  // این تب با پیش‌فرض بالا آمده (هنوز چیزی ذخیره نشده).
  labelSize.set({ columns: "2" });
  // تب دوم (همان مرورگر) پروفایل اندازه‌گیری‌شدهٔ مالک را ذخیره می‌کند.
  const other = { ...DEFAULT_SIZE_CHOICE, columns: "2", gap: "4", media: "105", offset: "0" };
  store.set(KEY, JSON.stringify(other));
  // این تب فقط جابه‌جایی را عوض می‌کند.
  labelSize.set({ offset: "0.5" });
  const saved = JSON.parse(store.get(KEY)!) as Record<string, string>;
  assert.deepEqual([saved.columns, saved.gap, saved.media, saved.offset], ["2", "4", "105", "0.5"]);
});
