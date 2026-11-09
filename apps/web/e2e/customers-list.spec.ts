/**
 * WP4 دستهٔ ۶ — فهرست مشتریان مثل طرح ۱۰.
 *
 * ستون‌ها: مشتری (موبایل پوشیده زیر نام)، از، ماندهٔ دفتر (طلب)، اعتبار نزد ما، پیامک بازاریابی، و سطر جمع.
 * طلب و اعتبار از سرور و جدا؛ صفر «—»؛ ستون نیامده «نامعلوم»، نه صفر؛ جمع از پاسخ سرور، نه جمع مرورگر.
 * «اثر ثبت‌نشدهٔ امروز» V10 تعریف مالی تازه است و تا تصمیم مالک ساخته نمی‌شود.
 */
import { test, expect, customer } from "./fixtures";
import type { Customer } from "../src/lib/people";

const row = (id: string, over: Partial<Customer>): Customer => ({ ...customer, id, ...over });
const ROWS: Customer[] = [
  row("c1", { fullName: "سارا احمدی", mobile: "09121234821", createdAt: "2025-01-21T08:00:00Z", consentMarketing: true, ledgerOwed: "21500000", ledgerCredit: "0", ledgerUnposted: "-10000000" }),
  row("c2", { fullName: "علی رضایی", mobile: "09351237777", createdAt: "2025-06-08T08:00:00Z", consentMarketing: false, ledgerOwed: "0", ledgerCredit: "3200000", ledgerUnposted: "0" }),
  row("c3", { fullName: "مریم توکلی", mobile: "09121235566", createdAt: "2025-11-28T08:00:00Z", consentMarketing: true, ledgerOwed: "0", ledgerCredit: "0", ledgerUnposted: "17700000", status: "blocked" }),
];

test.describe("فهرست مشتریان (طرح ۱۰)", () => {
  test("receivable and credit apart from the server, masked mobile, total row from the server", async ({ page, api }) => {
    // جمع عمداً با جمع ردیف‌ها فرق دارد: صفحه باید عدد سرور را نشان دهد، نه جمع خودش را.
    api.defaults["GET /customers"] = { customers: ROWS, totals: { owed: "99900000", credit: "3200000", unposted: "7700000" } };
    await page.goto("/?page=customers");
    const table = page.getByRole("table", { name: "فهرست مشتریان؛ مبلغ‌ها به تومان" });
    await expect(table).toBeVisible();
    expect((await table.locator("thead th").allInnerTexts()).map(h => h.trim()))
      .toEqual(["مشتری", "از", "ماندهٔ دفتر (طلب)", "اعتبار نزد ما", "ثبت‌نشده (موقت)", "پیامک بازاریابی", "کنش‌ها"]);
    const cells = (name: string) => table.locator("tbody tr").filter({ hasText: name }).locator("td");

    const sara = cells("سارا احمدی");
    await expect(sara.nth(0)).toContainText("0912 *** 4821");
    await expect(sara.nth(0)).not.toContainText("09121234821");
    await expect(sara.nth(2)).toContainText("2٬150٬000");
    await expect(sara.nth(3)).toHaveText("—");
    await expect(sara.nth(4)).toContainText("−1٬000٬000");
    await expect(sara.nth(5)).toContainText("رضایت دارد");

    const ali = cells("علی رضایی");
    await expect(ali.nth(2)).toHaveText("—");
    await expect(ali.nth(3)).toContainText("320٬000");
    await expect(ali.nth(3)).not.toContainText("−");
    await expect(ali.nth(4)).toHaveText("—");
    await expect(ali.nth(5)).toContainText("بدون رضایت");

    await expect(cells("مریم توکلی").nth(0)).toContainText("مسدود");
    await expect(cells("مریم توکلی").nth(4)).toContainText("+");
    await expect(cells("مریم توکلی").nth(4)).toContainText("1٬770٬000");

    const foot = table.locator("tfoot tr");
    await expect(foot).toContainText("جمع");
    await expect(foot).toContainText("9٬990٬000");
    await expect(foot).toContainText("320٬000");
    await expect(foot).toContainText("770٬000");
    // یادداشت درست: دریافت نسیهٔ قبلی از خزانه در «وجه دریافتی» داشبورد نیست (اصلاح ۲۰۲۶/۱۱/۰۷).
    await expect(page.getByText("در «وجه دریافتی» داشبورد نیست", { exact: false })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });

  test("an older response without ledger columns or totals shows unknown, never zero", async ({ page, api }) => {
    api.defaults["GET /customers"] = { customers: [customer] };
    await page.goto("/?page=customers");
    const table = page.getByRole("table", { name: "فهرست مشتریان؛ مبلغ‌ها به تومان" });
    const tds = table.locator("tbody tr").first().locator("td");
    await expect(tds.nth(2)).toContainText("نامعلوم");
    await expect(tds.nth(3)).toContainText("نامعلوم");
    await expect(tds.nth(4)).toContainText("نامعلوم");
    await expect(table.locator("tfoot")).toHaveCount(0);
  });

  test("the row action still opens the customer file", async ({ page, api }) => {
    api.defaults["GET /customers"] = { customers: ROWS, totals: { owed: "21500000", credit: "3200000" } };
    api.defaults["GET /customers/c1"] = { customer: ROWS[0], invoices: [] };
    // پرونده اندازه‌های مشتری را هم می‌خواند؛ پاسخ ماک شده تا آزمون پیش از رسیدنشان تمام نشود.
    api.defaults["GET /measure-keys"] = { keys: [] };
    api.defaults["GET /customers/c1/measures"] = { measures: [] };
    await page.goto("/?page=customers");
    await page.getByRole("table", { name: "فهرست مشتریان؛ مبلغ‌ها به تومان" }).locator("tbody tr").first().getByRole("button", { name: "پرونده" }).click();
    await expect(page.getByRole("heading", { name: /سارا احمدی/ }).last()).toBeVisible();
    await expect.poll(() => api.calls).toContain("GET /customers/c1/measures");
    expect(api.calls).toContain("GET /customers/c1");
  });

  test("the third card shows the unposted effect from the server; an older response without it shows no third card", async ({ page, api }) => {
    const { opsBody } = await import("./fixtures");
    api.defaults["GET /dashboard/operations"] = opsBody({ receivables: { state: "ready", owed: { count: 4, amount: "55500000" },
      credit: { count: 1, amount: "3200000" }, unposted: { count: 2, amount: "7700000" } } });
    await page.goto("/?page=customers");
    const row = page.getByRole("region", { name: "طلب و اعتبار مشتریان" });
    await expect(row.getByRole("region", { name: "اثر ثبت‌نشده" })).toContainText("770٬000");
    await expect(row.getByRole("region", { name: "اثر ثبت‌نشده" })).toContainText("پس از بستن دوره به طلب می‌رود");
    api.defaults["GET /dashboard/operations"] = opsBody({ receivables: { state: "ready", owed: { count: 4, amount: "55500000" }, credit: { count: 1, amount: "3200000" } } });
    await page.reload();
    await expect(row.getByRole("region", { name: "طلب از مشتریان" })).toBeVisible();
    await expect(row.getByRole("region", { name: "اثر ثبت‌نشده" })).toHaveCount(0);
  });

  test("no credit sales: the unposted column and card hide only when the server confirms zero", async ({ page, api }) => {
    const { opsBody } = await import("./fixtures");
    const zero = ROWS.map((r) => ({ ...r, ledgerUnposted: "0" }));
    api.defaults["GET /customers"] = { customers: zero, totals: { owed: "21500000", credit: "3200000", unposted: "0" } };
    api.defaults["GET /dashboard/operations"] = opsBody({ receivables: { state: "ready", owed: { count: 1, amount: "21500000" },
      credit: { count: 1, amount: "3200000" }, unposted: { count: 0, amount: "0" } } });
    await page.goto("/?page=customers");
    const table = page.getByRole("table", { name: "فهرست مشتریان؛ مبلغ‌ها به تومان" });
    await expect(table.locator("tbody tr").first()).toBeVisible();
    expect((await table.locator("thead th").allInnerTexts()).map(h => h.trim())).not.toContain("ثبت‌نشده (موقت)");
    await expect(page.getByRole("region", { name: "طلب از مشتریان" })).toBeVisible();
    await expect(page.getByRole("region", { name: "اثر ثبت‌نشده" })).toHaveCount(0);

    // مثبت و منفی جمع را صفر می‌کنند: ستون می‌ماند، چون ردیف‌ها صفر نیستند.
    api.defaults["GET /customers"] = { customers: [{ ...zero[0]!, ledgerUnposted: "500000" }, { ...zero[1]!, ledgerUnposted: "-500000" }],
      totals: { owed: "21500000", credit: "3200000", unposted: "0" } };
    await page.reload();
    await expect(table.locator("tbody tr").first()).toBeVisible();
    expect((await table.locator("thead th").allInnerTexts()).map(h => h.trim())).toContain("ثبت‌نشده (موقت)");

    // ردیف بی‌مقدار (پاسخ قدیمی‌تر): ستون می‌ماند و «نامعلوم» نشان می‌دهد، نه صفر.
    api.defaults["GET /customers"] = { customers: [{ ...zero[0]!, ledgerUnposted: undefined }], totals: { owed: "21500000", credit: "3200000", unposted: "0" } };
    await page.reload();
    await expect(table.locator("tbody tr").first().locator("td").nth(4)).toContainText("نامعلوم");
  });
});
