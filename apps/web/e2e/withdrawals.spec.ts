/**
 * دفتر برداشت پرسنل در مرورگر (مهاجرت ۰۸۴) — **API ماک** (`MockApi`)؛ قرارداد
 * سرور در `apps/api/test/staff-withdrawal.integration.test.ts` سنجیده می‌شود.
 *
 * ادعاها: ثبت از عمل ایمن با شناسهٔ عملیات و بی شناسهٔ مالک؛ نتیجهٔ نامعلوم
 * «ارسال دوباره» ندارد و فقط با همان کلید بررسی می‌شود؛ صفر در ثبت رد و در
 * اصلاح مدیر مجاز؛ تعارض نسخه پیام سرور را نشان می‌دهد و تاریخچه را تازه
 * می‌کند؛ بی‌مجوز هیچ درخواستی به دفتر مدیر نمی‌فرستد؛ مدیر مجاز ثبت خودش را
 * هم اصلاح می‌کند. تصویرهای شواهد با API ماک‌اند و در نامشان «mock» دارند.
 */
import { test, expect, settings, fontsReady, type MockApi } from "./fixtures";
import type { Page, Route } from "@playwright/test";
import type { WithdrawalDetail, WithdrawalItem } from "../src/lib/withdrawals";

const ME = "22222222-2222-4222-8222-222222222222";
const CASHIER = { id: "44444444-4444-4444-8444-444444444444", name: "صندوق‌دار آزمایشی" };
const GM = { id: ME, name: "مدیر آزمایشی" };
const W1 = "55555555-5555-4555-8555-555555555551";
const W2 = "55555555-5555-4555-8555-555555555552";

test.beforeEach(async ({ api }) => { api.defaults["GET /withdrawals/owners"] = { owners: [CASHIER, GM] }; });

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

test("bulk settlement selects all filtered versions across pages, reviews exact total and keeps a lost-response key", async ({ page, api }) => {
  const one=item(W1,CASHIER,"101","ثبت اول"),two=item(W2,CASHIER,"102","ثبت دوم");
  api.defaults["GET /withdrawals/owners"]={owners:[CASHIER,GM]};
  api.handlers.set("GET /withdrawals",route=>json(route,{items:[one],total:21,page:1,pageSize:20}));
  let selectedOwner="",posts=0,key="",recorded=false;
  api.handlers.set("GET /withdrawals/selection",async(route,url)=>{
    selectedOwner=url.searchParams.get("ownerId") ?? "";
    await json(route,{items:[one,two]});
  });
  api.handlers.set("POST /withdrawals/settlements",async route=>{
    posts++; key=route.request().headers()["idempotency-key"]!;
    expect(route.request().postDataJSON()).toEqual({items:[{id:W1,expectedVersion:1},{id:W2,expectedVersion:1}],note:"تسویهٔ دوره"});
    recorded=true;
    api.handlers.set(`GET /withdrawals/settlements/by-key/${key}`,r=>json(r,{status:"recorded",count:2}));
    await json(route,{error:{code:"response_lost",message:"پاسخ قطع شد"}},502);
  });
  await page.goto("/?page=settings&settings.tab=withdrawal-log");
  await page.getByLabel("کاربر برداشت",{exact:true}).selectOption(CASHIER.id);
  await page.getByLabel("وضعیت تسویه",{exact:true}).selectOption("open");
  await page.getByRole("button",{name:"انتخاب همهٔ تسویه‌نشده‌های این فیلتر",exact:true}).click();
  expect(selectedOwner).toBe(CASHIER.id);
  await page.getByLabel("یادداشت تسویه",{exact:true}).fill("تسویهٔ دوره");
  await page.getByRole("button",{name:"تسویهٔ انتخاب‌ها",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"تأیید تسویهٔ برداشت‌های انتخاب‌شده"});
  await expect(dialog).toContainText("20٫3");
  await expect(dialog).toContainText(CASHIER.name);
  expect(posts).toBe(0);
  await dialog.getByRole("button",{name:"تأیید و ثبت تسویه",exact:true}).click();
  await expect.poll(()=>posts).toBe(1); expect(recorded).toBe(true);
  await page.reload();
  await expect(page.getByLabel("یادداشت تسویه",{exact:true})).toBeDisabled();
  await page.getByRole("button",{name:"نتیجه نامعلوم؛ بررسی وضعیت",exact:true}).click();
  await page.getByRole("button",{name:"بررسی وضعیت",exact:true}).click();
  await expect(page.getByRole("status").filter({hasText:"انتخاب‌ها تسویه شدند"})).toBeVisible();
  expect(posts).toBe(1);
});

test("bulk settlement conflict clears selection, while settled rows remain visible and cannot be selected", async ({page,api})=>{
  let row=item(W1,CASHIER,"101","ثبت قدیمی");
  const settled={...item(W2,GM,"200","تسویه قبلی"),settledAt:"2026-10-03T03:00:00Z",settledBy:GM.name};
  api.defaults["GET /withdrawals/owners"]={owners:[CASHIER,GM]};
  api.handlers.set("GET /withdrawals",route=>json(route,{items:[row,settled],total:2,page:1,pageSize:20}));
  api.handlers.set("POST /withdrawals/settlements",async route=>{
    row={...row,version:2,amount:"102"};
    await json(route,{error:{code:"withdrawal_stale",message:"انتخاب قدیمی است؛ دوباره انتخاب کنید"}},409);
  });
  await page.goto("/?page=settings&settings.tab=withdrawal-log");
  await expect(page.getByRole("checkbox",{name:`انتخاب برداشت ${GM.name}، تسویه قبلی`})).toBeDisabled();
  await page.getByRole("button",{name:"انتخاب تسویه‌نشده‌های این صفحه",exact:true}).click();
  await page.getByLabel("یادداشت تسویه",{exact:true}).fill("تسویه");
  await page.getByRole("button",{name:"تسویهٔ انتخاب‌ها",exact:true}).click();
  await page.getByRole("button",{name:"تأیید و ثبت تسویه",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("انتخاب قدیمی است");
  await expect(page.getByRole("checkbox",{name:`انتخاب برداشت ${CASHIER.name}، ثبت قدیمی`})).not.toBeChecked();
  expect(api.calls.filter(c=>c==="POST /withdrawals/settlements")).toHaveLength(1);
});

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

  test("نتیجهٔ نامعلوم پس از reload: همان کلید بازیابی می‌شود و ثبت خودکار نداریم", async ({ page, api }) => {
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
    await page.reload();
    await expect(page.getByLabel("مبلغ (تومان)")).toHaveValue("20000");
    await expect(page.getByLabel("دلیل برداشت")).toHaveValue("قسط");
    await expect(page.getByLabel("مبلغ (تومان)")).toBeDisabled();
    expect(keys).toHaveLength(1);
    await page.getByRole("button", { name: "نتیجه نامعلوم؛ بررسی وضعیت" }).click();
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

  test("بازیابی ثبت پیدا نشده: فقط تأیید صریح با همان بدنه و شناسه", async ({ page, api }) => {
    const posts: { body: unknown; key: string }[] = [];
    api.handlers.set("GET /withdrawals/mine", route => json(route, { items: [], total: 0, page: 1, pageSize: 20 }));
    api.handlers.set("POST /withdrawals", async route => {
      posts.push({ body: route.request().postDataJSON(), key: route.request().headers()["idempotency-key"]! });
      await json(route, posts.length === 1 ? { error: { code: "internal", message: "نامعلوم" } } : { replayed: false }, posts.length === 1 ? 503 : 201);
    });
    await openMine(page);
    await page.getByLabel("مبلغ (تومان)").fill("123");
    await page.getByLabel("دلیل برداشت").fill("بدنه ثابت");
    await page.getByRole("button", { name: "ثبت برداشت" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "ثبت برداشت" }).click();
    await expect(page.getByRole("dialog").getByText("نتیجه نامعلوم")).toBeVisible();
    await page.reload();
    api.handlers.set(`GET /withdrawals/mine/by-key/${posts[0]!.key}`, route => json(route, { status: "not_found" }));
    await page.getByRole("button", { name: "نتیجه نامعلوم؛ بررسی وضعیت" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "بررسی وضعیت" }).click();
    expect(posts).toHaveLength(1);
    await page.getByRole("dialog").getByRole("button", { name: "ثبت برداشت" }).click();
    await expect(page.getByRole("status").filter({ hasText: "برداشت ثبت شد." })).toBeVisible();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
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
    api.handlers.set(`GET /withdrawals/${W2}`, route => json(route, detail(item(W2, GM, "300000", "برداشت مدیر"), true)));
  }

  test("fractional withdrawal money stays exact in preview, confirmation, lists and both histories", async ({ page, api }) => {
    const current = { value: detail(item(W1, GM, "1010", "کرایه"), true) };
    gmLog(api, current);
    api.handlers.set("GET /withdrawals/mine", route => json(route, { items: [current.value], total: 1, page: 1, pageSize: 20 }));
    api.handlers.set(`GET /withdrawals/mine/${W1}`, route => json(route, current.value));
    api.handlers.set(`POST /withdrawals/${W1}/corrections`, async route => {
      const body = route.request().postDataJSON();
      expect(body.amount).toBe("1011");
      current.value = detail(item(W1, GM, body.amount, body.reason, 2), true, [...current.value.history,
        { version: 2, amount: body.amount, reason: body.reason, note: body.note, actor: GM, at: "2026-10-02T08:00:00Z" }]);
      await json(route, { appliedVersion: 2, withdrawal: current.value, replayed: false });
    });
    await page.goto(`/?page=settings&settings.tab=withdrawal-log&settings.wdl=${W1}`);
    await page.getByLabel("مبلغ درست (تومان)").fill("101.1");
    await page.getByLabel("دلیل اصلاح").fill("یک ریال بیشتر");
    await expect(page.locator(".field-hint").filter({ hasText: "ثبت می‌شود:" }).locator(".money-digits")).toHaveText("101٫1");
    await page.getByRole("button", { name: "ثبت اصلاح" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator(".settings-facts > div").filter({ hasText: "مبلغ فعلی" }).locator(".money-digits")).toHaveText("101");
    await expect(dialog.locator(".settings-facts > div").filter({ hasText: "مبلغ اصلاح‌شده" }).locator(".money-digits")).toHaveText("101٫1");
    await dialog.getByRole("button", { name: "ثبت اصلاح" }).click();
    await expect(page.getByRole("status").filter({ hasText: "اصلاح ثبت شد" })).toBeVisible();
    await expect(page.getByRole("region", { name: "دفتر برداشت پرسنل", exact: true }).getByText("101٫1", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: `تاریخچهٔ برداشت ${GM.name}`, exact: true }).getByText("101٫1", { exact: true })).toBeVisible();
    await page.goto(`/?page=settings&settings.tab=withdrawals&settings.wd=${W1}`);
    await expect(page.getByRole("region", { name: "برداشت‌های من", exact: true }).getByText("101٫1", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "تاریخچهٔ نسخه‌های این برداشت", exact: true }).getByText("101٫1", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "تاریخچهٔ برداشت", exact: true }).locator(".section-description .money-digits")).toHaveText("101٫1");
  });

  test("اصلاح دلیل یک ریال را حفظ می‌کند؛ نتیجهٔ نامعلوم پس از reload قابل بررسی است", async ({ page, api }) => {
    const current = { value: detail(item(W1, CASHIER, "1", "قدیم"), true) };
    gmLog(api, current);
    const posts: { amount: string; reason: string; note: string }[] = [];
    api.handlers.set(`POST /withdrawals/${W1}/corrections`, async route => {
      const body = route.request().postDataJSON();
      posts.push(body);
      current.value = detail(item(W1, CASHIER, body.amount, body.reason, 2), true, [...current.value.history,
        { version: 2, amount: body.amount, reason: body.reason, note: body.note, actor: GM, at: "2026-10-02T08:00:00Z" }]);
      await json(route, { error: { code: "internal", message: "نامعلوم" } }, 503);
    });
    await page.goto(`/?page=settings&settings.tab=withdrawal-log&settings.wdl=${W1}`);
    await expect(page.getByLabel("مبلغ درست (تومان)")).toHaveValue("0.1");
    await page.getByLabel("دلیل برداشت").fill("جدید");
    await page.getByLabel("دلیل اصلاح").fill("فقط دلیل");
    await page.getByRole("button", { name: "ثبت اصلاح" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "ثبت اصلاح" }).click();
    await expect(page.getByRole("dialog").getByText("نتیجه نامعلوم")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("مبلغ درست (تومان)")).toHaveValue("0.1");
    await expect(page.getByLabel("دلیل اصلاح")).toHaveValue("فقط دلیل");
    await expect(page.getByLabel("دلیل برداشت")).toBeDisabled();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.amount).toBe("1");
    await page.getByRole("button", { name: "نتیجه نامعلوم؛ بررسی وضعیت" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "بررسی وضعیت" }).click();
    await expect(page.getByRole("status").filter({ hasText: "بررسی شد: اصلاح پیش‌تر ثبت شده بود." })).toBeVisible();
    expect(posts).toHaveLength(1);
  });

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

  test("مدیر مجاز برای برداشت خودش هم فرم اصلاح دارد", async ({ page, api }) => {
    gmLog(api, { value: detail(item(W1, CASHIER, "900000", "کرایه"), true) });
    await page.goto(`/?page=settings&settings.tab=withdrawal-log&settings.wdl=${W2}`);
    await expect(page.getByLabel("مبلغ درست (تومان)")).toHaveValue("30000");
    await page.getByLabel("دلیل برداشت").fill("دلیل درست مدیر");
    await page.getByLabel("دلیل اصلاح").fill("اصلاح دلیل");
    await expect(page.getByRole("button", { name: "ثبت اصلاح" })).toBeEnabled();
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
    // رویداد `close` مودال یک Task جداست و فوکوس را به دکمهٔ «ثبت برداشت» برمی‌گرداند
    // (use-modal.ts). اگر fill پیش از آن برسد، «انتخاب همه» در فیلد است ولی Delete به
    // دکمه می‌خورد: مبلغ می‌ماند، نگهبان پیش‌نویس روشن می‌ماند و کلیک «تاریخچه»
    // confirm می‌گیرد که Playwright رد می‌کند (CI پربار، chromium-dark-768/light-1024).
    // شنوندهٔ ما پس از شنوندهٔ React روی همان عنصر ثبت شده، پس پس از برگشت فوکوس اجرا می‌شود.
    const confirmDialog = page.getByRole("dialog", { name: "ثبت برداشت" });
    const closed = confirmDialog.evaluate(d => new Promise<void>(done => d.addEventListener("close", () => done(), { once: true })));
    await confirmDialog.getByRole("button", { name: "انصراف" }).click();
    await closed;
    await page.getByLabel("مبلغ (تومان)").fill(""); await page.getByLabel("دلیل برداشت").fill("");
    await expect(page.getByLabel("مبلغ (تومان)")).toHaveValue("");
    await expect(page.getByLabel("دلیل برداشت")).toHaveValue("");
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
