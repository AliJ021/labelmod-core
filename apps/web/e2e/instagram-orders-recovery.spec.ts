/**
 * «سفارش اینستاگرام» — پاسخ گم‌شده، مجوز هر کار و ویرایش سرآیند، در مرورگر واقعی با سرور ماکِ حالت‌دار.
 *
 * سرور ماک مثل سرور واقعی با `Idempotency-Key` رفتار می‌کند: کلید دیده‌شده اثر را دوباره نمی‌گذارد و همان
 * پاسخ را می‌دهد؛ درخواست **بی کلید** هر بار اثر می‌گذارد. پس «یک بار ثبت شد» از خودِ وضعیت ماک خوانده
 * می‌شود، نه از ادعای صفحه.
 *
 * - افزودن قلم: POST اثر می‌گذارد و پاسخ گم می‌شود؛ خواندن بعدی هم شکست می‌خورد. صفحه عملیات را معلق نگه
 *   می‌دارد، افزودن تازه را می‌بندد، پس از بارگذاری دوباره و در تب دوم هم همان را نشان می‌دهد، و تلاش دوباره
 *   **همان** کلید و بدنه را می‌برد → تعداد یک بار بالا رفته است. (کنترل منفی: کلید تازه دو بار ثبت می‌کرد.)
 * - ساخت سفارش: همان، پس از بارگذاری دوباره.
 * - مجوز: فقط «مدیریت» فرم تأیید واریز را ندارد؛ فقط «تأیید واریز» نه سفارش تازه دارد نه رزرو و نه سبد؛
 *   «در حال بررسی» و «نامعلوم» هیچ کاری را نشان نمی‌دهند.
 * - سرآیند: نسخهٔ دیده‌شده و کلید می‌روند؛ نسخهٔ کهنه ۴۰۹ است و عملیات معلق نمی‌ماند.
 */
import { test, expect, type MockApi } from "./fixtures";
import type { Page, Route } from "@playwright/test";

const ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const NEW_ID = "dddddddd-4444-4444-8444-dddddddddddd";
const VAR = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
const ACCOUNT = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

function detail(over: Record<string, unknown> = {}) {
  return {
    id: ID, orderNo: "IG-000200", status: "draft", paymentState: "none", paymentNote: null,
    shippingState: "not_started", trackingCode: null, version: 3, reservedUntil: null,
    cancelReason: null, createdAt: "2026-10-23T08:00:00.000Z", updatedAt: "2026-10-23T08:30:00.000Z",
    branch: { id: "b1", name: "شعبه آزمایشی" }, warehouse: { id: "w1", name: "انبار آزمایشی" },
    customer: { id: "c1", name: "مشتری دایرکت", mobile: "09121234567", instagramUsername: "shop.buyer" },
    shipping: { address: "تهران، خیابان آزمایشی ۱", method: "پست پیشتاز" },
    receivingAccount: null,
    invoice: { id: "i1", number: null, status: "draft", gross: "1000000", discount: "0", shipping: "50000", payable: "1050000" },
    lines: [], holds: [], payment: null, returns: [], similarOpen: [],
    ...over,
  };
}
const line = (qty: number) => ({ id: "ffffffff-6666-4666-8666-ffffffffffff", variationId: VAR, sku: "TR-1405-NAVY-XL", product: "شلوار پارچه‌ای",
  color: "سرمه‌ای", size: "XL", qty, unitPrice: "1000000", discountAmount: "0", netAmount: String(1000000 * qty), available: "5",
  sync: { state: "none", at: null, error: null } });
const accounts = { accounts: [{ id: ACCOUNT, code: "1102", name: "بانک آزمایشی", bankName: "بانک", accountNo: "6037-0000" }] };
const emptyPage = { page: 1, perPage: 20, total: 0, pages: 1, orders: [] };

/** سرور ماک حالت‌دار با Idempotency واقعی: کلید دیده‌شده Replay است، بی کلید هر بار اثر. */
function server(api: MockApi, start: Record<string, unknown>) {
  const state = { order: detail(start), qty: 0, applied: 0, seen: new Map<string, unknown>(), requests: [] as { path: string; key: string | undefined; body: unknown }[],
    failNextPost: false, failNextGet: 0 };
  const view = () => ({ ...state.order, lines: state.qty > 0 ? [line(state.qty)] : [] });
  api.handlers.set("GET /instagram-orders", async route => { await route.fulfill({ json: emptyPage }); });
  api.handlers.set("GET /instagram-orders/accounts", async route => { await route.fulfill({ json: accounts }); });
  api.handlers.set(`GET /instagram-orders/${ID}`, async route => {
    if (state.failNextGet > 0) { state.failNextGet--; await route.abort("connectionreset"); return; }
    await route.fulfill({ json: view() });
  });
  api.handlers.set("GET /pos/products", async route => { await route.fulfill({ json: { products: [], exactVariationId: VAR } }); });
  const mutate = (apply: (body: Record<string, unknown>) => void) => async (route: Route) => {
    const key = route.request().headers()["idempotency-key"];
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    state.requests.push({ path: new URL(route.request().url()).pathname, key, body });
    if (!key || !state.seen.has(key)) { apply(body); state.applied++; if (key) state.seen.set(key, true); }
    if (state.failNextPost) { state.failNextPost = false; await route.abort("connectionreset"); return; }
    await route.fulfill({ status: 200, json: { ...view(), replayed: false } });
  };
  api.handlers.set(`POST /instagram-orders/${ID}/lines`, mutate(b => { state.qty += Number(b.qty); }));
  return state;
}

async function addOne(page: Page) {
  const entry = page.getByRole("region", { name: "افزودن کالا" }).getByRole("searchbox");
  await entry.fill("TR-1405"); await entry.press("Enter");
}
const banner = (page: Page) => page.getByRole("status").filter({ hasText: "هنوز قطعی نیست" });

test.describe("سفارش اینستاگرام: عملیات ماندگار، مجوز هر کار، ویرایش سرآیند", () => {
  test("lost add-line response and failed read: pending survives reload and a second tab, blocks new edits, retry sends the same key once", async ({ page, api }) => {
    const s = server(api, {});
    await page.goto(`/?page=instagram-orders&ig.order=${ID}`);
    const panel = page.getByRole("region", { name: "سفارش IG-000200" });
    await expect(panel).toContainText("هنوز قلمی ندارد");

    s.failNextPost = true; s.failNextGet = 1;
    await addOne(page);
    await expect(banner(page)).toContainText("افزودن کالا (تعداد 1)");
    expect(s.qty, "سرور اثر را ثبت کرد").toBe(1);
    expect(s.requests).toHaveLength(1);
    const first = s.requests[0]!;
    expect(first.key).toMatch(/^[0-9a-f-]{36}$/);
    // ویرایش تازه بسته است: اسکن دوباره چیزی نمی‌فرستد.
    // (نمای کهنه می‌ماند چون خواندن هم شکست خورد؛ سبد هنوز خالی دیده می‌شود.)
    await expect(page.getByRole("region", { name: "افزودن کالا" }).getByRole("searchbox")).toHaveAttribute("readonly", "");
    await expect(panel.getByLabel("تعداد قلم تازه")).toBeDisabled();

    // بارگذاری دوباره: همان عملیات معلق، از ذخیرهٔ ماندگار.
    await page.reload();
    await expect(banner(page)).toBeVisible();
    // تب دوم همان کاربر: همان قفل.
    const second = await page.context().newPage();
    await api.install(second);
    await second.goto(`/?page=instagram-orders&ig.order=${ID}`);
    await expect(banner(second)).toBeVisible();
    await expect(second.getByRole("region", { name: "سفارش IG-000200" }).getByRole("button", { name: "رزرو موجودی" })).toBeDisabled();

    await page.getByRole("button", { name: "بررسی و تلاش دوبارهٔ همان عملیات" }).click();
    await expect(banner(page)).toHaveCount(0);
    await expect(banner(second), "تب دوم از رویداد storage باز می‌شود").toHaveCount(0);
    expect(s.requests).toHaveLength(2);
    expect(s.requests[1]).toEqual(first);
    expect(s.qty, "یک بار، نه دو بار").toBe(1);
    expect(s.applied).toBe(1);
    await expect(panel.getByRole("textbox", { name: "تعداد شلوار پارچه‌ای" })).toHaveValue("1");
    // پس از روشن‌شدن، افزودن تازه کلید تازه می‌گیرد و واقعاً اثر می‌گذارد (کنترل منفی Replay).
    await addOne(page);
    await expect.poll(() => s.qty).toBe(2);
    expect(s.requests[2]!.key).not.toBe(first.key);
    await second.close();
  });

  test("a retry refused by permission or rate limit keeps the original key pending; another order stays editable; access restored replays once", async ({ page, api }) => {
    const s = server(api, {});
    const OTHER = "99999999-9999-4999-8999-999999999999";
    api.handlers.set(`GET /instagram-orders/${OTHER}`, async route => { await route.fulfill({ json: { ...detail({ id: OTHER, orderNo: "IG-000300" }), lines: [] } }); });
    await page.goto(`/?page=instagram-orders&ig.order=${ID}`);
    await expect(page.getByRole("region", { name: "سفارش IG-000200" })).toContainText("هنوز قلمی ندارد");
    s.failNextPost = true; s.failNextGet = 1;
    await addOne(page);
    await expect(banner(page)).toBeVisible();
    const first = s.requests[0]!;
    expect(s.qty).toBe(1);

    // تلاش دوباره به دروازهٔ پیش از کلید می‌خورد: مجوز گرفته شد، بعد محدودیت نرخ.
    const denials = [{ status: 403, code: "forbidden", message: "اجازه ندارید" }, { status: 429, code: "rate_limited", message: "درخواست زیاد" }];
    for (const d of denials) {
      api.handlers.set(`POST /instagram-orders/${ID}/lines`, async route => {
        s.requests.push({ path: "lines", key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
        await route.fulfill({ status: d.status, json: { error: { code: d.code, message: d.message } } });
      });
      await page.getByRole("button", { name: "بررسی و تلاش دوبارهٔ همان عملیات" }).click();
      await expect(page.getByRole("alert")).toContainText("هنوز قطعی نیست");
      await expect(banner(page), `${d.status}: عملیات معلق با کلید اصلی می‌ماند`).toBeVisible();
      expect(s.requests.at(-1)!.key).toBe(first.key);
    }
    // بارگذاری دوباره: هنوز همان. بنر از ذخیرهٔ محلی است و پیش از پاسخ فهرست و جزئیات دیده می‌شود؛
    // goto زودتر همان درخواست‌های در راه را قطع می‌کند و WebKit قطعشان را «خطای صفحه» گزارش می‌کند
    // («due to access control checks»، webkit-dark-1024، run 40291975215). پس منتظر **پاسخ** هر دو.
    const settled = (orderId: string) => Promise.all([
      page.waitForResponse(r => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/instagram-orders"),
      page.waitForResponse(r => r.request().method() === "GET" && new URL(r.url()).pathname === `/api/instagram-orders/${orderId}`),
    ]);
    const afterReload = settled(ID);
    await page.reload();
    await expect(banner(page)).toBeVisible();
    await afterReload;
    // سفارش دیگر قفل نیست: قفل به‌ازای هر سفارش است.
    const afterOther = settled(OTHER);
    await page.goto(`/?page=instagram-orders&ig.order=${OTHER}`);
    const other = page.getByRole("region", { name: "سفارش IG-000300" });
    await expect(other).toContainText("هنوز قلمی ندارد");
    await expect(banner(page)).toHaveCount(0);
    await expect(other.getByLabel("تعداد قلم تازه")).toBeEnabled();
    await afterOther;

    // دسترسی برگشت: همان کلید Replay می‌گیرد و اثر یک بار است.
    api.handlers.set(`POST /instagram-orders/${ID}/lines`, async route => {
      const key = route.request().headers()["idempotency-key"];
      s.requests.push({ path: "lines", key, body: route.request().postDataJSON() });
      if (!key || !s.seen.has(key)) { s.qty += 1; s.applied++; }
      await route.fulfill({ json: { ...s.order, lines: [line(s.qty)] } });
    });
    await page.goto(`/?page=instagram-orders&ig.order=${ID}`);
    await page.getByRole("button", { name: "بررسی و تلاش دوبارهٔ همان عملیات" }).click();
    await expect(banner(page)).toHaveCount(0);
    expect(s.requests.at(-1)!.key).toBe(first.key);
    expect(s.qty, "یک بار").toBe(1);
    expect(s.applied).toBe(1);
  });

  test("lost create response: after reload the same create is retried with the same key and opens the one created order", async ({ page, api }) => {
    const s = server(api, {});
    const created: string[] = [];
    let lose = true;
    api.handlers.set("POST /instagram-orders", async route => {
      const key = route.request().headers()["idempotency-key"]!;
      s.requests.push({ path: "/instagram-orders", key, body: route.request().postDataJSON() });
      if (!created.includes(key)) created.push(key);
      if (lose) { lose = false; await route.abort("connectionreset"); return; }
      await route.fulfill({ status: 200, json: { ...detail({ id: NEW_ID, orderNo: "IG-000201" }), replayed: true } });
    });
    api.handlers.set(`GET /instagram-orders/${NEW_ID}`, async route => { await route.fulfill({ json: detail({ id: NEW_ID, orderNo: "IG-000201" }) }); });
    await page.goto("/?page=instagram-orders&ig.new=1");
    const form = page.getByRole("form", { name: "سفارش تازه" });
    await form.getByLabel("موبایل مشتری").fill("09121112233");
    await form.getByLabel("نشانی ارسال").fill("تهران");
    await form.getByRole("button", { name: "ثبت پیش‌نویس" }).click();
    await expect(banner(page)).toContainText("09121112233");
    await expect(form.getByRole("button", { name: "ثبت پیش‌نویس" })).toBeDisabled();

    await page.goto("/?page=instagram-orders");
    await expect(banner(page), "ثبت معلق بی پارامتر نشانی هم دیده می‌شود").toBeVisible();
    await page.getByRole("button", { name: "بررسی و تلاش دوبارهٔ همان ثبت" }).click();
    await expect(page.getByRole("region", { name: "سفارش IG-000201" })).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
    expect(s.requests).toHaveLength(2);
    expect(s.requests[0]!.key, "ساخت سفارش هم کلید دارد").toMatch(/^[0-9a-f-]{36}$/);
    expect(s.requests[1]).toEqual(s.requests[0]);
    expect(created, "یک سفارش").toHaveLength(1);
  });

  test("each action follows its own permission: manage-only has no verification form; verify-only has no new order, reserve or cart", async ({ page, api }) => {
    server(api, { status: "reserved", reservedUntil: "2026-10-24T10:00:00.000Z" });
    const as = (allowed: string) => api.handlers.set("GET /auth/can", async (route, url) => {
      const op = url.searchParams.get("operation") ?? "";
      await route.fulfill({ json: { verdict: !op.startsWith("instagram.") || op === allowed ? "allow" : "deny", approver: null, reason: "" } });
    });
    as("instagram.order.manage");
    await page.goto(`/?page=instagram-orders&ig.order=${ID}`);
    const panel = page.getByRole("region", { name: "سفارش IG-000200" });
    await expect(panel.getByRole("button", { name: "برگشت به پیش‌نویس (ویرایش سبد)" })).toBeVisible();
    await expect(page.getByRole("button", { name: "سفارش تازه" })).toBeVisible();
    await expect(panel.getByRole("region", { name: "تأیید واریز" }), "بی مجوز تأیید، فرمش نیست").toHaveCount(0);

    as("instagram.payment.verify");
    await page.reload();
    await expect(panel.getByRole("region", { name: "تأیید واریز" })).toBeVisible();
    await expect(page.getByRole("button", { name: "سفارش تازه" })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "برگشت به پیش‌نویس (ویرایش سبد)" })).toHaveCount(0);
    await expect(panel.getByRole("region", { name: "وضعیت واریز پیش از تأیید" })).toHaveCount(0);
    await expect(panel.getByRole("region", { name: "لغو سفارش" })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: /ویرایش سرآیند/ })).toHaveCount(0);
  });

  test("verify-only on a draft: no reserve and no cart editing", async ({ page, api }) => {
    server(api, {});
    api.handlers.set("GET /auth/can", async (route, url) => {
      const op = url.searchParams.get("operation") ?? "";
      await route.fulfill({ json: { verdict: op === "instagram.order.manage" ? "deny" : "allow", approver: null, reason: "" } });
    });
    await page.goto(`/?page=instagram-orders&ig.order=${ID}`);
    const panel = page.getByRole("region", { name: "سفارش IG-000200" });
    await expect(panel).toContainText("قلمی ندارد");
    await expect(panel.getByRole("button", { name: "رزرو موجودی" })).toHaveCount(0);
    await expect(panel.getByRole("region", { name: "افزودن کالا" })).toHaveCount(0);
  });

  test("while checking or when the check fails, no action is offered; retry asks again", async ({ page, api }) => {
    server(api, { status: "reserved" });
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let fail = true;
    api.handlers.set("GET /auth/can", async (route, url) => {
      const op = url.searchParams.get("operation") ?? "";
      if (op === "instagram.payment.verify") { await gate; }
      if (op === "instagram.order.manage" && fail) { await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "x" } } }); return; }
      await route.fulfill({ json: { verdict: "allow", approver: null, reason: "" } });
    });
    await page.goto(`/?page=instagram-orders&ig.order=${ID}`);
    const panel = page.getByRole("region", { name: "سفارش IG-000200" });
    await expect(panel).toContainText("در حال بررسی دسترسی تأیید واریز");
    await expect(panel.getByRole("region", { name: "تأیید واریز" })).toHaveCount(0);
    release();
    await expect(panel.getByRole("region", { name: "تأیید واریز" })).toBeVisible();
    await expect(panel).toContainText("دسترسی ویرایش سفارش بررسی نشد");
    await expect(panel.getByRole("button", { name: "برگشت به پیش‌نویس (ویرایش سبد)" }), "نامعلوم مجاز نیست").toHaveCount(0);
    fail = false;
    await panel.getByRole("button", { name: "بررسی دوباره" }).click();
    await expect(panel.getByRole("button", { name: "برگشت به پیش‌نویس (ویرایش سبد)" })).toBeVisible();
  });

  test("draft header edit sends the seen version with a key; a stale version is a clear 409 and leaves nothing pending", async ({ page, api }) => {
    const s = server(api, {});
    let stale = false;
    api.handlers.set(`PATCH /instagram-orders/${ID}`, async route => {
      const key = route.request().headers()["idempotency-key"];
      const body = route.request().postDataJSON() as Record<string, unknown>;
      s.requests.push({ path: "patch", key, body });
      if (stale) { await route.fulfill({ status: 409, json: { error: { code: "stale_version", message: "سفارش پس از دیدن شما تغییر کرده است." } } }); return; }
      s.order = { ...s.order, version: 4, shipping: { address: String(body.shipAddress), method: String(body.shipMethod) } };
      await route.fulfill({ json: { ...s.order, lines: [] } });
    });
    await page.goto(`/?page=instagram-orders&ig.order=${ID}`);
    const panel = page.getByRole("region", { name: "سفارش IG-000200" });
    await panel.getByRole("button", { name: /ویرایش سرآیند/ }).click();
    const form = panel.getByRole("form", { name: "فرم ویرایش سرآیند" });
    // نمایش گروه‌بندی‌شده (AmountInput)؛ بدنه همان ریال بی‌جداکننده است (پایین‌تر).
    await expect(form.getByLabel("کرایهٔ دریافتی (تومان)")).toHaveValue("5,000");
    await form.getByLabel("نشانی ارسال").fill("اصفهان، خیابان تازه");
    await form.getByRole("button", { name: "ثبت سرآیند" }).click();
    // نه متن خودِ کادر: فرم بسته شده و واقعیت «نشانی ارسال» از پاسخ سرور است.
    await expect(form).toHaveCount(0);
    await expect(panel.getByRole("definition").filter({ hasText: "اصفهان، خیابان تازه" })).toHaveCount(1);
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.requests[0]!.body).toMatchObject({ version: 3, shipAddress: "اصفهان، خیابان تازه", shippingAmount: "50000", receivingAccountId: null });

    stale = true;
    await panel.getByRole("button", { name: /ویرایش سرآیند/ }).click();
    await form.getByLabel("روش ارسال").fill("پیک");
    await form.getByRole("button", { name: "ثبت سرآیند" }).click();
    await expect(panel.getByRole("alert")).toContainText("تغییر کرده است");
    expect(s.requests).toHaveLength(2);
    expect(s.requests[1]!.body).toMatchObject({ version: 4 });
    await expect(banner(page), "رد قطعی عملیات معلق نمی‌سازد").toHaveCount(0);
    // رد، فرم را نمی‌بندد و ورودی را نگه می‌دارد.
    await expect(form.getByLabel("روش ارسال")).toHaveValue("پیک");
  });

  test("money fields group thousands, accept Persian digits and keep the exact rial in the request", async ({ page, api }) => {
    const s = server(api, { version: 7 });
    api.handlers.set(`PATCH /instagram-orders/${ID}`, async route => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      s.requests.push({ path: "patch", key: route.request().headers()["idempotency-key"], body });
      await route.fulfill({ json: { ...s.order, version: 8, lines: [] } });
    });
    await page.goto(`/?page=instagram-orders&ig.order=${ID}`);
    const panel = page.getByRole("region", { name: "سفارش IG-000200" });
    await panel.getByRole("button", { name: /ویرایش سرآیند/ }).click();
    const form = panel.getByRole("form", { name: "فرم ویرایش سرآیند" });
    const shipping = form.getByLabel("کرایهٔ دریافتی (تومان)");
    await shipping.fill("۱۲۳۴۵٫۶");
    await expect(shipping, "رقم فارسی لاتین و هزارگان جدا می‌شود؛ ممیز فارسی می‌ماند و رقم اعشار همان ریال است").toHaveValue("12,345٫6");
    await form.getByRole("button", { name: "ثبت سرآیند" }).click();
    await expect(form).toHaveCount(0);
    const patch = s.requests.find(r => r.path === "patch")!;
    expect(patch.body).toMatchObject({ shippingAmount: "123456" });
  });

  test("header form keeps its own base version: a refresh under an open form exposes the conflict and never sends stale values with the newer version", async ({ page, api }) => {
    const s = server(api, { version: 7 });
    api.handlers.set(`PATCH /instagram-orders/${ID}`, async route => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      s.requests.push({ path: "patch", key: route.request().headers()["idempotency-key"], body });
      // مثل سرور واقعی: نسخهٔ کهنه ۴۰۹.
      if (body.version !== s.order.version) { await route.fulfill({ status: 409, json: { error: { code: "stale_version", message: "سفارش پس از دیدن شما تغییر کرده است." } } }); return; }
      s.order = { ...s.order, version: s.order.version + 1, shipping: { address: String(body.shipAddress), method: String(body.shipMethod) } };
      await route.fulfill({ json: { ...s.order, lines: [] } });
    });
    await page.goto(`/?page=instagram-orders&ig.order=${ID}`);
    const panel = page.getByRole("region", { name: "سفارش IG-000200" });
    await panel.getByRole("button", { name: /ویرایش سرآیند/ }).click();
    const form = panel.getByRole("form", { name: "فرم ویرایش سرآیند" });
    await form.getByLabel("روش ارسال").fill("پیک");

    // اپراتور دیگر نشانی را اصلاح می‌کند (نسخهٔ ۸) و این اپراتور «به‌روزرسانی» می‌زند؛ فرم باز می‌ماند.
    s.order = { ...s.order, version: 8, shipping: { address: "مشهد، نشانی اصلاح‌شده", method: "پست پیشتاز" } };
    await panel.getByRole("button", { name: "به‌روزرسانی" }).click();
    await expect(panel.getByRole("definition").filter({ hasText: "مشهد، نشانی اصلاح‌شده" })).toHaveCount(1);
    const conflict = panel.getByRole("alert").filter({ hasText: "تعارض ویرایش" });
    await expect(conflict).toContainText("7");
    await expect(conflict).toContainText("8");
    // ورودی کاربر و مقدار پایه دست نخورده؛ مقدار تازهٔ سرور کنار میدان.
    await expect(form.getByLabel("روش ارسال")).toHaveValue("پیک");
    await expect(form.getByLabel("نشانی ارسال")).toHaveValue("تهران، خیابان آزمایشی ۱");
    await expect(form).toContainText("در سرور تغییر کرد به: مشهد، نشانی اصلاح‌شده");
    await expect(form.getByRole("button", { name: "ثبت سرآیند" })).toBeDisabled();
    // ارسال با Enter هم چیزی نمی‌فرستد (دکمهٔ پیش‌فرضِ بسته، ارسال ضمنی را می‌بندد؛ submit خودش هم می‌سنجد).
    await form.getByLabel("روش ارسال").press("Enter");
    await expect(form.getByLabel("روش ارسال")).toHaveValue("پیک");
    expect(s.requests.filter(r => r.path === "patch"), "هیچ PATCH با مقادیر کهنه").toEqual([]);

    // فقط شروع دوبارهٔ صریح، فرم را با نسخهٔ تازه جایگزین می‌کند؛ ثبت بعدی نسخه و نشانی تازه را می‌برد.
    await panel.getByRole("button", { name: "شروع دوباره از نسخهٔ تازه" }).click();
    await expect(conflict).toHaveCount(0);
    await expect(form.getByLabel("نشانی ارسال")).toHaveValue("مشهد، نشانی اصلاح‌شده");
    await form.getByLabel("روش ارسال").fill("پیک");
    await form.getByRole("button", { name: "ثبت سرآیند" }).click();
    await expect(form).toHaveCount(0);
    const patches = s.requests.filter(r => r.path === "patch");
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toMatchObject({ version: 8, shipAddress: "مشهد، نشانی اصلاح‌شده", shipMethod: "پیک" });
    await expect(panel.getByRole("definition").filter({ hasText: "مشهد، نشانی اصلاح‌شده" })).toHaveCount(1);
  });

  test("confirm form validates against the order it sends: a payable change under the open form blocks the old amount; the sent version matches the validated payable", async ({ page, api }) => {
    const s = server(api, { status: "reserved", reservedUntil: "2026-10-24T10:00:00.000Z", version: 7 });
    const confirms: Record<string, unknown>[] = [];
    api.handlers.set(`POST /instagram-orders/${ID}/confirm`, async route => {
      confirms.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ json: { ...s.order, status: "finalized", paymentState: "confirmed", version: 9, lines: [] } });
    });
    await page.goto(`/?page=instagram-orders&ig.order=${ID}`);
    const panel = page.getByRole("region", { name: "سفارش IG-000200" });
    const form = panel.getByRole("form", { name: "فرم تأیید واریز" });
    const trigger = form.getByRole("button", { name: "تأیید واریز و نهایی‌سازی" });
    await form.getByLabel("حساب مقصد").selectOption(ACCOUNT);
    await form.getByLabel("مبلغ واریز (تومان)").fill("۱۰۵٬۰۰۰");
    await form.getByLabel("شمارهٔ پیگیری بانک").fill("778899");
    await form.getByLabel("زمان واریز").fill("2026-10-23T09:00");
    await expect(trigger).toBeEnabled();

    // کرایه زیر فرم باز عوض می‌شود (مبلغ کامل ۱۱۰٬۰۰۰ تومان، نسخهٔ ۸).
    s.order = { ...s.order, version: 8, invoice: { ...s.order.invoice, shipping: "100000", payable: "1100000" } };
    await panel.getByRole("button", { name: "به‌روزرسانی" }).click();
    await expect(form).toContainText("110٬000");
    await expect(form).toContainText("دقیقاً برابر مبلغ کامل سفارش");
    await expect(trigger, "مبلغ کهنه با نسخهٔ تازه نمی‌رود").toBeDisabled();
    expect(confirms).toEqual([]);

    await form.getByLabel("مبلغ واریز (تومان)").fill("۱۱۰٬۰۰۰");
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "تأیید واریز سفارش IG-000200" });
    await expect(dialog).toContainText("110٬000");
    await dialog.getByRole("button", { name: "تأیید واریز و نهایی‌سازی" }).click();
    await expect.poll(() => confirms.length).toBe(1);
    expect(confirms[0]).toMatchObject({ version: 8, accountId: ACCOUNT, amount: "1100000", refNo: "778899" });
  });
});
