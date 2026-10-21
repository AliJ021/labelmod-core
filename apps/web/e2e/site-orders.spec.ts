/**
 * «سفارش‌های سایت» در مرورگر — API ماک.
 * - فهرست و جزئیات فقط‌خواندنی‌اند.
 * - «نامعلوم» با دلیل نشان داده می‌شود، نه فهرست خالی.
 * - بی مجوز `web.orders.view` نه منو دیده می‌شود و نه درخواستی می‌رود.
 * - درخواست‌ها دقیق شمرده می‌شوند. هیچ sleep در کار نیست.
 */
import { test, expect, type MockApi } from "./fixtures";
import type { Page } from "@playwright/test";

const order = {
  id: 41, number: "41", status: "processing", createdAt: "2026-09-16T08:00:00.000Z", totalRial: "12000000", itemCount: 2,
  customerName: "مشتری سایت", paymentMethod: "زرین‌پال",
  core: { paymentConfirmed: true, recorded: false, invoiceNumber: null, attempts: 2, hasError: true, stopped: false },
};
const page1 = { state: "ready", page: 1, perPage: 20, status: null, total: 1, pages: 1, orders: [order], fetchedAt: "2026-09-16T09:00:00.000Z" };
const detail = { state: "ready", fetchedAt: "2026-09-16T09:00:00.000Z", order: { ...order,
  items: [{ name: "پیراهن کتان سفید", sku: "SH-01", quantity: 2, totalRial: "8000000" }], itemsTruncated: false,
  shippingRial: "500000", discountRial: null } };
const calls = (api: MockApi) => api.calls.filter(c => c.startsWith("GET /web/orders"));
const list = (page: Page) => page.getByRole("region", { name: "فهرست سفارش‌ها" });

test.describe("سفارش‌های سایت", () => {
  test("list and detail are read-only, exact amounts, Core sync state named; filter and selection live in the URL", async ({ page, api }) => {
    api.handlers.set("GET /web/orders", async (route, url) => {
      await route.fulfill({ json: { ...page1, status: url.searchParams.get("status") } });
    });
    api.handlers.set("GET /web/orders/41", async route => { await route.fulfill({ json: detail }); });
    await page.goto("/?page=site-orders");
    const row = list(page).getByRole("row").filter({ hasText: "مشتری سایت" });
    await expect(row).toContainText("1٬200٬000");
    await expect(row).toContainText("خطا در ارسال به Core (2 تلاش)");
    await expect(row).toContainText("در حال انجام");
    expect(calls(api)).toEqual(["GET /web/orders?page=1"]);

    await row.getByRole("button", { name: "جزئیات سفارش 41" }).click();
    const panel = page.getByRole("region", { name: "سفارش #41", exact: true });
    await expect(panel.getByRole("row").filter({ hasText: "پیراهن کتان سفید" })).toContainText("800٬000");
    await expect(panel).toContainText("50٬000");
    await expect(panel.locator(".site-order-facts div").filter({ hasText: "تخفیف" })).toContainText("نامعلوم");
    await expect(page).toHaveURL(/site-orders\.order=41/);
    expect(calls(api)).toEqual(["GET /web/orders?page=1", "GET /web/orders/41"]);
    // هیچ کنشی سفارش را تغییر نمی‌دهد: فقط خواندن، بستن و رفتن بین صفحه‌ها.
    const labels = await page.locator("main").getByRole("button").allInnerTexts();
    expect(labels.filter(l => !/به‌روزرسانی|جزئیات|بستن|تلاش دوباره|صفحهٔ|بازنشانی/.test(l))).toEqual([]);

    await page.getByLabel("وضعیت سفارش").selectOption("processing");
    await expect(page).toHaveURL(/site-orders\.status=processing/);
    await expect(page.getByRole("region", { name: "سفارش #41", exact: true })).toHaveCount(0);
    await expect.poll(() => calls(api).at(-1)).toBe("GET /web/orders?page=1&status=processing");
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
