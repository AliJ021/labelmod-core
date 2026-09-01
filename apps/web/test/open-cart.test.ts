/**
 * سبدی که با Reload یتیم نشود.
 *
 * `sales.close_shift` می‌گوید «شیفت با فاکتور نهایی‌نشده بسته
 * نمی‌شود» — پس پیش‌نویسِ جامانده یعنی آخر شب کشو بسته نمی‌شود و
 * کسی نمی‌داند چرا.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { DeviceStore } from "../src/lib/device.ts";
import { forgetCart, readCart, rememberCart } from "../src/lib/open-cart.ts";

function memoryStore(seed: Record<string, string> = {}): DeviceStore {
  const map = new Map(Object.entries(seed));
  return {
    read: (k) => map.get(k) ?? null,
    write: (k, v) => void map.set(k, v),
  };
}

const hostileStore: DeviceStore = {
  read() {
    throw new Error("حافظه در دسترس نیست");
  },
  write() {
    throw new Error("حافظه در دسترس نیست");
  },
};

describe("بازگرداندن سبد باز", () => {
  test("سبد همان شیفت برمی‌گردد", () => {
    const s = memoryStore();
    rememberCart({ invoiceId: "inv-1", shiftId: "sh-1" }, s);
    assert.deepEqual(readCart("sh-1", s), { invoiceId: "inv-1", shiftId: "sh-1" });
  });

  test("سبد شیفت دیگر برنمی‌گردد", () => {
    // سبدِ دیروز نباید امروز برگردد: چسباندنش به شیفت امروز یعنی
    // فروش به دوره اشتباه خورده.
    const s = memoryStore();
    rememberCart({ invoiceId: "inv-1", shiftId: "sh-1" }, s);
    assert.equal(readCart("sh-2", s), null);
  });

  test("سبد شیفت نامطابق پاک هم می‌شود", () => {
    const s = memoryStore();
    rememberCart({ invoiceId: "inv-1", shiftId: "sh-1" }, s);
    readCart("sh-2", s);
    // حتی با شیفت درست هم دیگر نیست — یک بار سنجیده شد و کنار رفت.
    assert.equal(readCart("sh-1", s), null);
  });

  test("فراموش‌کردن، سبد را برمی‌دارد", () => {
    const s = memoryStore();
    rememberCart({ invoiceId: "inv-1", shiftId: "sh-1" }, s);
    forgetCart(s);
    assert.equal(readCart("sh-1", s), null);
  });

  test("وقتی چیزی ذخیره نشده", () => {
    assert.equal(readCart("sh-1", memoryStore()), null);
  });
});

describe("داده خراب", () => {
  test("JSON نامعتبر", () => {
    assert.equal(readCart("sh-1", memoryStore({ labelmod_open_cart: "{{{" })), null);
  });

  test("شکل نامعتبر", () => {
    const s = memoryStore({ labelmod_open_cart: '{"invoiceId":123}' });
    assert.equal(readCart("sh-1", s), null);
  });

  test("رشته خالی", () => {
    assert.equal(readCart("sh-1", memoryStore({ labelmod_open_cart: "" })), null);
  });
});

describe("حافظه‌ای که پرتاب می‌کند", () => {
  test("خواندن، صفحه را نمی‌شکند", () => {
    // حالت ناشناس: بازیابی کار نمی‌کند، ولی فروش باید کار کند.
    assert.equal(readCart("sh-1", hostileStore), null);
  });

  test("نوشتن و فراموش‌کردن هم پرتاب نمی‌کنند", () => {
    assert.doesNotThrow(() => rememberCart({ invoiceId: "i", shiftId: "s" }, hostileStore));
    assert.doesNotThrow(() => forgetCart(hostileStore));
  });
});
