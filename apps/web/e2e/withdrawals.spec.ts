/**
 * دفتر برداشت پرسنل در مرورگر (مهاجرت ۰۸۴) — **API ماک** (`MockApi`)؛ قرارداد
 * سرور در `apps/api/test/staff-withdrawal.integration.test.ts` سنجیده می‌شود.
 *
 * ادعاها: ثبت از عمل ایمن با شناسهٔ عملیات و بی شناسهٔ مالک؛ نتیجهٔ نامعلوم
 * «ارسال دوباره» ندارد و فقط با همان کلید بررسی می‌شود؛ صفر در ثبت رد و در
 * اصلاح مدیر مجاز؛ تعارض نسخه پیام سرور را نشان می‌دهد و تاریخچه را تازه
 * می‌کند؛ بی‌مجوز هیچ درخواستی به دفتر مدیر نمی‌فرستد؛ برداشت خودِ مدیر فرم
 * اصلاح ندارد. تصویرهای شواهد با API ماک‌اند و در نامشان «mock» دارند.
 */
import { test, expect, settings, fontsReady, type MockApi } from "./fixtures";
import type { Page, Route } from "@playwright/test";
import type { WithdrawalDetail, WithdrawalItem } from "../src/lib/withdrawals";

const ME = "22222222-2222-4222-8222-222222222222";
const CASHIER = { id: "44444444-4444-4444-8444-444444444444", name: "صندوق‌دار آزمایشی" };
const GM = { id: ME, name: "مدیر آزمایشی" };
const W1 = "55555555-5555-4555-8555-555555555551";
const W2 = "55555555-5555-4555-8555-555555555552";

const item = (id: string, owner: { id: string; name: string }, amount: string, reason: string, version = 1): WithdrawalItem => ({
  id, owner, createdAt: "2026-10-01T06:30:00Z", version, amount, reason,
  correctedAt: version > 1 ? "2026-10-02T08:00:00Z" : null, correctedBy: version > 1 ? GM.name : null,
});
const detail = (w: WithdrawalItem, canCorrect: boolean, history?: WithdrawalDetail["history"]): WithdrawalDetail => ({
  ...w, canCorrect,
  history: history ?? [{ version: 1, amount: w.amount, reason: w.reason, note: null, actor: w.owner, at: w.createdAt }],
});

/** پاسخ JSON با وضعیت دلخواه. */
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body });

function denyWithdrawalOps(api: MockApi) {
  api.handlers.set("GET /auth/can", async (route, url) => {
    const op = url.searchParams.get("operation") ?? "";
    await json(route, { verdict: op.startsWith("withdrawal.") ? "deny" : "allow", approver: null, reason: "" });
  });
}

async function openMine(page: Page) {
  await page.goto("/?page=settings&settings.tab=withdrawals");
  await expect(page.getByRole("heading", { name: "برداشت‌های من", level: 1 })).toBeVisible();
}

test.describe("برداشت‌های من", () => {
  test("ثبت با عمل ایمن: مبلغ تومانی به ریال، شناسهٔ عملیات، بی شناسهٔ مالک؛ فهرست تازه می‌شود", async ({ page, api }) => {
    const rows: WithdrawalItem[] = [item(W1, GM, "2500000", "کرایهٔ پیک")];
    const posted: { body: unknown; key: string | undefined }[] = [];
    api.handlers.set("GET /withdrawals/mine", route => json(route, { items: rows, total: rows.length, page: 1, pageSize: 20 }));
    api.handlers.set("POST /withdrawals", async route => {
      const body = route.request().postDataJSON() as { amount: string; reason: string };
      posted.push({ body, key: route.request().headers()["idempotency-key"] });
      const made = item(W2, GM, body.amount, body.reason);
      rows.unshift(made);
      await json(route, { withdrawal: detail(made, false), replayed: false }, 201);
    });
    await openMine(page);
    await expect(page.getByRole("region", { name: "برداشت‌های من" }).getByText("کرایهٔ پیک")).toBeVisible();
    const amount = page.getByLabel("مبلغ (تومان)");
    await amount.fill("0");
    await expect(page.getByText("مبلغ برداشت باید بیشتر از صفر باشد.")).toBeVisible();
    await expect(page.getByRole("button", { name: "ثبت برداشت" })).toBeDisabled();
    await amount.fill("۱۵۰٬۰۰۰");
    await page.getByLabel("دلیل برداشت").fill("  ناهار تیم  ");
    await page.getByRole("button", { name: "ثبت برداشت" }).click();
    const dialog = page.getByRole("dialog", { name: "ثبت برداشت" });
    await expect(dialog.getByText("هیچ پولی جابه‌جا نمی‌شود")).toBeVisible();
    await dialog.getByRole("button", { name: "ثبت برداشت" }).click();
    await expect(page.getByRole("status").filter({ hasText: "برداشت ثبت شد." })).toBeVisible();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toEqual({ amount: "1500000", reason: "ناهار تیم" });
    expect(posted[0]!.key, "شناسهٔ عملیات").toMatch(/^[0-9a-f-]{36}$/);
    await expect(page.getByRole("region", { name: "برداشت‌های من" }).getByText("ناهار تیم")).toBeVisible();
    await expect(page.getByLabel("مبلغ (تومان)")).toHaveValue("");
  });

  test("نتیجهٔ نامعلوم: «ارسال دوباره» نیست؛ همان کلید از سرور خوانده می‌شود", async ({ page, api }) => {
    const keys: string[] = [];
    api.handlers.set("GET /withdrawals/mine", route => json(route, { items: [], total: 0, page: 1, pageSize: 20 }));
    api.handlers.set("POST /withdrawals", async route => {
      keys.push(route.request().headers()["idempotency-key"] ?? "");
      await json(route, { error: { code: "internal", message: "خطای داخلی", correlationId: "req-wd1" } }, 503);
    });
    await openMine(page);
    await expect(page.getByText("هنوز برداشتی ثبت نکرده‌اید.")).toBeVisible();
    await page.getByLabel("مبلغ (تومان)").fill("20000");
    await page.getByLabel("دلیل برداشت").fill("قسط");
    await page.getByRole("button", { name: "ثبت برداشت" }).click();
    const dialog = page.getByRole("dialog", { name: "ثبت برداشت" });
    await dialog.getByRole("button", { name: "ثبت برداشت" }).click();
    await expect(dialog.getByText("نتیجه نامعلوم")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "ثبت برداشت" })).toHaveCount(0);
    await expect(page.getByLabel("مبلغ (تومان)")).toBeDisabled();
    let lookedUp = "";
    api.handlers.set("GET /withdrawals/mine/by-key/" + keys[0], async route => {
      lookedUp = keys[0]!;
      await json(route, { status: "recorded", withdrawal: detail(item(W2, GM, "200000", "قسط"), false) });
    });
    await dialog.getByRole("button", { name: "بررسی وضعیت" }).click();
    await expect(page.getByRole("status").filter({ hasText: "بررسی شد: برداشت پیش‌تر ثبت شده بود." })).toBeVisible();
    expect(keys, "فقط یک ارسال").toHaveLength(1);
    expect(lookedUp).toBe(keys[0]);
  });

  test("تاریخچهٔ برداشتِ اصلاح‌شده: صفر واقعی، نام و دلیل مدیر", async ({ page, api }) => {
    const corrected = item(W1, CASHIER, "0", "کرایه", 2);
    api.handlers.set("GET /withdrawals/mine", route => json(route, { items: [corrected], total: 1, page: 1, pageSize: 20 }));
    api.handlers.set(`GET /withdrawals/mine/${W1}`, route => json(route, detail(corrected, false, [
      { version: 1, amount: "900000", reason: "کرایه", note: null, actor: CASHIER, at: "2026-10-01T06:30:00Z" },
      { version: 2, amount: "0", reason: "کرایه", note: "ثبت تکراری", actor: GM, at: "2026-10-02T08:00:00Z" },
    ])));
    await openMine(page);
    await page.getByRole("button", { name: /^تاریخچهٔ برداشت/ }).click();
    const history = page.getByRole("region", { name: "تاریخچهٔ نسخه‌های این برداشت" });
    await expect(history.getByText("ثبت تکراری")).toBeVisible();
    await expect(history.getByText(GM.name)).toBeVisible();
    await expect(page.getByRole("heading", { name: "تاریخچهٔ برداشت" })).toBeFocused();
    await expect(page.locator(".money--unknown")).toHaveCount(0);
  });
});

test.describe("دفتر برداشت پرسنل (مدیر کل)", () => {
  function gmLog(api: MockApi, current: { value: WithdrawalDetail }) {
    api.handlers.set("GET /withdrawals", route => json(route, { items: [current.value, item(W2, GM, "300000", "برداشت مدیر")], total: 2, page: 1, pageSize: 20 }));
    api.handlers.set(`GET /withdrawals/${W1}`, route => json(route, current.value));
    api.handlers.set(`GET /withdrawals/${W2}`, route => json(route, detail(item(W2, GM, "300000", "برداشت مدیر"), false)));
  }

  test("دفتر، تاریخچه و اصلاح تا صفر با دلیل؛ بدنه شرط نسخه دارد", async ({ page, api }) => {
    const current = { value: detail(item(W1, CASHIER, "900000", "کرایه"), true) };
    gmLog(api, current);
    const posted: unknown[] = [];
    api.handlers.set(`POST /withdrawals/${W1}/corrections`, async route => {
      const body = route.request().postDataJSON() as { amount: string; reason: string; note: string };
      expect(route.request().headers()["idempotency-key"]).toBeTruthy();
      posted.push(body);
      current.value = detail(item(W1, CASHIER, body.amount, body.reason, 2), true, [
        ...current.value.history, { version: 2, amount: body.amount, reason: body.reason, note: body.note, actor: GM, at: "2026-10-02T08:00:00Z" }]);
      await json(route, { appliedVersion: 2, withdrawal: current.value, replayed: false });
    });
    await page.goto("/?page=settings&settings.tab=withdrawal-log");
    await expect(page.getByRole("heading", { name: "دفتر برداشت پرسنل", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: new RegExp(`^تاریخچه و اصلاح برداشت ${CASHIER.name}`) }).click();
    await expect(page.getByRole("heading", { name: `برداشت ${CASHIER.name}` })).toBeFocused();
    const amount = page.getByLabel("مبلغ درست (تومان)");
    await expect(amount).toHaveValue("90000");
    await expect(page.getByRole("button", { name: "ثبت اصلاح" })).toBeDisabled();
    await amount.fill("0");
    await page.getByLabel("دلیل اصلاح").fill("ثبت تکراری");
    await page.getByRole("button", { name: "ثبت اصلاح" }).click();
    const dialog = page.getByRole("dialog", { name: `اصلاح برداشت ${CASHIER.name}` });
    await expect(dialog.getByText("هیچ سند یا جابه‌جایی پولی ساخته نمی‌شود")).toBeVisible();
    await dialog.getByRole("button", { name: "ثبت اصلاح" }).click();
    await expect(page.getByRole("status").filter({ hasText: "اصلاح ثبت شد" })).toBeVisible();
    expect(posted).toEqual([{ expectedVersion: 1, amount: "0", reason: "کرایه", note: "ثبت تکراری" }]);
    await expect(page.getByRole("region", { name: `تاریخچهٔ برداشت ${CASHIER.name}` }).getByText("ثبت تکراری")).toBeVisible();
  });

  test("تعارض نسخه: پیام سرور، تاریخچهٔ تازه، پیش‌نویس می‌ماند", async ({ page, api }) => {
    const current = { value: detail(item(W1, CASHIER, "900000", "کرایه"), true) };
    gmLog(api, current);
    api.handlers.set(`POST /withdrawals/${W1}/corrections`, async route => {
      current.value = detail(item(W1, CASHIER, "100000", "کرایه", 2), true, [
        ...current.value.history, { version: 2, amount: "100000", reason: "کرایه", note: "مدیر دیگر", actor: { id: "x", name: "مدیر دیگر" }, at: "2026-10-02T08:00:00Z" }]);
      await json(route, { error: { code: "withdrawal_stale", message: "این ثبت در این فاصله تغییر کرده است (نسخهٔ جاری 2).", correlationId: "req-wd2" } }, 409);
    });
    await page.goto(`/?page=settings&settings.tab=withdrawal-log&settings.wdl=${W1}`);
    await page.getByLabel("مبلغ درست (تومان)").fill("0");
    await page.getByLabel("دلیل اصلاح").fill("اصلاح من");
    await page.getByRole("button", { name: "ثبت اصلاح" }).click();
    const dialog = page.getByRole("dialog", { name: `اصلاح برداشت ${CASHIER.name}` });
    await dialog.getByRole("button", { name: "ثبت اصلاح" }).click();
    await expect(dialog.getByText("این ثبت در این فاصله تغییر کرده است")).toBeVisible();
    await dialog.getByRole("button", { name: "انصراف" }).click();
    await expect(page.getByRole("region", { name: `تاریخچهٔ برداشت ${CASHIER.name}` }).getByText("مدیر دیگر").first()).toBeVisible();
    await expect(page.getByLabel("دلیل اصلاح")).toHaveValue("اصلاح من");
  });

  test("برداشت خودِ مدیر فرم اصلاح ندارد", async ({ page, api }) => {
    gmLog(api, { value: detail(item(W1, CASHIER, "900000", "کرایه"), true) });
    await page.goto(`/?page=settings&settings.tab=withdrawal-log&settings.wdl=${W2}`);
    await expect(page.getByText("این برداشت را نمی‌توانید اصلاح کنید.")).toBeVisible();
    await expect(page.getByRole("button", { name: "ثبت اصلاح" })).toHaveCount(0);
  });

  test("بی‌مجوز: دفتر مدیر mount نمی‌شود و درخواستی نمی‌رود؛ برداشت‌های من می‌ماند", async ({ page, api }) => {
    denyWithdrawalOps(api);
    api.handlers.set("GET /withdrawals/mine", route => json(route, { items: [], total: 0, page: 1, pageSize: 20 }));
    await page.goto("/?page=settings&settings.tab=withdrawal-log");
    await expect(page.getByRole("heading", { name: "دسترسی ندارید" })).toBeVisible();
    expect(api.calls.some(c => c.startsWith("GET /withdrawals?") || c.startsWith("GET /withdrawals/5"))).toBe(false);
    await settings(page, "withdrawals", "برداشت‌های من");
    await expect(page.getByRole("heading", { name: "برداشت‌های من", level: 1 })).toBeVisible();
    expect(api.calls.some(c => c.startsWith("GET /withdrawals?"))).toBe(false);
  });

  test("سرور ۴۰۳ می‌دهد (مثلاً نشست PIN): حالت بی‌مجوز، نه خطای سامانه", async ({ page, api }) => {
    api.handlers.set("GET /withdrawals", route => json(route, { error: { code: "branch_forbidden", message: "نشست انسانی معتبر و کامل برای این تصمیم یافت نشد", correlationId: "req-wd3" } }, 403));
    await page.goto("/?page=settings&settings.tab=withdrawal-log");
    await expect(page.getByText("نشست انسانی معتبر و کامل برای این تصمیم یافت نشد")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});

/**
 * شواهد بصری — **API ماک**. در همهٔ پروژه‌ها اجرا می‌شود؛ تصویرهای تحویلی همان
 * ۳۷۵×۸۱۲ / ۷۶۸×۱۰۲۴ / ۱۴۴۰×۹۰۰ هر دو تم‌اند.
 */
const EVIDENCE_HEIGHT: Record<number, number> = { 375: 812, 768: 1024, 1440: 900 };
test.describe("شواهد بصری دفتر برداشت (mock API)", () => {
  test("تصویرهای برداشت‌های من و دفتر مدیر", async ({ page, api }, info) => {
    const width = page.viewportSize()!.width;
    // ارتفاع دستگاه هدف در ۳۷۵/۷۶۸/۱۴۴۰؛ بقیهٔ عرض‌ها همان مسیر را با ارتفاع پروژه می‌رانند (بی Skip).
    await page.setViewportSize({ width, height: EVIDENCE_HEIGHT[width] ?? page.viewportSize()!.height });
    const mine = [item(W1, GM, "2500000", "کرایهٔ پیک برای ارسال سفارش‌های سایت"), item(W2, GM, "0", "ناهار تیم", 2)];
    api.handlers.set("GET /withdrawals/mine", route => json(route, { items: mine, total: 2, page: 1, pageSize: 20 }));
    api.handlers.set(`GET /withdrawals/mine/${W2}`, route => json(route, detail(mine[1]!, false, [
      { version: 1, amount: "450000", reason: "ناهار تیم", note: null, actor: GM, at: "2026-10-01T06:30:00Z" },
      { version: 2, amount: "0", reason: "ناهار تیم", note: "پرداخت از حساب شرکت؛ برداشت نبود", actor: { id: "x", name: "مدیر کل دیگر" }, at: "2026-10-02T08:00:00Z" },
    ])));
    const shot = async (name: string) => {
      await fontsReady(page);
      await page.screenshot({ path: info.outputPath(`mock-${name}.png`), animations: "disabled" });
    };
    await openMine(page);
    await page.getByLabel("مبلغ (تومان)").fill("۱۵۰٬۰۰۰");
    await page.getByLabel("دلیل برداشت").fill("کرایهٔ تاکسی برای تحویل سفارش");
    await shot("own-register-create");
    await page.getByRole("button", { name: "ثبت برداشت" }).click();
    await shot("own-create-confirm");
    await page.getByRole("dialog", { name: "ثبت برداشت" }).getByRole("button", { name: "انصراف" }).click();
    await page.getByLabel("مبلغ (تومان)").fill(""); await page.getByLabel("دلیل برداشت").fill("");
    await page.getByRole("button", { name: /^تاریخچهٔ برداشت/ }).nth(1).click();
    await page.getByRole("heading", { name: "تاریخچهٔ برداشت" }).scrollIntoViewIfNeeded();
    await shot("own-history");

    const rows = [item(W1, CASHIER, "900000", "کرایه"), item(W2, { id: "s2", name: "انباردار با نام بلند برای بررسی چیدمان" }, "12500000", "پیش‌پرداخت", 2)];
    api.handlers.set("GET /withdrawals", route => json(route, { items: rows, total: 47, page: 1, pageSize: 20 }));
    api.handlers.set(`GET /withdrawals/${W1}`, route => json(route, detail(rows[0]!, true)));
    await page.goto("/?page=settings&settings.tab=withdrawal-log");
    await expect(page.getByRole("heading", { name: "دفتر برداشت پرسنل", level: 1 })).toBeVisible();
    await shot("gm-log");
    await page.getByRole("button", { name: new RegExp(`^تاریخچه و اصلاح برداشت ${CASHIER.name}`) }).click();
    await page.getByLabel("مبلغ درست (تومان)").fill("0");
    await page.getByLabel("دلیل اصلاح").fill("ثبت تکراری؛ همان برداشت دیروز");
    await page.getByRole("heading", { name: `برداشت ${CASHIER.name}` }).scrollIntoViewIfNeeded();
    await shot("gm-history-correction");
    await page.getByRole("button", { name: "ثبت اصلاح" }).click();
    await shot("gm-correction-confirm");
  });
});
