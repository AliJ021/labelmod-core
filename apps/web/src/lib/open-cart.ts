/**
 * سبدی که هنوز بسته نشده — تا Reload وسط فروش، آن را یتیم نکند.
 *
 * ── مسئله ─────────────────────────────────────────────────────────
 *
 * فاکتور پیش‌نویس در **دیتابیس** ساخته می‌شود، ولی شناسه‌اش فقط در
 * حافظه صفحه بود. تبلتی که بخوابد، مرورگری که Refresh شود، برقی که
 * برود: صندوق‌دار سبد تازه شروع می‌کند و آن پیش‌نویس در دیتابیس
 * می‌ماند.
 *
 * بی‌آزار نیست. `sales.close_shift` می‌گوید «شیفت با فاکتور
 * نهایی‌نشده بسته نمی‌شود» — پس آخر شب کشو بسته نمی‌شود و کسی
 * نمی‌داند چرا.
 *
 * ── چرا شناسه شیفت هم ذخیره می‌شود ────────────────────────────────
 *
 * سبدِ دیروز نباید امروز برگردد. اگر شیفت عوض شده باشد، آن پیش‌نویس
 * دیگر مال این نشست نیست و بازگرداندنش یعنی فروش را به شیفت اشتباه
 * چسبانده‌ایم.
 */
import { safeRead, browserStore, type DeviceStore } from "./device.ts";

const KEY = "labelmod_open_cart";

export interface OpenCart {
  invoiceId: string;
  shiftId: string;
}

/** فقط شکلی که خودمان نوشته‌ایم پذیرفته می‌شود. */
function isOpenCart(v: unknown): v is OpenCart {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.invoiceId === "string" && typeof o.shiftId === "string";
}

export function rememberCart(cart: OpenCart, store: DeviceStore = browserStore): void {
  try {
    store.write(KEY, JSON.stringify(cart));
  } catch {
    /* حافظه نیست — بازیابی کار نمی‌کند، ولی فروش می‌کند. */
  }
}

export function forgetCart(store: DeviceStore = browserStore): void {
  try {
    store.write(KEY, "");
  } catch {
    /* بی‌اهمیت. */
  }
}

/**
 * سبد باز این شیفت، اگر باشد.
 *
 * `shiftId` نامطابق یعنی سبد مال نشست دیگری است — `null` برمی‌گردد و
 * یادداشت هم پاک می‌شود تا دفعه بعد دوباره سنجیده نشود.
 */
export function readCart(shiftId: string, store: DeviceStore = browserStore): OpenCart | null {
  // همان پوششی که `deviceFingerprint` دارد — یک تعریف، نه دو تا.
  const raw = safeRead(store, KEY);
  if (raw === null || raw === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    forgetCart(store);
    return null;
  }

  if (!isOpenCart(parsed)) {
    forgetCart(store);
    return null;
  }
  if (parsed.shiftId !== shiftId) {
    forgetCart(store);
    return null;
  }
  return parsed;
}
