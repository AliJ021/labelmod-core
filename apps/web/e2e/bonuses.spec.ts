/**
 * دفتر پاداش و ناحیهٔ «برداشت و پاداش» در مرورگر (مهاجرت ۰۹۸) — **API ماک**
 * (`MockApi`)؛ قرارداد سرور در `apps/api/test/staff-bonus.integration.test.ts`
 * با دیتابیس واقعی سنجیده می‌شود.
 *
 * ادعاها: ناحیه در منوی اصلی است و پیوند قدیمی تنظیمات با فیلترهایش منتقل
 * می‌شود؛ درخواست کارمند با عمل ایمن و بی شناسهٔ ذی‌نفع؛ نتیجهٔ نامعلوم فقط با
 * همان کلید بررسی می‌شود؛ مدیر تأیید/رد (رد بی دلیل نه)، اعطای مستقیم و تسویهٔ
 * گروهی با جمع دقیق؛ پاداش خود انتخاب‌شدنی نیست؛ تعارض «قدیمی» انتخاب را پاک
 * می‌کند؛ بی‌مجوز هیچ درخواستی به دفتر مدیر نمی‌رود.
 */
import { test, expect, personnel } from "./fixtures";
import type { Page, Route } from "@playwright/test";
import type { BonusDetail, BonusItem } from "../src/lib/bonuses";

const ME = "22222222-2222-4222-8222-222222222222";
const CASHIER = { id: "44444444-4444-4444-8444-444444444444", name: "صندوق‌دار آزمایشی" };
const GM = { id: ME, name: "مدیر آزمایشی" };
const B1 = "66666666-6666-4666-8666-666666666661";
const B2 = "66666666-6666-4666-8666-666666666662";
const B3 = "66666666-6666-4666-8666-666666666663";

const bonus = (id: string, owner: { id: string; name: string }, amount: string, reason: string, status: BonusItem["status"] = "pending",
  origin: BonusItem["origin"] = "request"): BonusItem => ({
  id, owner, origin, amount, reason, createdAt: "2026-10-01T06:30:00Z", createdBy: origin === "award" ? GM.name : owner.name, status,
  decidedAt: status === "pending" ? null : "2026-10-02T06:30:00Z", decidedBy: status === "pending" ? null : GM.name, decisionNote: null,
  settledAt: status === "settled" ? "2026-10-03T06:30:00Z" : null, settledBy: status === "settled" ? GM.name : null, settlementNote: null,
});
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body });
const page1 = (items: BonusItem[]) => ({ items, total: items.length, page: 1, pageSize: 20 });

test.beforeEach(async ({ api }) => {
  api.defaults["GET /bonuses/owners"] = { owners: [CASHIER, GM] };
  api.defaults["GET /bonuses/beneficiaries"] = { beneficiaries: [CASHIER] };
  api.defaults["GET /bonuses/mine"] = page1([]);
  api.defaults["GET /withdrawals/mine"] = { items: [], total: 0, page: 1, pageSize: 20 };
  api.defaults["GET /withdrawals/owners"] = { owners: [] };
  api.defaults["GET /withdrawals"] = { items: [], total: 0, page: 1, pageSize: 20 };
});

async function openLog(page: Page) {
  await page.goto("/?page=personnel&personnel.tab=bonus-log");
  await expect(page.getByRole("heading", { name: "دفتر پاداش پرسنل", level: 1 })).toBeVisible();
}

test.describe("ناحیهٔ برداشت و پاداش", () => {
  test("در منوی اصلی است، نه در تنظیمات؛ پیوند قدیمی با فیلترها منتقل می‌شود", async ({ page, api }) => {
    await page.goto("/?page=settings&settings.tab=withdrawal-log&settings.wdlStatus=open&settings.wdlOwner=" + CASHIER.id);
    await expect(page).toHaveURL(/page=personnel/);
    const url = new URL(page.url());
    expect([url.searchParams.get("personnel.tab"), url.searchParams.get("personnel.wdlStatus"), url.searchParams.get("personnel.wdlOwner"), url.searchParams.get("settings.tab")])
      .toEqual(["withdrawal-log", "open", CASHIER.id, null]);
    await expect(page.getByRole("heading", { name: "دفتر برداشت پرسنل", level: 1 })).toBeVisible();
    await expect.poll(() => api.calls.some(c => c.startsWith("GET /withdrawals?") && c.includes("status=open"))).toBe(true);
    await page.goto("/?page=settings&settings.tab=withdrawals");
    await expect(page).toHaveURL(/personnel\.tab=withdrawals/);
    await expect(page.getByRole("heading", { name: "برداشت‌های من", level: 1 })).toBeVisible();
    await page.goto("/?page=settings");
    await expect(page.getByRole("heading", { name: "تنظیمات", level: 1 })).toBeVisible();
    await expect(page.locator(".settings-nav")).not.toContainText("برداشت");
    await personnel(page, "bonuses", "پاداش‌های من");
    await expect(page.getByRole("heading", { name: "پاداش‌های من", level: 1 })).toBeVisible();
  });

  test("بی‌مجوز مدیر: فقط «من»ها؛ دفترهای مدیر mount نمی‌شوند و درخواستی نمی‌رود", async ({ page, api }) => {
    api.handlers.set("GET /auth/can", async (route, url) => {
      const op = url.searchParams.get("operation") ?? "";
      await json(route, { verdict: op.startsWith("bonus.") || op.startsWith("withdrawal.") ? "deny" : "allow", approver: null, reason: "" });
    });
    for (const tab of ["bonus-log", "withdrawal-log"]) {
      await page.goto(`/?page=personnel&personnel.tab=${tab}`);
      await expect(page.getByRole("heading", { name: "دسترسی ندارید" })).toBeVisible();
    }
    expect(api.calls.some(c => /^GET \/(bonuses|withdrawals)(\?|\/owners|\/beneficiaries|\/selection)/.test(c))).toBe(false);
    await personnel(page, "bonuses", "پاداش‌های من");
    await expect(page.getByRole("heading", { name: "پاداش‌های من", level: 1 })).toBeVisible();
    await expect(page.locator(".settings-nav")).not.toContainText("دفتر پاداش");
  });
});

test.describe("پاداش‌های من", () => {
  test("درخواست با عمل ایمن: ریال رشته‌ای، شناسهٔ عملیات، بی ذی‌نفع؛ نتیجهٔ نامعلوم فقط با همان کلید", async ({ page, api }) => {
    const rows: BonusItem[] = [bonus(B1, GM, "500000", "اعطای قبلی", "approved", "award")];
    api.handlers.set("GET /bonuses/mine", route => json(route, page1(rows)));
    let posts = 0, key = "";
    api.handlers.set("POST /bonuses", async route => {
      posts++; key = route.request().headers()["idempotency-key"]!;
      expect(route.request().postDataJSON()).toEqual({ amount: "1500000", reason: "فروش ویژه" });
      rows.unshift(bonus(B2, GM, "1500000", "فروش ویژه"));
      api.handlers.set(`GET /bonuses/mine/by-key/${key}`, r => json(r, { status: "recorded" }));
      await json(route, { error: { code: "response_lost", message: "پاسخ قطع شد" } }, 502);
    });
    await page.goto("/?page=personnel&personnel.tab=bonuses");
    await expect(page.getByRole("region", { name: "پاداش‌های من" }).getByText("اعطای مدیر")).toBeVisible();
    await page.getByLabel("مبلغ (تومان)").fill("0");
    await expect(page.getByText("مبلغ پاداش باید بیشتر از صفر باشد.")).toBeVisible();
    await expect(page.getByRole("button", { name: "ثبت درخواست پاداش" })).toBeDisabled();
    await page.getByLabel("مبلغ (تومان)").fill("۱۵۰٬۰۰۰");
    await page.getByLabel("دلیل پاداش").fill("  فروش ویژه ");
    await page.getByRole("button", { name: "ثبت درخواست پاداش" }).click();
    const dialog = page.getByRole("dialog", { name: "ثبت درخواست پاداش" });
    await expect(dialog.getByText("هیچ پولی جابه‌جا نمی‌شود")).toBeVisible();
    await dialog.getByRole("button", { name: "ثبت درخواست" }).click();
    await expect.poll(() => posts).toBe(1);
    await page.reload();
    await expect(page.getByLabel("دلیل پاداش")).toBeDisabled();
    await page.getByRole("button", { name: "نتیجه نامعلوم؛ بررسی وضعیت", exact: true }).click();
    await page.getByRole("button", { name: "بررسی وضعیت", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "درخواست پیش‌تر ثبت شده بود" })).toBeVisible();
    expect(posts, "هیچ ارسال دوباره‌ای").toBe(1);
    expect(api.calls).toContain(`GET /bonuses/mine/by-key/${key}`);
  });
});

test.describe("دفتر پاداش مدیر", () => {
  test("رد بی دلیل ممکن نیست؛ رد با دلیل و تأیید با همان کلید و بدنه", async ({ page, api }) => {
    let row = bonus(B1, CASHIER, "300000", "اضافه‌کار");
    api.handlers.set("GET /bonuses", route => json(route, page1([row])));
    api.handlers.set(`GET /bonuses/${B1}`, route => json(route, { ...row, canManage: true } satisfies BonusDetail));
    const sent: unknown[] = [];
    api.handlers.set(`POST /bonuses/${B1}/decisions`, async route => {
      sent.push(route.request().postDataJSON());
      expect(route.request().headers()["idempotency-key"]).toMatch(/^[a-f0-9-]{36}$/);
      row = { ...row, status: "rejected", decidedAt: "2026-10-02T06:30:00Z", decidedBy: GM.name, decisionNote: "خارج از سیاست" };
      await json(route, { bonus: row, replayed: false });
    });
    await openLog(page);
    await page.getByRole("button", { name: new RegExp(`جزئیات و بررسی پاداش ${CASHIER.name}`) }).click();
    await page.getByRole("radio", { name: "رد" }).check();
    await expect(page.getByRole("button", { name: "ثبت رد" })).toBeDisabled();
    await page.getByLabel("دلیل رد").fill("خارج از سیاست");
    await page.getByRole("button", { name: "ثبت رد" }).click();
    const dialog = page.getByRole("dialog", { name: `رد پاداش ${CASHIER.name}` });
    await expect(dialog).toContainText("هیچ اثر مالی ندارد");
    await dialog.getByRole("button", { name: "رد درخواست" }).click();
    await expect(page.getByRole("status").filter({ hasText: "درخواست رد شد." })).toBeVisible();
    expect(sent).toEqual([{ decision: "rejected", note: "خارج از سیاست" }]);
  });

  test("درخواست خود مدیر: بررسی بسته است و در انتخاب تسویه نیست", async ({ page, api }) => {
    const own = bonus(B1, GM, "100000", "درخواست مدیر");
    const ownApproved = bonus(B2, GM, "200000", "تأییدشدهٔ مدیر", "approved");
    api.handlers.set("GET /bonuses", route => json(route, page1([own, ownApproved])));
    api.handlers.set(`GET /bonuses/${B1}`, route => json(route, { ...own, canManage: false }));
    await openLog(page);
    await expect(page.getByRole("checkbox", { name: `انتخاب پاداش ${GM.name}، تأییدشدهٔ مدیر` })).toBeDisabled();
    await expect(page.getByRole("button", { name: "انتخاب تأییدشده‌های این صفحه" })).toBeDisabled();
    await page.getByRole("button", { name: new RegExp(`جزئیات و بررسی پاداش ${GM.name}`) }).first().click();
    await expect(page.getByText("درخواست پاداش خودتان را مدیر دیگری بررسی می‌کند.")).toBeVisible();
    expect(api.calls.some(c => c.startsWith("POST /bonuses"))).toBe(false);
  });

  test("اعطای مستقیم: کارمند از فهرست سرور، مبلغ و دلیل اجباری؛ بدنهٔ دقیق", async ({ page, api }) => {
    api.handlers.set("GET /bonuses", route => json(route, page1([])));
    let body: unknown = null;
    api.handlers.set("POST /bonuses/awards", async route => {
      body = route.request().postDataJSON();
      await json(route, { bonus: bonus(B3, CASHIER, "2500000", "رضایت مشتری", "approved", "award"), replayed: false }, 201);
    });
    await openLog(page);
    const award = page.getByRole("region", { name: "اعطای مستقیم پاداش" });
    await expect(award.getByRole("button", { name: "اعطای پاداش" })).toBeDisabled();
    await award.getByLabel("کارمند ذی‌نفع").selectOption(CASHIER.id);
    await award.getByLabel("مبلغ پاداش (تومان)").fill("250000");
    await expect(award.getByRole("button", { name: "اعطای پاداش" })).toBeDisabled();
    await award.getByLabel("دلیل اعطا").fill("رضایت مشتری");
    await award.getByRole("button", { name: "اعطای پاداش" }).click();
    const dialog = page.getByRole("dialog", { name: "تأیید اعطای پاداش" });
    await expect(dialog).toContainText(CASHIER.name);
    await dialog.getByRole("button", { name: "ثبت اعطا" }).click();
    await expect(page.getByRole("status").filter({ hasText: "پاداش اعطا شد" })).toBeVisible();
    expect(body).toEqual({ ownerId: CASHIER.id, amount: "2500000", reason: "رضایت مشتری" });
  });

  test("مجوز وسط کار گرفته شد (۴۰۳): عملیات ذخیره‌شده آزاد می‌شود و فرم قفل نمی‌ماند", async ({ page, api }) => {
    api.handlers.set("GET /bonuses", route => json(route, page1([])));
    api.handlers.set("POST /bonuses/awards", route => json(route, { error: { code: "forbidden", message: "مجوز این کار را ندارید" } }, 403));
    await openLog(page);
    const award = page.getByRole("region", { name: "اعطای مستقیم پاداش" });
    await award.getByLabel("کارمند ذی‌نفع").selectOption(CASHIER.id);
    await award.getByLabel("مبلغ پاداش (تومان)").fill("1000");
    await award.getByLabel("دلیل اعطا").fill("آزمون");
    await award.getByRole("button", { name: "اعطای پاداش" }).click();
    await page.getByRole("dialog", { name: "تأیید اعطای پاداش" }).getByRole("button", { name: "ثبت اعطا" }).click();
    await expect(page.getByRole("dialog", { name: "تأیید اعطای پاداش" })).toContainText("مجوز این کار را ندارید");
    await page.reload();
    await expect(award.getByLabel("دلیل اعطا")).toBeEnabled();
    await expect(page.getByRole("button", { name: "نتیجه نامعلوم؛ بررسی وضعیت" })).toHaveCount(0);
  });

  test("تسویهٔ گروهی: انتخاب همه از سرور، جمع دقیق، پاسخ گم‌شده فقط با همان کلید", async ({ page, api }) => {
    const a = bonus(B1, CASHIER, "101", "یک", "approved"), b = bonus(B2, CASHIER, "999999999999999999", "دو", "approved", "award");
    api.handlers.set("GET /bonuses", route => json(route, { items: [a], total: 21, page: 1, pageSize: 20 }));
    let filter = "", posts = 0;
    api.handlers.set("GET /bonuses/selection", async (route, url) => { filter = url.search; await json(route, { items: [a, b] }); });
    api.handlers.set("POST /bonuses/settlements", async route => {
      posts++;
      const key = route.request().headers()["idempotency-key"]!;
      expect(route.request().postDataJSON()).toEqual({ items: [B1, B2], note: "تسویهٔ مهر" });
      api.handlers.set(`GET /bonuses/settlements/by-key/${key}`, r => json(r, { status: "recorded", count: 2 }));
      await json(route, { error: { code: "response_lost", message: "پاسخ قطع شد" } }, 502);
    });
    await openLog(page);
    await page.getByLabel("کارمند", { exact: true }).selectOption(CASHIER.id);
    await page.getByLabel("وضعیت پاداش", { exact: true }).selectOption("approved");
    await page.getByRole("button", { name: "انتخاب همهٔ تأییدشده‌های این فیلتر", exact: true }).click();
    await expect.poll(() => filter).toContain(`ownerId=${CASHIER.id}`);
    expect(filter).toContain("status=approved");
    await page.getByLabel("یادداشت تسویه", { exact: true }).fill("تسویهٔ مهر");
    await page.getByRole("button", { name: "تسویهٔ پاداش‌های انتخاب‌شده", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "تأیید تسویهٔ پاداش‌های انتخاب‌شده" });
    await expect(dialog).toContainText("همه یا هیچ");
    expect(posts).toBe(0);
    await dialog.getByRole("button", { name: "تأیید و ثبت تسویه", exact: true }).click();
    await expect.poll(() => posts).toBe(1);
    await page.reload();
    await expect(page.getByLabel("یادداشت تسویه", { exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "نتیجه نامعلوم؛ بررسی وضعیت", exact: true }).click();
    await page.getByRole("button", { name: "بررسی وضعیت", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "انتخاب‌ها تسویه شدند" })).toBeVisible();
    expect(posts).toBe(1);
  });

  test("تعارض تسویه (۴۰۹ قدیمی): پیام سرور، انتخاب پاک و فهرست تازه می‌شود", async ({ page, api }) => {
    const a = bonus(B1, CASHIER, "101", "قدیمی", "approved");
    const pending = bonus(B2, CASHIER, "102", "در انتظار");
    api.handlers.set("GET /bonuses", route => json(route, page1([a, pending])));
    api.handlers.set("POST /bonuses/settlements", route => json(route, { error: { code: "bonus_stale", message: "بخشی از انتخاب تغییر کرده یا تسویه شده است" } }, 409));
    await openLog(page);
    await expect(page.getByRole("checkbox", { name: `انتخاب پاداش ${CASHIER.name}، در انتظار` })).toBeDisabled();
    await page.getByRole("button", { name: "انتخاب تأییدشده‌های این صفحه", exact: true }).click();
    await page.getByLabel("یادداشت تسویه", { exact: true }).fill("x");
    await page.getByRole("button", { name: "تسویهٔ پاداش‌های انتخاب‌شده", exact: true }).click();
    await page.getByRole("button", { name: "تأیید و ثبت تسویه", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("تغییر کرده");
    await expect(page.getByRole("checkbox", { name: `انتخاب پاداش ${CASHIER.name}، قدیمی` })).not.toBeChecked();
    expect(api.calls.filter(c => c === "POST /bonuses/settlements")).toHaveLength(1);
  });
});
