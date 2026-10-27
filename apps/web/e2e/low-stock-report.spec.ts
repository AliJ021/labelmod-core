/**
 * گزارش «کمبود موجودی» (R04، مهاجرت ۱۰۴): همان فهرستی که کارت داشبورد می‌شمارد. شمار کل و سطرهای هر صفحه
 * از یک snapshot سرورند؛ فهرست بیش از یک صفحه (حتی در یک انبار) صفحه‌به‌صفحه دسترس‌پذیر است و CSV کامل است.
 * آستانهٔ نامعلوم «نامعلوم» است، نه «کمبودی نیست»، و CSV نمی‌گیرد.
 */
import { test, expect, type MockApi } from "./fixtures";

const calls = (api: MockApi) => api.calls.filter(c => c.startsWith("GET /reports/low-stock"));
const row = (sku: string, available: string, warehouse = "انبار آزمایشی") => ({
  warehouseId: "w1", warehouseName: warehouse, variationId: `v-${sku}`, productId: "p1", sku,
  productName: "شلوار جین", color: "آبی", size: "M", onHand: available, reserved: "0.000", available,
});

test.describe("گزارش کمبود موجودی", () => {
  test("the dashboard link opens the same list for the branch: exact total, lowest first, CSV with the same scope", async ({ page, api }) => {
    api.defaults["GET /reports/low-stock"] = { threshold: "2", total: 2, page: 1, pageSize: 2000, pages: 1, truncated: false, rows: [row("LM-0", "0.000"), row("LM-1", "1.000")] };
    await page.goto("/?page=reports&reports.tab=lowstock&reports.branch=b1");
    const table = page.getByRole("table", { name: "کمبود موجودی" });
    await expect(table).toContainText("LM-0");
    expect(calls(api)).toEqual(["GET /reports/low-stock?branchId=b1"]);
    await expect(page.getByRole("tab", { name: "کمبود موجودی" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("status").filter({ hasText: "۲ مورد" })).toBeVisible();
    await expect(page.getByText(/به آستانهٔ 2 یا کمتر رسیده؛ ناموجود هم/)).toBeVisible();
    for (const header of ["موجودی فیزیکی", "رزروشده", "قابل‌فروش"]) {
      await expect(table.getByRole("columnheader", { name: header, exact: true })).toBeAttached();
    }
    await expect(table.getByRole("columnheader", { name: /بها|ارزش/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "دانلود CSV" })).toHaveAttribute("href", "/api/reports/low-stock?branchId=b1&format=csv");

    await page.getByLabel("انبار فروش", { exact: true }).selectOption("w1");
    await expect.poll(() => calls(api).at(-1)).toBe("GET /reports/low-stock?branchId=b1&warehouseId=w1");
    await expect(page.getByRole("link", { name: "دانلود CSV" })).toHaveAttribute("href", "/api/reports/low-stock?branchId=b1&warehouseId=w1&format=csv");
  });

  test("more than one page in one warehouse is reachable page by page; the CSV is the complete scope", async ({ page, api }) => {
    api.handlers.set("GET /reports/low-stock", async (route, url) => {
      const p = Number(url.searchParams.get("page") ?? "1");
      await route.fulfill({ json: { threshold: "2", total: 2500, page: p, pageSize: 2000, pages: 2, truncated: true,
        rows: [row(p === 1 ? "LM-P1" : "LM-P2", "0.000")] } });
    });
    await page.goto("/?page=reports&reports.tab=lowstock&reports.branch=b1&reports.warehouse=w1");
    const status = page.getByRole("status").filter({ hasText: "۲٬۵۰۰ مورد" });
    await expect(status).toContainText("صفحهٔ ۱ از ۲");
    await expect(status).toContainText("CSV همهٔ موارد همین دامنه را دارد");
    await expect(page.getByRole("table", { name: "کمبود موجودی" })).toContainText("LM-P1");
    await expect(page.getByRole("button", { name: "صفحهٔ قبل" })).toBeDisabled();
    await page.getByRole("button", { name: "صفحهٔ بعد" }).click();
    await expect(page.getByRole("table", { name: "کمبود موجودی" })).toContainText("LM-P2");
    expect(calls(api).at(-1)).toBe("GET /reports/low-stock?branchId=b1&warehouseId=w1&page=2");
    await expect(page).toHaveURL(/reports\.page=2/);
    await expect(page.getByRole("button", { name: "صفحهٔ بعد" })).toBeDisabled();
    await expect(page.getByRole("link", { name: "دانلود CSV" })).toHaveAttribute("href", "/api/reports/low-stock?branchId=b1&warehouseId=w1&format=csv");
    // تغییر انبار به صفحهٔ نخست برمی‌گرداند.
    await page.getByLabel("انبار فروش", { exact: true }).selectOption("");
    await expect.poll(() => calls(api).at(-1)).toBe("GET /reports/low-stock?branchId=b1");
  });

  test("rows the server returned are never hidden behind a zero total", async ({ page, api }) => {
    api.defaults["GET /reports/low-stock"] = { threshold: "2", total: 0, page: 1, pageSize: 2000, pages: 1, truncated: false, rows: [row("LM-RACE", "0.000")] };
    await page.goto("/?page=reports&reports.tab=lowstock&reports.branch=b1");
    await expect(page.getByRole("table", { name: "کمبود موجودی" })).toContainText("LM-RACE");
    await expect(page.getByText(/موردی به آستانهٔ/)).toHaveCount(0);
  });

  test("no threshold is unknown — not “nothing low” — and offers no CSV; zero is a calm empty state", async ({ page, api }) => {
    api.defaults["GET /reports/low-stock"] = { threshold: null, total: null, page: 1, pageSize: 2000, pages: 0, truncated: false, rows: [] };
    await page.goto("/?page=reports&reports.tab=lowstock&reports.branch=b1");
    await expect(page.getByText("آستانهٔ کمبود موجودی تعریف نشده است.")).toBeVisible();
    await expect(page.getByText(/این به معنای «کمبودی نیست» نیست/)).toBeVisible();
    await expect(page.getByRole("link", { name: "دانلود CSV" })).toHaveCount(0);

    api.defaults["GET /reports/low-stock"] = { threshold: "2", total: 0, page: 1, pageSize: 2000, pages: 1, truncated: false, rows: [] };
    await page.reload();
    await expect(page.getByText("موردی به آستانهٔ 2 یا کمتر نرسیده.")).toBeVisible();
    await expect(page.getByRole("link", { name: "دانلود CSV" })).toHaveCount(0);
  });
});
