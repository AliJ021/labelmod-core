/**
 * «سفارش اینستاگرام» در مرورگر — API ماک.
 * - مبلغ ناقص یا اضافه پیش از هر درخواست رد می‌شود (کنترل منفی: هیچ POST تأیید نمی‌رود).
 * - تأیید واریز از «عمل مالی ایمن» می‌گذرد: نتیجهٔ نامعلوم فقط «بررسی وضعیت» دارد؛ اگر سرور بگوید
 *   ثبت نشده، تأیید دوباره **همان** کلید و **همان** بدنه را می‌برد.
 * - نسخهٔ دیده‌شدهٔ سفارش در بدنه است، تا سرور تأیید سبدِ عوض‌شده را رد کند.
 * - پس از نهایی: سابقهٔ واریز، گام ارسال، مسیر مرجوعی؛ لغو و تأیید دوباره دیده نمی‌شوند.
 * - جست‌وجو فقط در بدنهٔ POST است، نه در نشانی.
 * - بی هیچ‌کدام از دو مجوز، منو دیده نمی‌شود و درخواستی نمی‌رود.
 * درخواست‌ها دقیق شمرده می‌شوند؛ هیچ sleep در کار نیست.
 */
import { test, expect, type MockApi } from "./fixtures";

const ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ACCOUNT = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const summary = {
  id: ID, orderNo: "IG-000123", status: "reserved", paymentState: "claimed", shippingState: "not_started",
  instagramUsername: "shop.buyer", customerName: "مشتری دایرکت", mobile: "09121234567",
  payable: "1050000", reservedUntil: "2026-10-24T10:00:00.000Z", createdAt: "2026-10-23T08:00:00.000Z", branchId: "b1",
};
const reserved = {
  id: ID, orderNo: "IG-000123", status: "reserved", paymentState: "claimed", paymentNote: "عکس رسید فرستاد",
  shippingState: "not_started", trackingCode: null, version: 7, reservedUntil: "2026-10-24T10:00:00.000Z",
  cancelReason: null, createdAt: "2026-10-23T08:00:00.000Z", updatedAt: "2026-10-23T08:30:00.000Z",
  branch: { id: "b1", name: "شعبه آزمایشی" }, warehouse: { id: "w1", name: "انبار آزمایشی" },
  customer: { id: "c1", name: "مشتری دایرکت", mobile: "09121234567", instagramUsername: "shop.buyer" },
  shipping: { address: "تهران، خیابان آزمایشی ۱", method: "پست پیشتاز" },
  receivingAccount: null,
  invoice: { id: "i1", number: null, status: "draft", gross: "1000000", discount: "0", shipping: "50000", payable: "1050000" },
  lines: [{ id: "l1", variationId: "v1", sku: "TR-1405-NAVY-XL", product: "شلوار پارچه‌ای", color: "سرمه‌ای", size: "XL",
    qty: 1, unitPrice: "1000000", discountAmount: "0", netAmount: "1000000", available: "0",
    sync: { state: "queued", at: null, error: null } }],
  holds: [{ variationId: "v1", qty: "1", expiresAt: "2026-10-24T10:00:00.000Z" }],
  payment: null, returns: [], similarOpen: [{ id: "cccccccc-3333-4333-8333-cccccccccccc", orderNo: "IG-000119", status: "draft", createdAt: "2026-10-22T08:00:00.000Z" }],
};
const finalized = {
  ...reserved, status: "finalized", paymentState: "confirmed", version: 8, reservedUntil: null, holds: [], similarOpen: [],
  invoice: { ...reserved.invoice, number: "S-1405-000321", status: "paid" },
  lines: [{ ...reserved.lines[0]!, sync: { state: "sent", at: "2026-10-23T09:01:00.000Z", error: null } }],
  payment: { accountId: ACCOUNT, accountName: "بانک آزمایشی", amount: "1050000", refNo: "778899", paidAt: "2026-09-01T06:30:00.000Z",
    verifiedBy: "مدیر آزمایشی", verifiedAt: "2026-10-23T09:00:00.000Z", paymentId: "p1" },
};
const accounts = { accounts: [{ id: ACCOUNT, code: "1102", name: "بانک آزمایشی", bankName: "بانک", accountNo: "6037-0000" }] };
const page1 = { page: 1, perPage: 20, total: 1, pages: 1, orders: [summary] };
const calls = (api: MockApi) => api.calls.filter(c => / \/instagram-orders/.test(c));

test.describe("سفارش اینستاگرام", () => {
  test("exact full amount before any request; unknown result offers only a status check, which shows the recorded sale", async ({ page, api }) => {
    const confirms: { key: string | undefined; body: unknown }[] = [];
    let detail: object = reserved;
    api.handlers.set("GET /instagram-orders", async route => { await route.fulfill({ json: page1 }); });
    api.handlers.set(`GET /instagram-orders/${ID}`, async route => { await route.fulfill({ json: detail }); });
    api.handlers.set("GET /instagram-orders/accounts", async route => { await route.fulfill({ json: accounts }); });
    api.handlers.set(`POST /instagram-orders/${ID}/confirm`, async route => {
      confirms.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
      // سرور اثر را ثبت کرد ولی پاسخ نرسید.
      detail = finalized; await route.abort("connectionreset");
    });

    await page.goto("/?page=instagram-orders");
    const row = page.getByRole("row").filter({ hasText: "IG-000123" });
    await expect(row).toContainText("105٬000");
    await row.getByRole("button", { name: "جزئیات IG-000123" }).click();
    const panel = page.getByRole("region", { name: "سفارش IG-000123" });
    await expect(panel).toContainText("مشتری می‌گوید واریز کرده");
    await expect(panel).toContainText("IG-000119");
    await expect(panel).toContainText("در صف ارسال به سایت");

    const form = panel.getByRole("form", { name: "فرم تأیید واریز" });
    const trigger = form.getByRole("button", { name: "تأیید واریز و نهایی‌سازی" });
    await form.getByLabel("حساب مقصد").selectOption(ACCOUNT);
    await form.getByLabel("مبلغ واریز (تومان)").fill("۱۰۰٬۰۰۰");
    await form.getByLabel("شمارهٔ پیگیری بانک").fill("778899");
    await form.getByLabel("زمان واریز").fill("2026-09-01T10:00");
    await expect(form).toContainText("دقیقاً برابر مبلغ کامل سفارش");
    await expect(trigger).toBeDisabled();
    expect(confirms).toEqual([]);

    await form.getByLabel("مبلغ واریز (تومان)").fill("۱۰۵٬۰۰۰");
    await expect(trigger).toBeEnabled();
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "تأیید واریز سفارش IG-000123" });
    await expect(dialog).toContainText("105٬000");
    await expect(dialog).toContainText("778899");
    await dialog.getByRole("button", { name: "تأیید واریز و نهایی‌سازی" }).click();
    await expect(dialog).toContainText("نتیجه نامعلوم");
    // نامعلوم «ارسال دوباره» ندارد؛ فقط بررسی وضعیت، که فروش ثبت‌شده را نشان می‌دهد.
    await expect(dialog.getByRole("button", { name: "تأیید واریز و نهایی‌سازی" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "بررسی وضعیت" }).click();
    await expect(panel).toContainText("واریز تطبیق و تأیید شد");
    await expect(panel.getByRole("region", { name: "تأیید واریز" })).toHaveCount(0);
    expect(confirms).toHaveLength(1);
  });

  test("status check says not recorded: confirming again sends the same key and body; finalized view", async ({ page, api }) => {
    const confirms: { key: string | undefined; body: Record<string, unknown> }[] = [];
    api.handlers.set("GET /instagram-orders", async route => { await route.fulfill({ json: page1 }); });
    let detail: object = reserved;
    api.handlers.set(`GET /instagram-orders/${ID}`, async route => { await route.fulfill({ json: detail }); });
    api.handlers.set("GET /instagram-orders/accounts", async route => { await route.fulfill({ json: accounts }); });
    api.handlers.set(`POST /instagram-orders/${ID}/confirm`, async route => {
      confirms.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
      if (confirms.length === 1) { await route.abort("connectionreset"); return; }
      detail = finalized;
      await route.fulfill({ json: finalized });
    });

    await page.goto(`/?page=instagram-orders&ig.order=${ID}`);
    const panel = page.getByRole("region", { name: "سفارش IG-000123" });
    const form = panel.getByRole("form", { name: "فرم تأیید واریز" });
    await form.getByLabel("حساب مقصد").selectOption(ACCOUNT);
    await form.getByLabel("مبلغ واریز (تومان)").fill("105000");
    await form.getByLabel("شمارهٔ پیگیری بانک").fill("778899");
    await form.getByLabel("زمان واریز").fill("2026-09-01T10:00");
    await form.getByRole("button", { name: "تأیید واریز و نهایی‌سازی" }).click();
    const dialog = page.getByRole("dialog", { name: "تأیید واریز سفارش IG-000123" });
    await dialog.getByRole("button", { name: "تأیید واریز و نهایی‌سازی" }).click();
    await dialog.getByRole("button", { name: "بررسی وضعیت" }).click();
    await expect(dialog).toContainText("عملیات انجام نشده است");
    await dialog.getByRole("button", { name: "تأیید واریز و نهایی‌سازی" }).click();

    await expect(panel).toContainText("واریز تطبیق و تأیید شد");
    expect(confirms).toHaveLength(2);
    expect(confirms[1]!.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(confirms[1]!.key, "تأیید دوباره همان عمل است").toBe(confirms[0]!.key);
    expect(confirms[1]!.body).toEqual(confirms[0]!.body);
    expect(confirms[0]!.body).toEqual({ version: 7, accountId: ACCOUNT, amount: "1050000", refNo: "778899",
      paidAt: new Date("2026-09-01T10:00").toISOString() });

    // نهایی: سابقهٔ واریز، گام ارسال و مسیر مرجوعی؛ نه لغو، نه تأیید دوباره، نه ویرایش سبد.
    await expect(panel.getByRole("region", { name: "واریز تطبیق‌شده" })).toContainText("778899");
    await expect(panel.getByRole("region", { name: "ارسال" }).getByRole("button", { name: "در حال بسته‌بندی" })).toBeVisible();
    await expect(panel.getByRole("region", { name: "مرجوعی" })).toContainText("S-1405-000321");
    await expect(panel.getByRole("region", { name: "تأیید واریز" })).toHaveCount(0);
    await expect(panel.getByRole("region", { name: "لغو سفارش" })).toHaveCount(0);
    await expect(panel.getByRole("region", { name: "افزودن کالا" })).toHaveCount(0);
    await expect(panel).toContainText("سایت پذیرفت");
    expect(api.unexpected).toEqual([]);
    expect(api.errors).toEqual([]);
  });

  test("search goes only in the POST body, never in the page or request URL", async ({ page, api }) => {
    const bodies: unknown[] = [];
    api.handlers.set("GET /instagram-orders", async route => { await route.fulfill({ json: { ...page1, orders: [] , total: 0 } }); });
    api.handlers.set("POST /instagram-orders/search", async route => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({ json: page1 });
    });
    await page.goto("/?page=instagram-orders");
    const search = page.getByRole("search", { name: "جست‌وجوی سفارش اینستاگرام" });
    await search.getByLabel("جست‌وجو").fill("09121234567");
    await search.getByLabel("جست‌وجو").press("Enter");
    await expect(page.getByRole("row").filter({ hasText: "IG-000123" })).toBeVisible();
    expect(bodies).toEqual([{ q: "09121234567" }]);
    expect(page.url()).not.toContain("0912");
    expect(api.calls.filter(c => c.includes("0912"))).toEqual([]);
  });

  test("without either Instagram permission the menu entry is hidden and nothing is requested", async ({ page, api }) => {
    api.handlers.set("GET /auth/can", async (route, url) => {
      const op = url.searchParams.get("operation") ?? "";
      await route.fulfill({ json: { verdict: op.startsWith("instagram.") ? "deny" : "allow", approver: null, reason: "" } });
    });
    await page.goto("/");
    // کنترل منفی معنادار: «سفارش‌های سایت» در همان رندرِ پس از دسترسی ظاهر می‌شود.
    await expect(page.getByRole("tab", { name: "سفارش‌های سایت", includeHidden: true }).first()).toBeAttached();
    await expect(page.getByRole("tab", { name: "سفارش اینستاگرام", includeHidden: true })).toHaveCount(0);
    expect(calls(api)).toEqual([]);
  });
});
