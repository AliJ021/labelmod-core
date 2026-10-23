/**
 * «سفارش‌های سایت» در مرورگر — API ماک.
 * - فهرست و جزئیات فقط‌خواندنی‌اند.
 * - «نامعلوم» با دلیل نشان داده می‌شود، نه فهرست خالی.
 * - صفحه‌بندی لنگر زمانی دارد و از صفحهٔ ۲۰۰ به بعد هم می‌رود.
 * - عبارت جست‌وجو نه در نشانی صفحه است و نه در نشانی درخواست: فقط در بدنهٔ `POST /web/orders/search`.
 * - مبلغ دلاری با کد خودش نشان داده می‌شود، نه به‌عنوان ریال.
 * - بی مجوز `web.orders.view` نه منو دیده می‌شود و نه درخواستی می‌رود.
 * - درخواست‌ها دقیق شمرده می‌شوند. هیچ sleep در کار نیست.
 */
import { test, expect, type MockApi } from "./fixtures";
import type { Page } from "@playwright/test";

const UNTIL = 1792000000;
const core = { paymentConfirmed: true, recorded: false, invoiceNumber: null, attempts: 2, hasError: true, stopped: false };
const m = (amount: string | null, rial: string | null = amount) => ({ amount, rial });
const order = {
  id: 41, number: "41", status: "awaiting-shipment", statusLabel: "منتظر ارسال", createdAt: "2026-09-16T08:00:00.000Z",
  currency: "IRR", total: m("12000000"), itemCount: 2, customerName: "مشتری سایت", customerType: "guest",
  paymentMethodId: "zarinpal", paymentMethod: "زرین‌پال", core,
};
const page1 = { state: "ready", page: 1, perPage: 20, until: UNTIL, total: 4500, pages: 225,
  statuses: [{ slug: "processing", label: "در حال انجام" }, { slug: "awaiting-shipment", label: "منتظر ارسال" }],
  paymentMethods: [{ id: "zarinpal", title: "زرین‌پال" }, { id: "bacs", title: "انتقال بانکی" }],
  shippingMethods: [{ id: "flat_rate", title: "نرخ ثابت" }, { id: "local_pickup", title: "تحویل حضوری" }],
  orders: [order, { ...order, id: 42, number: "42", currency: "USD", total: m("19.99", null), customerName: "مشتری دلاری" }],
  fetchedAt: "2026-09-16T09:00:00.000Z" };
const addr = { firstName: "سارا", lastName: "رضایی", company: "", address1: "خیابان ولیعصر ۱۰", address2: "", city: "تهران",
  state: "THR", postcode: "1234567890", country: "IR", phone: "09121234567" };
const item = (id: number, name: string) => ({ id, name, sku: `SH-${id}`, quantity: 1, attributes: [{ key: "رنگ", value: "سفید" }],
  subtotal: m("5000000"), subtotalTax: m("0"), total: m("4000000"), tax: m("0"), discount: m("1000000"), productExists: true, mapped: id !== 2 });
const detail = (itemsPage: number, notesPage: number) => ({ state: "ready", fetchedAt: "2026-09-16T09:00:00.000Z", order: { ...order,
  core: { ...core, queue: { scheduler: "action-scheduler", state: "deferred", deferred: "send", dead: false }, missingSku: 0, missingMapping: 1 },
  billing: { ...addr, email: "sara@example.test" }, shipping: addr, customerNote: "زنگ نزنید",
  completedAt: null, modifiedAt: "2026-09-16T08:30:00.000Z",
  tracking: [{ provider: "iran-post", number: "IR123456789", shippedAt: "2026-09-16T10:00:00.000Z", url: "https://tracking.example.invalid/IR123456789" }],
  payment: { methodId: "zarinpal", method: "زرین‌پال", transactionId: "A1B2C3", paidAt: "2026-09-16T08:01:00.000Z" },
  totals: { subtotal: m("12500000"), discount: m("1000000"), discountTax: m("0"), shipping: m("500000"), shippingTax: m("0"),
    tax: m("0"), total: m("12000000"), refunded: m("0") },
  items: { page: itemsPage, perPage: 25, total: 30, rows: itemsPage === 1 ? [item(1, "پیراهن کتان سفید"), item(2, "شلوار")] : [item(26, "کمربند")] },
  fees: [], shippingLines: [{ method: "پیک", total: m("500000"), tax: m("0") }],
  coupons: [{ code: "off10", discount: m("1000000"), discountTax: m("0") }], refunds: [], refundsTruncated: false,
  notes: { page: notesPage, perPage: 20, hasMore: notesPage === 1,
    rows: [{ id: notesPage, createdAt: "2026-09-16T08:02:00.000Z", content: notesPage === 1 ? "پرداخت تأیید شد" : "سفارش ساخته شد",
      customerNote: false, addedBy: "system" }] } } });
const calls = (api: MockApi) => api.calls.filter(c => / \/web\/orders/.test(c));
const list = (page: Page) => page.getByRole("region", { name: "فهرست سفارش‌ها" });

test.describe("سفارش‌های سایت", () => {
  test("list and detail are read-only, exact amounts, custom status, Core sync state; detail shows full order with paged items and notes", async ({ page, api }) => {
    api.handlers.set("GET /web/orders", async route => { await route.fulfill({ json: page1 }); });
    api.handlers.set("GET /web/orders/41", async (route, url) => {
      await route.fulfill({ json: detail(Number(url.searchParams.get("items") ?? 1), Number(url.searchParams.get("notes") ?? 1)) });
    });
    await page.goto("/?page=site-orders");
    const row = list(page).getByRole("row").filter({ hasText: "مشتری سایت" });
    await expect(row).toContainText("1٬200٬000");
    await expect(row).toContainText("خطا در ارسال به Core (2 تلاش)");
    await expect(row).toContainText("منتظر ارسال");
    // دلار ریال نمی‌شود: همان عدد سایت با کد ارز.
    const usd = list(page).getByRole("row").filter({ hasText: "مشتری دلاری" });
    await expect(usd).toContainText("19.99 USD");
    await expect(usd).not.toContainText("تومان");
    expect(calls(api)).toEqual(["GET /web/orders?page=1"]);

    await row.getByRole("button", { name: "جزئیات سفارش 41" }).click();
    const panel = page.getByRole("region", { name: "سفارش #41", exact: true });
    const shirt = panel.getByRole("row").filter({ hasText: "پیراهن کتان سفید" });
    await expect(shirt).toContainText("رنگ: سفید");
    await expect(shirt).toContainText("100٬000");
    await expect(panel.getByRole("row").filter({ hasText: "شلوار" })).toContainText("بی اتصال");
    await expect(panel.getByRole("region", { name: "نشانی صورت‌حساب" })).toContainText("sara@example.test");
    await expect(panel.getByRole("region", { name: "نشانی ارسال" })).toContainText("خیابان ولیعصر ۱۰");
    await expect(panel).toContainText("A1B2C3");
    // تصمیم معوق ماندگار (بازبینی ریشه روی 4b0046a): «در صف»، نه «خیر».
    const queue = panel.getByRole("region", { name: "ثبت در Core" }).locator(".site-order-facts div").filter({ hasText: "صف ارسال" });
    await expect(queue).toContainText("در صف ماندگار؛ منتظر ثبت در زمان‌بند");
    await expect(queue).not.toContainText("خیر");
    await expect(panel.getByRole("region", { name: "کوپن‌ها" })).toContainText("off10");
    await expect(panel.getByRole("link", { name: "IR123456789" })).toHaveAttribute("href", "https://tracking.example.invalid/IR123456789");
    await expect(panel.locator(".site-order-facts div").filter({ hasText: "زمان تکمیل" })).toContainText("تکمیل نشده");
    await expect(panel.getByRole("region", { name: "یادداشت‌های سفارش" })).toContainText("پرداخت تأیید شد");
    await expect(page).toHaveURL(/site-orders\.order=41/);

    await panel.getByRole("button", { name: "اقلام بعدی" }).click();
    await expect(panel.getByRole("row").filter({ hasText: "کمربند" })).toBeVisible();
    await panel.getByRole("button", { name: "یادداشت‌های قدیمی‌تر" }).click();
    await expect(panel.getByRole("region", { name: "یادداشت‌های سفارش" })).toContainText("سفارش ساخته شد");
    expect(calls(api)).toEqual(["GET /web/orders?page=1", "GET /web/orders/41", "GET /web/orders/41?items=2",
      "GET /web/orders/41?items=2&notes=2"]);
    // هیچ کنشی سفارش را تغییر نمی‌دهد: فقط خواندن، جست‌وجو، بستن و رفتن بین صفحه‌ها.
    const labels = await page.locator("main").getByRole("button").allInnerTexts();
    expect(labels.filter(l => !/به‌روزرسانی|جزئیات|بستن|تلاش دوباره|صفحهٔ|بازنشانی|جست‌وجو|برو|اقلام|یادداشت‌های|فیلتر/.test(l))).toEqual([]);
  });

  test("stable paging past page 200 keeps the anchor; filters reset it; search goes only in a POST body", async ({ page, api }) => {
    api.handlers.set("GET /web/orders", async (route, url) => {
      const p = Number(url.searchParams.get("page"));
      await route.fulfill({ json: { ...page1, page: p, orders: [{ ...order, id: 1000 + p, number: String(1000 + p) }] } });
    });
    const searches: unknown[] = [];
    api.handlers.set("POST /web/orders/search", async route => {
      searches.push(route.request().postDataJSON());
      await route.fulfill({ json: { ...page1, orders: [{ ...order, id: 77, number: "77" }] } });
    });
    await page.goto("/?page=site-orders");
    await expect(list(page)).toContainText("#1001");
    await list(page).getByLabel("رفتن به صفحه").fill("۲۰۱");
    await list(page).getByRole("button", { name: "برو" }).click();
    await expect(list(page)).toContainText("#1201");
    await expect(page).toHaveURL(/site-orders\.page=201/);
    await expect(page).toHaveURL(new RegExp(`site-orders\\.until=${UNTIL}`));
    await list(page).getByRole("button", { name: "صفحهٔ بعد" }).click();
    await expect(list(page)).toContainText("#1202");
    expect(calls(api)).toEqual(["GET /web/orders?page=1", `GET /web/orders?page=201&until=${UNTIL}`, `GET /web/orders?page=202&until=${UNTIL}`]);

    await page.getByLabel("وضعیت سفارش").selectOption("awaiting-shipment");
    await expect.poll(() => calls(api).at(-1)).toBe("GET /web/orders?page=1&status=awaiting-shipment");
    await expect(page).not.toHaveURL(/site-orders\.until=/);

    await page.getByLabel("روش ارسال").selectOption("local_pickup");
    await expect.poll(() => calls(api).at(-1)).toBe("GET /web/orders?page=1&status=awaiting-shipment&shipping=local_pickup");

    await page.getByRole("searchbox", { name: "جست‌وجو" }).fill("09121234567");
    await page.getByRole("searchbox", { name: "جست‌وجو" }).press("Enter");
    await expect(list(page)).toContainText("#77");
    expect(calls(api).at(-1)).toBe("POST /web/orders/search");
    expect(searches).toEqual([{ page: 1, status: "awaiting-shipment", shipping: "local_pickup", q: "09121234567" }]);
    expect(page.url()).not.toContain("0912");
    expect(calls(api).filter(c => c.includes("0912"))).toEqual([]);
  });

  test("an unreliable site answer is “unknown” with its reason — never an empty list", async ({ page, api }) => {
    api.handlers.set("GET /web/orders", async route => {
      await route.fulfill({ json: { state: "unavailable", code: "scope_mismatch", message: "شعبه یا انبار افزونه با انبار سایت در Core یکسان نیست.", fetchedAt: "2026-09-16T09:00:00.000Z" } });
    });
    await page.goto("/?page=site-orders");
    await expect(list(page)).toContainText("شعبه یا انبار افزونه با انبار سایت در Core یکسان نیست.");
    await expect(list(page)).toContainText("scope_mismatch");
    await expect(list(page)).toContainText("این به معنای «سفارشی نیست» نیست");
    await expect(list(page)).not.toContainText("در این صفحه سفارشی نیست");
    await expect(list(page).getByRole("table")).toHaveCount(0);
  });

  test("without web.orders.view the menu entry is hidden and nothing is requested", async ({ page, api }) => {
    api.handlers.set("GET /auth/can", async (route, url) => {
      await route.fulfill({ json: { verdict: url.searchParams.get("operation") === "web.orders.view" ? "deny" : "allow", approver: null, reason: "" } });
    });
    await page.goto("/");
    // کنترل منفی معنادار: «مرجوعی» در همان رندرِ پس از دسترسی ظاهر می‌شود که این مقصد می‌شد.
    await expect(page.getByRole("tab", { name: "مرجوعی", includeHidden: true }).first()).toBeAttached();
    await expect(page.getByRole("tab", { name: "سفارش‌های سایت", includeHidden: true })).toHaveCount(0);
    expect(calls(api)).toEqual([]);
  });
});
