/**
 * شناسه دستگاه — یک **شناسه**، نه یک راز.
 *
 * ADR-005 این تفکیک را صریح کرده و مهم است: `fingerprint` فقط می‌گوید
 * «این همان مرورگری است که قبلاً دیده‌ایم». چیزی که واقعاً دستگاه را
 * اثبات می‌کند، راز ثبت‌نام (`device.secret_hash`) است که سرور در یک
 * کوکی HttpOnly می‌گذارد و کد صفحه اصلاً نمی‌تواند بخواندش.
 *
 * پس اینجا هیچ تلاشی برای «اثر انگشت مرورگر» (Canvas، فونت، صفحه)
 * نمی‌کنیم: هم شکننده است، هم حریم خصوصی را می‌خورد، و هم چیزی به
 * امنیت اضافه نمی‌کند چون راز جای دیگری است. یک عدد تصادفی پایدار
 * دقیقاً همان کاری را می‌کند که سرور از این میدان می‌خواهد.
 */

const KEY = "labelmod_device";

/** بازه‌ای که سمت سرور `pinBody` می‌پذیرد: ۸ تا ۱۲۸ کاراکتر. */
const LENGTH = 32;

/**
 * حافظه‌ای که ممکن است نباشد.
 *
 * در حالت ناشناس بعضی مرورگرها خودِ خواندن `localStorage` را هم پرتاب
 * می‌کنند، نه فقط نوشتن. پس هر دسترسی داخل try است و شکستش یعنی
 * «حافظه‌ای نیست»، نه یک صفحه سفید.
 */
export interface DeviceStore {
  read(key: string): string | null;
  write(key: string, value: string): void;
}

export const browserStore: DeviceStore = {
  read(key) {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  write(key, value) {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      /* حافظه در دسترس نیست — دستگاه هر بار تازه دیده می‌شود. */
    }
  },
};

/** رشته تصادفی امن. `crypto` در هر مرورگر هدف این پروژه هست. */
function randomId(): string {
  const bytes = new Uint8Array(LENGTH / 2);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** فقط چیزی که خودمان نوشته‌ایم پذیرفته می‌شود. */
function isValid(v: string | null): v is string {
  return v !== null && /^[0-9a-f]{8,128}$/.test(v);
}

/**
 * شناسه پایدار این مرورگر. اگر نبود یا خراب بود، تازه ساخته می‌شود.
 *
 * شناسه تازه یعنی دستگاه از دید سرور **ناشناس** است: ورود کامل کار
 * می‌کند، ولی PIN تا تأیید مدیر و صدور راز تازه کار نمی‌کند. این
 * درست است — پاک‌کردن حافظه مرورگر نباید اعتماد دستگاه را حفظ کند.
 */
export function deviceFingerprint(store: DeviceStore = browserStore): string {
  // گارد اینجاست، نه فقط در `browserStore`: قرارداد این تابع «هرگز
  // پرتاب نمی‌کند» است و نباید به پیاده‌سازی Store وابسته باشد. اگر
  // این تابع پرتاب کند، کل صفحه ورود سفید می‌شود — یعنی حالت ناشناس
  // مرورگر به‌جای «PIN کار نمی‌کند»، «هیچ‌چیز کار نمی‌کند» می‌شد.
  let existing: string | null = null;
  try {
    existing = store.read(KEY);
  } catch {
    existing = null;
  }
  if (isValid(existing)) return existing;

  const fresh = randomId();
  try {
    store.write(KEY, fresh);
  } catch {
    /* ذخیره نشد — دفعه بعد شناسه تازه‌ای ساخته می‌شود. */
  }
  return fresh;
}
