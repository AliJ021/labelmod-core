/**
 * تصمیم «کدام صفحه» و شناسه دستگاه.
 *
 * این پروژه تست DOM ندارد و لازم هم نیست: منطقی که می‌تواند اشتباه
 * شود، تابع خالص است و همین‌جا سنجیده می‌شود. کامپوننت‌ها عمداً نازک
 * نگه داشته شده‌اند تا چیزی برای سنجیدن در آن‌ها نماند.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../src/lib/api.ts";
import { deviceFingerprint, type DeviceStore } from "../src/lib/device.ts";
import {
  authView,
  forgetLock,
  isNoSession,
  readLockedUser,
  rememberLock,
  type Me,
} from "../src/lib/session.ts";

/** حافظه ساختگی — تا تست به مرورگر نیاز نداشته باشد. */
function memoryStore(seed: Record<string, string> = {}): DeviceStore {
  const map = new Map(Object.entries(seed));
  return {
    read: (k) => map.get(k) ?? null,
    write: (k, v) => void map.set(k, v),
  };
}

/** حافظه‌ای که مثل حالت ناشناس، هر دسترسی را پرتاب می‌کند. */
const hostileStore: DeviceStore = {
  read() {
    throw new Error("حافظه در دسترس نیست");
  },
  write() {
    throw new Error("حافظه در دسترس نیست");
  },
};

const ME: Me = {
  id: "u1",
  fullName: "صندوق‌دار یک",
  roles: ["cashier"],
  expiresAt: new Date().toISOString(),
  elevated: true,
  device: null,
};

describe("تصمیم صفحه احراز هویت", () => {
  test("تا وقتی پاسخ سرور نیامده، هیچ فرمی نشان داده نمی‌شود", () => {
    assert.equal(authView({ loaded: false, me: null, lockedUser: null }), "loading");
    // حتی اگر یادداشت قفل هست: پرش از «قفل» به «ورود» بدتر از یک لحظه صبر است.
    assert.equal(authView({ loaded: false, me: null, lockedUser: "علی" }), "loading");
  });

  test("بدون نشست و بدون یادداشت قفل → فرم ورود", () => {
    assert.equal(authView({ loaded: true, me: null, lockedUser: null }), "login");
  });

  test("بدون نشست ولی با یادداشت قفل → صفحه PIN", () => {
    assert.equal(authView({ loaded: true, me: null, lockedUser: "علی" }), "locked");
  });

  test("نشست زنده همیشه بر یادداشت قفل می‌چربد", () => {
    // اگر از تب دیگری وارد شده باشد، نگه‌داشتنش پشت صفحه PIN یعنی
    // کاربر را الکی پشت دری نگه داشته‌ایم که باز است.
    assert.equal(authView({ loaded: true, me: ME, lockedUser: "علی" }), "ready");
  });
});

describe("یادداشت قفل", () => {
  test("نوشتن و خواندن نام", () => {
    const s = memoryStore();
    assert.equal(readLockedUser(s), null);
    rememberLock("صندوق‌دار یک", s);
    assert.equal(readLockedUser(s), "صندوق‌دار یک");
  });

  test("فراموش‌کردن، قفل را برمی‌دارد", () => {
    const s = memoryStore();
    rememberLock("صندوق‌دار یک", s);
    forgetLock(s);
    assert.equal(readLockedUser(s), null);
  });

  test("رشته خالی یا فاصله، قفل حساب نمی‌شود", () => {
    assert.equal(readLockedUser(memoryStore({ labelmod_locked_user: "" })), null);
    assert.equal(readLockedUser(memoryStore({ labelmod_locked_user: "   " })), null);
  });
});

describe("تشخیص «نشستی نیست»", () => {
  test("۴۰۱ یا کد no_session", () => {
    assert.ok(isNoSession(new ApiError(401, "whatever", "پیام", null)));
    assert.ok(isNoSession(new ApiError(403, "no_session", "پیام", null)));
  });

  test("خطاهای دیگر با آن اشتباه نمی‌شوند", () => {
    // مهم است: اگر ۴۰۳ «دسترسی نداری» را «وارد نشده» بخوانیم، کاربر
    // بی‌دلیل از برنامه بیرون انداخته می‌شود.
    assert.equal(isNoSession(new ApiError(403, "forbidden", "پیام", null)), false);
    assert.equal(isNoSession(new ApiError(409, "rule_violation", "پیام", null)), false);
    assert.equal(isNoSession(new Error("قطع شبکه")), false);
    assert.equal(isNoSession(null), false);
  });
});

describe("شناسه دستگاه", () => {
  test("پایدار می‌ماند و در بازه‌ای است که سرور می‌پذیرد", () => {
    const s = memoryStore();
    const first = deviceFingerprint(s);
    assert.match(first, /^[0-9a-f]{8,128}$/);
    assert.equal(deviceFingerprint(s), first, "بار دوم همان شناسه");
  });

  test("مقدار خراب دور انداخته می‌شود", () => {
    const s = memoryStore({ labelmod_device: "نه-یک-شناسه" });
    assert.match(deviceFingerprint(s), /^[0-9a-f]{8,128}$/);
  });

  test("دو دستگاه، دو شناسه", () => {
    assert.notEqual(deviceFingerprint(memoryStore()), deviceFingerprint(memoryStore()));
  });

  test("حافظه‌ای که پرتاب می‌کند، صفحه را نمی‌شکند", () => {
    // حالت ناشناس: شناسه هر بار تازه است — یعنی PIN کار نمی‌کند، ولی
    // ورود کامل باید کار کند. صفحه سفید قابل قبول نیست.
    assert.match(deviceFingerprint(hostileStore), /^[0-9a-f]{8,128}$/);
  });
});
