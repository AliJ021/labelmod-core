import { test as base, expect, type Page, type Route } from "@playwright/test";
import type { Product, Variation } from "../src/lib/catalog";
import type { AppUser, Customer } from "../src/lib/people";
import type { Me } from "../src/lib/session";
import type { Branch, DailyReport } from "../src/lib/pos";
import type { PermissionRule } from "../src/lib/admin";

export const product: Product = { id: "11111111-1111-4111-8111-111111111111", code: "TR-1405", nameInternal: "شلوار پارچه‌ای رگولار با نام طولانی برای بررسی چیدمان", nameWeb: null, brandId: null, brandName: null, categoryId: null, categoryName: null, season: null, collection: null, fabric: null, fit: null, originCountry: null, taxRateCode: "standard", notes: null, status: "active", variationCount: 1, pricedCount: 1 };
const variation: Variation = { id: "v1", color: "سرمه‌ای", size: "XL", sku: "TR-1405-NAVY-XL", barcode: "1234567890123", status: "active", price: "1234000", priceKind: "regular", priceSince: "2026-09-16T00:00:00Z", locked: false };
const me: Me = { id: "22222222-2222-4222-8222-222222222222", fullName: "مدیر آزمایشی", roles: ["admin"], expiresAt: "2027-01-01T00:00:00Z", elevated: true, enrollmentRequired: false, device: null };
const branches: Branch[] = [{ id: "b1", code: "TEST", name: "شعبه آزمایشی", warehouses: [{ id: "w1", code: "STORE", name: "انبار آزمایشی", kind: "store" }] }];
const daily: DailyReport = { businessDate: "2026-09-16", salesAmount: "12340000", receivedAmount: "11000000", profitAmount: "2340000", invoiceCount: 12, returnCount: 1 };
export const staff: AppUser = { id: "33333333-3333-4333-8333-333333333333", username: "synthetic_staff", fullName: "پرسنل آزمایشی", mobile: null, isActive: true, createdAt: "2026-01-01T00:00:00Z", hasPin: false, hasTotp: false, roles: [{ roleCode: "cashier", roleName: "صندوق‌دار", branchId: null, branchName: null }], activeSessions: 1 };
export const customer: Customer = { id: "c1", mobile: "09000000000", fullName: "مشتری آزمایشی با نام بلند برای بررسی چیدمان جدول", email: null, status: "active", creditLimit: "0", dueDays: 0, consentSms: false, consentMarketing: false, address: null, postalCode: null, city: null, province: null, tags: [], internalNote: null, createdAt: "2026-01-01T00:00:00Z", invoiceCount: 2, totalPurchased: "9876000", balance: "1234000" };
export const rule: PermissionRule = { roleCode: "admin", roleName: "مدیر", operation: "price.change", allowed: true, maxAmount: null, maxPercent: null, needsApprovalFrom: null, hasRule: true };

type Handler = (route: Route, url: URL) => Promise<void>;
export class MockApi {
  handlers = new Map<string, Handler>();
  calls: string[] = [];
  unexpected: string[] = [];
  errors: string[] = [];
  external: string[] = [];
  fonts: string[] = [];
  productRows = [product];
  permissionRows = [rule];
  defaults: Record<string, unknown> = {
    "GET /auth/me": me, "GET /branches": { branches }, "GET /reports/daily": daily,
    "GET /posting-batches/unposted": { rows: [] }, "GET /auth/can": { verdict: "allow", approver: null, reason: "" },
    "GET /settings": { groups: [] }, "GET /settlement-terms": { terms: [] }, "GET /customers": { customers: [] },
    "GET /products/ref-data": { brands: [], categories: [] }, "GET /seasons": { seasons: [] },
    ["GET /products/" + product.id]: { product, variations: [variation] },
    ["GET /products/" + product.id + "/stock-matrix"]: { totalOnHand:"12", cells:{ navy:{ XL:{variationId:"v1",onHand:"12",reserved:"2"} } } },
    "GET /auth/2fa/sms/status": { enabled:false, maskedMobile:null },
    "GET /variations/v1/price-history": { history: [] },
    "GET /reports/sales": { rows: [] }, "GET /reports/cash-reconciliation": { rows: [] },
    "GET /treasury/accounts": { accounts: [] }, "GET /treasury/transactions": { transactions: [] },
    "GET /purchasing/expense-accounts": [], "GET /purchasing/pay-accounts": [], "GET /suppliers": [],
    "GET /receipts": [], "GET /stock-counts": [], "GET /cheques/due": { due: [] },
    "GET /users": { users: [staff, { ...staff, id: me.id, username: "synthetic_admin", fullName: me.fullName }] }, "GET /roles": { roles: [{ code: "cashier", name: "صندوق‌دار" }] },
    "POST /auth/change-password": { ok: true }, "POST /auth/lock": { locked: true }, "POST /auth/logout": { ok: true },
    "GET /auth/pin": { hasPin:false, length:4 },
  };
  async install(page: Page) {
    page.on("pageerror", e => this.errors.push(e.message));
    page.on("response", r => { if (r.url().endsWith(".woff2") && r.ok()) this.fonts.push(r.url()); });
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://127.0.0.1:4173") { this.external.push(url.href); await route.abort(); return; }
      if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
      const key = route.request().method() + " " + url.pathname.slice(4);
      this.calls.push(key + url.search);
      const handler = this.handlers.get(key);
      if (handler) { await handler(route, url); return; }
      const body = key === "GET /products" ? { products: this.productRows } : key === "GET /permission-rules" ? { rules: this.permissionRows } : this.defaults[key];
      if (body === undefined) { this.unexpected.push(key + url.search); await route.fulfill({ status: 501, json: { error: { code: "unmocked", message: key } } }); return; }
      await route.fulfill({ json: body });
    });
  }
}
export const test = base.extend<{ api: MockApi }>({
  api: [async ({ page }, use) => {
    const api = new MockApi(); await api.install(page); await use(api);
    expect(api.unexpected, "Unexpected API request").toEqual([]);
    expect(api.errors, "Uncaught browser exception").toEqual([]);
    expect(api.external, "External requests are forbidden").toEqual([]);
  }, { auto: true }],
});
export { expect };
export async function openCatalog(page: Page) {
  await page.goto("/");
  await page.getByRole("tab", { name: "کالا و قیمت", exact: true }).click();
  await expect(page.getByRole("searchbox")).toBeVisible();
}
export async function settings(page: Page, value: string, label: string) {
  await page.getByRole("tablist", { name: "بخش‌ها", exact: true }).getByRole("tab", { name: "تنظیمات", exact: true }).click();
  await expect(page.locator(".settings-nav")).toBeVisible();
  const picker = page.getByRole("combobox", { name: "بخش تنظیمات" });
  if (await picker.isVisible()) await picker.selectOption(value);
  else await page.getByRole("tab", { name: label, exact: true }).click();
}
export async function fontsReady(page: Page) {
  await page.evaluate(async () => {
    for (const weight of [300, 400, 500, 600, 700, 800]) await document.fonts.load(weight + " 16px Vazirmatn", "کالا");
    for (const weight of [400, 500, 600, 700]) await document.fonts.load(weight + ' 16px "IBM Plex Mono"', "12345");
    await document.fonts.ready;
  });
  await expect.poll(() => page.evaluate(() => [...document.fonts].every(font => font.status === "loaded"))).toBe(true);
}
