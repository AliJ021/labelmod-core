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
// شنوندهٔ storage ماژول — Node پنجره ندارد، پس پیش از import گرفته می‌شود.
let onStorage: ((e: Partial<StorageEvent>) => void) | null = null;
(globalThis as unknown as { addEventListener: (t: string, h: (e: Partial<StorageEvent>) => void) => void }).addEventListener =
  (t, h) => { if (t === "storage") onStorage = h; };

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

test("مقدار ذخیره‌شدهٔ خراب پایهٔ ادغام نمی‌شود؛ پروفایل معتبر حافظه می‌ماند", async () => {
  const { labelSize } = await import("../src/lib/label-size.ts");
  labelSize.set({ columns: "2", gap: "4", media: "105" });
  store.set(KEY, "{خراب");
  labelSize.set({ offset: "1" });
  const saved = JSON.parse(store.get(KEY)!) as Record<string, string>;
  assert.deepEqual([saved.columns, saved.gap, saved.media, saved.offset], ["2", "4", "105", "1"]);
});

test("رویداد storage: کلید خودش و clear() همین localStorage همگام می‌شوند؛ کلید دیگر و sessionStorage نه", async () => {
  const { labelSize, DEFAULT_SIZE_CHOICE } = await import("../src/lib/label-size.ts");
  assert.ok(onStorage, "شنوندهٔ storage ثبت نشد");
  const local = globalThis.localStorage;
  labelSize.set({ columns: "2", gap: "4", media: "105" });
  const owner = { ...DEFAULT_SIZE_CHOICE, columns: "2", gap: "3", media: "104" };
  onStorage!({ key: KEY, newValue: JSON.stringify(owner), storageArea: local });
  assert.deepEqual([labelSize.get().gap, labelSize.get().media], ["3", "104"]);
  // کنترل منفی: کلید دیگر و clear() روی sessionStorage پروفایل را دست نمی‌زنند.
  onStorage!({ key: "other", newValue: "x", storageArea: local });
  onStorage!({ key: null, newValue: null, storageArea: {} as Storage });
  assert.equal(labelSize.get().gap, "3");
  // clear() در تب دیگر: این‌جا هم پیش‌فرض، تا set بعدی پروفایل کهنه را دوباره ننویسد.
  onStorage!({ key: null, newValue: null, storageArea: local });
  assert.deepEqual(labelSize.get(), DEFAULT_SIZE_CHOICE);
});
