/**
 * بارکدخوان USB/HID (keyboard wedge) روی صندوق — رویدادهای واقعی کیبورد، نه `fill`.
 *
 * شکایت مالک: «اسکن بارکد چاپی فقط 2 در فیلد می‌گذارد». بارکد داخلی EAN-13 با پیشوند
 * ۲۰ است. `ScanBuffer` عمداً رقم **اول** را عبور می‌دهد (هنوز از تایپ انسان قابل تشخیص
 * نیست) و از رقم دوم به بعد را می‌بلعد؛ کامنتش می‌گفت «فراخوان همان یکی را پاک کند»، ولی
 * صندوق هرگز پاکش نمی‌کرد. پس «2» در کادر جست‌وجو می‌ماند. و اگر اسکنر پایان‌دهندهٔ
 * Enter نفرستد (Tab یا بی‌پسوند)، بقیهٔ رقم‌ها بی‌صدا بلعیده و هیچ کالایی اضافه نمی‌شد.
 *
 * هر کلید با `keyboard.down`/`up` واقعی و بی‌تأخیر فرستاده می‌شود (مثل اسکنر)؛ تایپ دستی
 * با فاصلهٔ انسانی. مقدار بارکد هرگز تغییر نمی‌کند: همان رشته به `POST …/scan` می‌رسد.
 */
import { test, expect, type MockApi } from "./fixtures";
import type { Page } from "@playwright/test";

const id = "33333333-3333-4333-8333-333333333333";
const shift = "44444444-4444-4444-8444-444444444444";
const actor = "22222222-2222-4222-8222-222222222222";
const draft = { id, number: null, branchId: "b1", warehouseId: "w1", shiftId: shift, createdBy: actor, customerId: null, status: "draft",
  channel: "pos", grossAmount: "0", discountAmount: "0", netAmount: "0", taxAmount: "0", shippingAmount: "0",
  payableAmount: "0", paidAmount: "0", receivedAmount: "0", recipientId: null, gift: null, occurredAt: "2026-10-10T08:00:00Z", lines: [] };

function mock(api: MockApi): unknown[] {
  api.defaults["GET /payment-methods"] = { methods: [{ code: "cash", name: "نقد", kind: "cash", requiresRef: false }] };
  api.defaults["GET /shifts/current"] = { id: shift, userId: actor, branchId: "b1", status: "open", openingCash: "0" };
  api.defaults["GET /gift-options"] = { wraps: [], colors: [], flowers: [] };
  api.defaults[`GET /invoices/${id}`] = draft;
  api.defaults[`GET /invoices/${id}/customer`] = { customer: null };
  api.defaults[`GET /invoices/${id}/payments`] = { payments: [] };
  api.defaults["GET /pos/products"] = { products: [], exactVariationId: null };
  const scans: unknown[] = [];
  api.handlers.set(`POST /invoices/${id}/scan`, async route => {
    scans.push(route.request().postDataJSON());
    await route.fulfill({ json: { invoice: draft, replayed: false } });
  });
  return scans;
}

async function open(page: Page, api: MockApi) {
  const scans = mock(api);
  await page.addInitScript(([invoiceId, shiftId]) => localStorage.setItem("labelmod_open_cart", JSON.stringify({ invoiceId, shiftId })), [id, shift]);
  await page.goto("/?page=pos&pos.branch=b1&pos.warehouse=w1");
  const entry = page.getByRole("region", { name: "افزودن کالا" }).getByRole("searchbox");
  await expect(entry).toBeVisible();
  return { scans, entry };
}

/**
 * مثل اسکنر: همهٔ کلیدها پشت سر هم و بی مکث. در Chromium رویداد واقعی سیستم‌عامل با CDP
 * (keyDown با متن، پس رقم اول واقعاً در کادر می‌نشیند) و همه با هم فرستاده می‌شوند: `await`
 * جدا برای هر کلید زیر بار CI از آستانهٔ ۵۰ms کندتر می‌شد و آزمون دیگر اسکنر نبود.
 * موتورهای دیگر CDP ندارند: رویداد keydown در یک تکهٔ کد صفحه (نویسه‌ای درج نمی‌شود، پس
 * آن‌جا فقط تشخیص، پسوند و مقدار بارکد سنجیده می‌شود؛ نشت رقم اول را Chromium می‌سنجد).
 */
async function scan(page: Page, keys: string[], browserName: string) {
  if (browserName === "chromium") {
    const cdp = await page.context().newCDPSession(page);
    const code = (k: string) => {
      const ascii = /^[0-9]$/.test(k) ? k : /^[\u06F0-\u06F9]$/.test(k) ? String(k.charCodeAt(0) - 0x06f0) : null;
      if (ascii !== null) return { key: k, text: k, code: `Digit${ascii}`, windowsVirtualKeyCode: 48 + Number(ascii) };
      return k === "Enter" ? { key: "Enter", text: "\r", code: "Enter", windowsVirtualKeyCode: 13 } : { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 };
    };
    await Promise.all(keys.flatMap(k => { const c = code(k); const { text: _t, ...up } = c as { text?: string };
      return [cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...c }), cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...up })]; }));
    await cdp.detach();
  } else {
    await page.evaluate(ks => { const t = document.activeElement ?? document.body;
      for (const key of ks) t.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); }, keys);
  }
}
const digits = (s: string) => [...s];
const EAN = "2000000012018";
const LEGACY = "12345678901234567";

test("HID: اسکن با Enter در کادر فوکوس‌دار — بارکد کامل ثبت و هیچ «2»ی در کادر نمی‌ماند", async ({ page, api, browserName }) => {
  const { scans, entry } = await open(page, api);
  await entry.focus();
  await scan(page, [...digits(EAN), "Enter"], browserName);
  await expect.poll(() => scans.length).toBe(1);
  expect(scans[0]).toMatchObject({ barcode: EAN, qty: "1" });
  await expect(entry).toHaveValue("");
  await expect(entry).toBeFocused();
  // اسکن دوم پشت سر هم: باز هم کامل و بی نشت.
  await scan(page, [...digits(EAN), "Enter"], browserName);
  await expect.poll(() => scans.length).toBe(2);
  await expect(entry).toHaveValue("");
});

test("HID: بیرون از هر کادر، کد قدیمی ۱۷ رقمی هم کامل و بی‌تغییر ثبت می‌شود", async ({ page, api, browserName }) => {
  const { scans, entry } = await open(page, api);
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await scan(page, [...digits(LEGACY), "Enter"], browserName);
  await expect.poll(() => scans.length).toBe(1);
  expect(scans[0]).toMatchObject({ barcode: LEGACY });
  await expect(entry).toHaveValue("");
});

test("HID: اسکنر با پسوند Tab یا بی‌پسوند هم ثبت می‌شود، نه بلعیده", async ({ page, api, browserName }) => {
  const { scans, entry } = await open(page, api);
  await entry.focus();
  await scan(page, [...digits(EAN), "Tab"], browserName);
  await expect.poll(() => scans.length).toBe(1);
  await expect(entry).toHaveValue("");
  await entry.focus();
  await scan(page, digits(EAN), browserName);
  await expect.poll(() => scans.length).toBe(2);
  expect(scans.map(s => (s as { barcode: string }).barcode)).toEqual([EAN, EAN]);
  await expect(entry).toHaveValue("");
});

test("HID: چیدمان کیبورد فارسی (رقم ۰–۹ فارسی) همان بارکد لاتین را ثبت می‌کند", async ({ page, api, browserName }) => {
  const { scans, entry } = await open(page, api);
  await entry.focus();
  const fa = digits(EAN).map(d => String.fromCharCode(0x06f0 + Number(d)));
  // Playwright کلید «۲» را نمی‌شناسد؛ همان کد کلید ردیف بالا با متن فارسی (مثل اسکنر روی چیدمان فارسی ویندوز).
  await scan(page, [...fa, "Enter"], browserName);
  await expect.poll(() => scans.length).toBe(1);
  expect(scans[0]).toMatchObject({ barcode: EAN });
  await expect(entry).toHaveValue("");
});

test("تایپ دستی با سرعت انسان دست نمی‌خورد و اسکن نمی‌سازد", async ({ page, api }) => {
  const { scans, entry } = await open(page, api);
  await entry.focus();
  await page.keyboard.type("2000", { delay: 120 });
  await expect(entry).toHaveValue("2000");
  await page.waitForTimeout(300);
  expect(scans).toHaveLength(0);
  await expect(entry).toHaveValue("2000");
});
