/**
 * چاپ لیبل — سه ایراد مشاهده‌شده در مرورگر (پیش از این اصلاح):
 * ۱. اندازهٔ انتخاب‌شده در صفحهٔ کالا به فهرست گروهی نمی‌رسید و نوبت گروهی با ۵۰×۳۰ می‌رفت.
 * ۲. تنوع بی‌قیمت بی‌هیچ هشداری لیبل «بدون قیمت» می‌گرفت؛ جدول لیبل قیمت را نشان نمی‌داد.
 * ۳. خطای اندازه زیر دکمه‌ها و با رقم لاتین بود، نه کنار میدان‌ها.
 * فقط دادهٔ ساختگی؛ مقدار بارکد و قیمت روی لیبل را سرور می‌خواند و این‌جا دست نمی‌خورد.
 */
import { test, expect, product, openCatalog } from "./fixtures";
import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { Variation } from "../src/lib/catalog";

const base = { status: "active", priceKind: "regular", priceSince: "2026-09-16T00:00:00Z", locked: false } as const;
const variations = [
  { ...base, id: "v1", color: "سرمه‌ای", size: "S", sku: "TR-1405-NAVY-S", barcode: "2000000014012", price: "1234000" },
  { ...base, id: "v2", color: "کرم", size: "XL", sku: "TR-1405-CREAM-XL", barcode: "2000000014043", price: null },
] as Variation[];

test("label preview keeps its computed print layout under the production CSP", async ({ page, api }, testInfo) => {
  const caddy = await readFile(new URL("../../../ops/deploy/Caddyfile", import.meta.url), "utf8");
  const csp = caddy.match(/Content-Security-Policy "(default-src 'none'; script-src[^"]+)"/)?.[1];
  expect(csp).toContain("style-src-elem 'self'");
  await page.route("http://127.0.0.1:4173/", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": csp! } });
  });
  // مسیر ماژول پویاست تا ساخت تصویر مستقل وب به فایل‌های API وابسته نشود.
  const labelModule = "../../api/src/catalog/label.ts";
  const { labelPage, LABEL_CSP } = await import(labelModule);
  api.handlers.set("POST /labels", async route => {
    expect(route.request().postDataJSON()).toEqual({ items: [{ variationId: "v1", count: 1 }], layout: "roll", rollWidthMm: 50, rollHeightMm: 30 });
    await route.fulfill({ contentType: "text/html", headers: { "content-security-policy": LABEL_CSP }, body: labelPage([{
      barcode: "2000000014012", sku: "TR-1405-NAVY-S", productName: "کالا <script>خطا</script>", brand: null,
      color: "سرمه‌ای", size: "S", priceRial: 1234000n, count: 1,
    }], { layout: "roll", shopName: "فروشگاه", rollMm: { width: 50, height: 30 } }) });
  });
  const panel = await openLabels(page, api);
  await panel.getByRole("textbox", { name: "تعداد لیبل TR-1405-NAVY-S" }).fill("1");
  await panel.getByRole("button", { name: "پیش‌نمایش لیبل‌های انتخاب‌شده" }).click();
  const iframe = page.locator('iframe[title="پیش‌نمایش چاپ بارکد"]');
  const label = iframe.contentFrame().locator(".label");
  await expect(label).toHaveCSS("display", "flex");
  await expect(label).toHaveCSS("border-radius", /7\.55/);
  await expect(iframe.contentFrame().locator(".price")).toContainText("123,400");
  await expect(iframe.contentFrame().locator("script")).toHaveCount(0);
  await expect(iframe).toHaveAttribute("sandbox", "allow-same-origin allow-modals");
  await expect(iframe).toHaveAttribute("src", "/api/labels/frame");
  await iframe.screenshot({ path: testInfo.outputPath("label-csp.png") });
  // تغییر DOM، CSP پاسخ قاب را حذف نمی‌کند؛ حتی اسکریپتِ ساخته‌شده از والد مسدود است.
  const executed = await iframe.evaluate(frame => {
    const doc = (frame as HTMLIFrameElement).contentDocument!;
    const script = doc.createElement("script");
    script.textContent = "document.documentElement.dataset.scriptExecuted = 'yes'";
    doc.body.append(script);
    script.remove();
    return doc.documentElement.dataset.scriptExecuted;
  });
  expect(executed).toBeUndefined();
  await page.emulateMedia({ media: "print" });
  const size = await label.boundingBox();
  expect(size!.width).toBeCloseTo(50 * 96 / 25.4, 0);
  expect(size!.height).toBeCloseTo(30 * 96 / 25.4, 0);
  await expect(label).toHaveCSS("box-shadow", "none");
  await expect(panel.getByRole("button", { name: "چاپ لیبل بارکد", exact: true })).toBeEnabled();
});

test("label printing waits for its frame and fails closed when the frame session expires", async ({ page, api }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  api.handlers.set("GET /labels/frame", async route => {
    await held;
    await route.fulfill({ status: 401, json: { error: { code: "no_session" } } });
  });
  api.handlers.set("POST /labels", async route => {
    await route.fulfill({ contentType: "text/html", body: "<html><body>LABELS</body></html>" });
  });
  const panel = await openLabels(page, api);
  await panel.getByRole("textbox", { name: "تعداد لیبل TR-1405-NAVY-S" }).fill("1");
  await panel.getByRole("button", { name: "پیش‌نمایش لیبل‌های انتخاب‌شده" }).click();
  const print = panel.getByRole("button", { name: "چاپ لیبل بارکد", exact: true });
  try {
    await expect.poll(() => api.calls.includes("GET /labels/frame")).toBe(true);
    await expect(print).toBeDisabled();
  } finally { release(); }
  await expect(panel.getByRole("alert")).toContainText("بارگذاری پیش‌نمایش چاپ ممکن نشد");
  await expect(print).toBeDisabled();
  api.handlers.delete("GET /labels/frame");
  await panel.getByRole("button", { name: "پیش‌نمایش لیبل‌های انتخاب‌شده" }).click();
  await expect(print).toBeEnabled();
  await expect(panel.getByRole("alert")).toHaveCount(0);
});

async function openLabels(page: Page, api: { defaults: Record<string, unknown> }) {
  api.defaults["GET /products/" + product.id] = { product, variations };
  api.defaults["GET /products/" + product.id + "/stock-matrix"] = { totalOnHand: "5", cells: {
    navy: { S: { variationId: "v1", onHand: "3", reserved: "0" } }, cream: { XL: { variationId: "v2", onHand: "2", reserved: "0" } } } };
  await openCatalog(page);
  await page.locator("main").getByRole("button", { name: "چاپ لیبل بارکد", exact: true }).click();
  await page.getByRole("button", { name: "انتخاب تنوع و چاپ لیبل", exact: true }).click();
  const panel = page.getByRole("region", { name: "موجودی و چاپ بارکد" });
  await expect(panel.getByText(/جمع موجودی/)).toContainText("5");
  return panel;
}

test("label size is one choice: the product panel's size reaches the bulk list, its request and a reload", async ({ page, api }) => {
  const bodies: unknown[] = [];
  api.handlers.set("POST /labels", async route => { bodies.push(route.request().postDataJSON()); await route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="fa"><body><p>LABELS</p></body></html>' }); });
  const panel = await openLabels(page, api);
  await panel.getByRole("combobox", { name: "اندازهٔ لیبل" }).selectOption("40x25");
  await panel.getByRole("textbox", { name: "تعداد لیبل TR-1405-NAVY-S" }).fill("۲");
  await panel.getByRole("button", { name: "افزودن به فهرست چاپ گروهی" }).click();
  const queue = page.getByRole("region", { name: "فهرست چاپ گروهی" });
  await expect(queue.getByRole("combobox", { name: "اندازهٔ لیبل" })).toHaveValue("40x25");
  await queue.getByRole("button", { name: /پیش‌نمایش .* لیبل/ }).click();
  await expect(page.frameLocator('iframe[title="پیش‌نمایش چاپ بارکد"]').getByText("LABELS")).toBeVisible();
  expect(bodies.at(-1)).toEqual({ items: [{ variationId: "v1", count: 2 }], layout: "roll", rollWidthMm: 40, rollHeightMm: 25 });
  // تغییر در فهرست هم به صفحهٔ کالا برمی‌گردد و پیش‌نمایش قدیمی را باطل می‌کند.
  await queue.getByRole("combobox", { name: "اندازهٔ لیبل" }).selectOption("58x40");
  await expect(panel.getByRole("combobox", { name: "اندازهٔ لیبل" })).toHaveValue("58x40");
  await expect(page.getByRole("button", { name: "چاپ لیبل بارکد", exact: true }).and(page.locator("iframe ~ button"))).toHaveCount(0);
  // رول همین دستگاه پس از Reload یادش می‌ماند.
  await page.reload();
  await expect(page.getByRole("region", { name: "فهرست چاپ گروهی" }).getByRole("combobox", { name: "اندازهٔ لیبل" })).toHaveValue("58x40");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("an unpriced variation is visible before printing: price column, badge and a pre-print warning in panel and bulk list", async ({ page, api }) => {
  api.handlers.set("POST /labels", async route => { await route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="fa"><body><p>LABELS</p></body></html>' }); });
  const panel = await openLabels(page, api);
  await expect(panel.getByRole("columnheader", { name: "تنوع · قیمت لیبل" })).toBeVisible();
  // قیمت ستون جدا نیست: از ۳۶۰px به بالا «تعداد لیبل» بی‌اسکرول داخل دید جدول می‌ماند.
  // (۳۲۰px پیش از این تغییر هم جدول را داخل خودش اسکرول می‌کرد — قاعدهٔ `.grid` موبایل.)
  if (page.viewportSize()!.width >= 360) {
    const count = panel.getByRole("textbox", { name: "تعداد لیبل TR-1405-NAVY-S" });
    const [box, wrap] = [await count.boundingBox(), await panel.locator(".grid-wrap").boundingBox()];
    expect(box!.x).toBeGreaterThanOrEqual(wrap!.x - 1);
  }
  await expect(panel.getByRole("row", { name: /سرمه‌ای/ })).toContainText("123٬400"); // پول با `Money`: رقم لاتین، همان قرارداد نظام طراحی
  await expect(panel.getByRole("row", { name: /کرم/ })).toContainText("بدون قیمت");
  await expect(panel.getByText(/قیمت ندارد/)).toHaveCount(0);
  await panel.getByRole("button", { name: "یکی از هر تنوع" }).click();
  const warning = panel.getByRole("status").filter({ hasText: "پیش از چاپ" });
  await expect(warning).toContainText("۱ تنوع انتخاب‌شده قیمت ندارد");
  // هشدار است نه قفل: سرور لیبل «بدون قیمت» را عمداً می‌سازد.
  await expect(panel.getByRole("button", { name: "پیش‌نمایش لیبل‌های انتخاب‌شده" })).toBeEnabled();
  await panel.getByRole("textbox", { name: "تعداد لیبل TR-1405-CREAM-XL" }).fill("0");
  await expect(warning).toHaveCount(0);
  await panel.getByRole("textbox", { name: "تعداد لیبل TR-1405-CREAM-XL" }).fill("1");
  await panel.getByRole("button", { name: "افزودن به فهرست چاپ گروهی" }).click();
  const queue = page.getByRole("region", { name: "فهرست چاپ گروهی" });
  await expect(queue.getByRole("listitem").filter({ hasText: "TR-1405-CREAM-XL" })).toContainText("بدون قیمت");
  await expect(queue.getByRole("status").filter({ hasText: "پیش از چاپ" })).toContainText("قیمت ندارد");
  await queue.getByRole("button", { name: "حذف TR-1405-CREAM-XL از فهرست" }).click();
  await expect(queue.getByRole("status").filter({ hasText: "پیش از چاپ" })).toHaveCount(0);
});

test("an impossible custom size is flagged at the size fields with Persian digits and blocks the preview", async ({ page, api }) => {
  let requests = 0;
  api.handlers.set("POST /labels", async route => { requests++; await route.fulfill({ contentType: "text/html", body: "<p>x</p>" }); });
  const panel = await openLabels(page, api);
  await panel.getByRole("combobox", { name: "اندازهٔ لیبل" }).selectOption("custom");
  const width = panel.getByRole("textbox", { name: "عرض لیبل (میلی‌متر)" });
  await width.fill("۲۵");
  // پیش از انتخاب هر تنوعی هم دیده می‌شود، کنار خودِ میدان.
  await expect(width).toHaveAttribute("aria-invalid", "true");
  const error = page.locator("#" + (await width.getAttribute("aria-describedby")));
  await expect(error).toContainText("عرض لیبل باید بین ۳۰ و ۱۲۰ میلی‌متر باشد");
  expect(await error.innerText()).not.toMatch(/[0-9]/);
  // فقط بُعد نامعتبر: ارتفاعِ درست، نادرست اعلام نمی‌شود.
  await expect(panel.getByRole("textbox", { name: "ارتفاع لیبل (میلی‌متر)" })).not.toHaveAttribute("aria-invalid", "true");
  await panel.getByRole("textbox", { name: "تعداد لیبل TR-1405-NAVY-S" }).fill("1");
  await expect(panel.getByRole("button", { name: "پیش‌نمایش لیبل‌های انتخاب‌شده" })).toBeDisabled();
  // همان پیام یک بار، نه یک بار کنار میدان و یک بار زیر دکمه‌ها.
  await expect(panel.getByText(/عرض لیبل باید بین/)).toHaveCount(1);
  await width.fill("45");
  await expect(width).not.toHaveAttribute("aria-invalid", "true");
  await expect(panel.getByRole("button", { name: "پیش‌نمایش لیبل‌های انتخاب‌شده" })).toBeEnabled();
  expect(requests).toBe(0);
});
