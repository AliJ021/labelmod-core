/**
 * کادر «افزودن کالا» در حین افزودن فوکوس را نگه می‌دارد و قفل می‌ماند.
 *
 * پیش‌تر ورودی `disabled={busy}` بود: فوکوس با هر افزودن از دست می‌رفت (صندوق‌دار برای کالای
 * بعدی دوباره روی کادر می‌زد) و React پس از commit موقعیت اسکرول همهٔ نیاکان را می‌خواند —
 * style+layout اجباری روی کل صفحه، بزرگ‌شونده با سبد (شواهد: apps/web/e2e/perf). حالا
 * فقط‌خواندنی + aria-disabled است. این آزمون رفتار را می‌سنجد، نه زمان را.
 */
import { test, expect, type MockApi } from "./fixtures";

const id = "33333333-3333-4333-8333-333333333333";
const shift = "44444444-4444-4444-8444-444444444444";
const actor = "22222222-2222-4222-8222-222222222222";
const line = (n: number) => ({ id: `l${n}`, lineNo: n, variationId: `66666666-6666-4666-8666-00000000000${n}`, productName: `کالای ${n}`,
  sku: `SKU-${n}`, qty: "1", unitPrice: "100000", netAmount: "100000", discountAmount: "0", listPrice: null, priceOverrideReason: null, discountReason: null });
const draft = (n: number) => ({ id, number: null, branchId: "b1", warehouseId: "w1", shiftId: shift, createdBy: actor, customerId: null, status: "draft",
  channel: "pos", grossAmount: String(100000 * n), discountAmount: "0", netAmount: String(100000 * n), taxAmount: "0", shippingAmount: "0",
  payableAmount: String(100000 * n), paidAmount: "0", receivedAmount: "0", recipientId: null, gift: null, occurredAt: "2026-10-10T08:00:00Z",
  lines: Array.from({ length: n }, (_, i) => line(i + 1)) });

function mock(api: MockApi) {
  api.defaults["GET /payment-methods"] = { methods: [{ code: "cash", name: "نقد", kind: "cash", requiresRef: false }] };
  api.defaults["GET /shifts/current"] = { id: shift, userId: actor, branchId: "b1", status: "open", openingCash: "0" };
  api.defaults["GET /gift-options"] = { wraps: [], colors: [], flowers: [] };
  api.defaults[`GET /invoices/${id}`] = draft(1);
  api.defaults[`GET /invoices/${id}/customer`] = { customer: null };
  api.defaults[`GET /invoices/${id}/payments`] = { payments: [] };
  api.defaults["GET /pos/products"] = { products: [], exactVariationId: line(2).variationId };
}

test("در حین افزودن، کادر فوکوس را نگه می‌دارد، قفل است و تایپ نمی‌پذیرد؛ پس از آن آمادهٔ کالای بعدی است", async ({ page, api }) => {
  mock(api);
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const scans: unknown[] = [];
  api.handlers.set(`POST /invoices/${id}/scan`, async route => {
    scans.push(route.request().postDataJSON());
    await held;
    await route.fulfill({ json: { invoice: draft(2), replayed: false } });
  });
  await page.addInitScript(([invoiceId, shiftId]) => localStorage.setItem("labelmod_open_cart", JSON.stringify({ invoiceId, shiftId })), [id, shift]);
  await page.goto("/?page=pos&pos.branch=b1&pos.warehouse=w1");
  await expect(page.locator(".lines li")).toHaveCount(1);
  const entry = page.getByRole("region", { name: "افزودن کالا" }).getByRole("searchbox");
  await entry.fill("SKU-2"); await entry.press("Enter");

  await expect.poll(() => scans.length).toBe(1);
  await expect(entry).toBeDisabled();
  await expect(entry).toBeFocused();
  await page.keyboard.type("9");
  await expect(entry).toHaveValue("SKU-2");
  await page.keyboard.press("Enter");

  release();
  await expect(page.locator(".lines li")).toHaveCount(2);
  await expect(entry).toBeEnabled();
  await expect(entry).toBeFocused();
  await expect(entry).toHaveValue("");
  // Enterِ زده‌شده در حال کار، اسکن دوم نساخت.
  expect(scans).toHaveLength(1);
});

/*
 * اسکرول «کمینه» (`scrollIntoView({block: "nearest"})`) — همان که برنامه برای بخش «بیشتر» پرداخت
 * به کار می‌برد — هدف را درست تا لبهٔ پایین صفحه می‌آورد؛ بی scroll-padding همان‌جا زیر خلاصهٔ چسبان
 * و نوار پایین می‌ماند. فوکوس با Tab در Chromium هدف را وسط می‌آورد و این مشکل را نداشت.
 */
test("۳۲۰px: اسکرول کمینه «ثبت قیمت» را بالای خلاصهٔ چسبان و نوار پایین می‌آورد، نه زیر آن‌ها", async ({ page, api }) => {
  mock(api);
  // چند قلم تا دکمه زیر لبهٔ صفحه بیفتد و فوکوس واقعاً اسکرول کند.
  api.defaults[`GET /invoices/${id}`] = draft(3);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.addInitScript(([invoiceId, shiftId]) => localStorage.setItem("labelmod_open_cart", JSON.stringify({ invoiceId, shiftId })), [id, shift]);
  await page.goto("/?page=pos&pos.branch=b1&pos.warehouse=w1");
  await expect(page.getByRole("complementary", { name: "خلاصهٔ پرداخت" })).toBeVisible();
  await page.getByRole("button", { name: "ویرایش قیمت کالای 1", exact: true }).click();
  const save = page.getByRole("button", { name: "ثبت قیمت", exact: true });
  await expect(save).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await save.evaluate(n => n.getBoundingClientRect().top > innerHeight), "پیش از فوکوس، دکمه زیر لبهٔ صفحه است").toBe(true);
  await save.evaluate(n => n.scrollIntoView({ block: "nearest", behavior: "instant" }));
  expect(await save.evaluate(n => { const b = n.getBoundingClientRect(); const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return !!hit && (hit === n || n.contains(hit)); })).toBe(true);
  expect(api.calls.filter(c => /^(POST|PATCH|PUT|DELETE)/.test(c))).toEqual([]);
});
