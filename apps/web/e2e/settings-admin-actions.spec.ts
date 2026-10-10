/**
 * کنش‌های نهایی پرسنل و دستگاه‌ها (PR #143) — تعامل واقعی، نه فقط ظاهر:
 * انصراف هیچ درخواستی نمی‌فرستد، تأیید دقیقاً یک بار می‌فرستد، پاسخ گمشده «نامعلوم» است
 * و تأیید دوباره ندارد، نبودِ ردیف در پاسخ بررسی هم «نامعلوم» می‌ماند (نه «انجام نشد»)،
 * و شکستِ خواندن دوباره پس از موفقیت، موفقیت را شکست نشان نمی‌دهد و دادهٔ کهنه را قفل می‌کند.
 * فقط دادهٔ ساختگی؛ هیچ اعتبار یا حساب واقعی.
 */
import type { Page, Route } from "@playwright/test";
import { test, expect, settings, staff } from "./fixtures";

const withPin = { ...staff, hasPin: true };
const count = (calls: string[], key: string) => calls.filter(c => c.split("?")[0] === key).length;
const dialog = (page: Page) => page.getByRole("dialog");
const staffRow = (page: Page) => page.getByRole("row").filter({ hasText: staff.username });

/** فهرست پرسنل: بررسی وضعیت (`includeInactive=true`) و فهرست صفحه جدا پاسخ می‌گیرند. */
function usersRoute(list: () => unknown[], verify: () => unknown[] | "fail" = list) {
  return async (route: Route, url: URL) => {
    const rows = url.searchParams.get("includeInactive") === "true" ? verify() : list();
    if (rows === "fail") await route.fulfill({ status: 503, json: { error: { code: "test", message: "خطای آزمایشی" } } });
    else await route.fulfill({ json: { users: rows } });
  };
}

test("برداشتن PIN: انصراف بی‌درخواست، تأیید یک بار، و فهرست تازه", async ({ page, api }) => {
  let pin = true;
  api.handlers.set("GET /users", usersRoute(() => [{ ...staff, hasPin: pin }]));
  api.handlers.set(`PUT /users/${staff.id}/pin`, async route => {
    expect(route.request().postDataJSON()).toEqual({ pin: null });
    pin = false; await route.fulfill({ json: { ok: true, hasPin: false } });
  });
  await page.goto("/"); await settings(page, "staff", "پرسنل");
  await staffRow(page).getByRole("button", { name: "برداشتن PIN" }).click();
  await expect(dialog(page)).toContainText("باز کردن قفل صفحه فقط با رمز کامل");
  await dialog(page).getByRole("button", { name: "انصراف" }).click();
  expect(count(api.calls, `PUT /users/${staff.id}/pin`)).toBe(0);

  await staffRow(page).getByRole("button", { name: "برداشتن PIN" }).click();
  await dialog(page).getByRole("button", { name: "برداشتن PIN" }).click();
  await expect(page.getByRole("status").filter({ hasText: "برداشته شد" })).toBeVisible();
  await expect(staffRow(page)).toContainText("ندارد");
  expect(count(api.calls, `PUT /users/${staff.id}/pin`)).toBe(1);
});

test("غیرفعال‌کردن با پاسخ گمشده نامعلوم است؛ نبودِ کاربر در بررسی، تأیید دوباره را باز نمی‌کند", async ({ page, api }) => {
  let verifyRows: unknown[] = [];
  api.handlers.set("GET /users", usersRoute(() => [staff], () => verifyRows));
  api.handlers.set(`PATCH /users/${staff.id}`, route => route.abort("connectionreset"));
  await page.goto("/"); await settings(page, "staff", "پرسنل");
  // خودِ کاربر دکمهٔ غیرفعال‌کردن خودش را ندارد.
  await expect(page.getByRole("row").filter({ hasText: "synthetic_admin" }).getByRole("button", { name: "غیرفعال", exact: true })).toHaveCount(0);

  await staffRow(page).getByRole("button", { name: "غیرفعال", exact: true }).click();
  await dialog(page).getByRole("button", { name: "غیرفعال کن" }).click();
  await expect(dialog(page)).toContainText("نتیجه نامعلوم");
  await expect(dialog(page).getByRole("button", { name: "غیرفعال کن" })).toHaveCount(0);

  // پاسخ بررسی کاربر را ندارد (مثلاً دامنهٔ دسترسی عوض شده): هنوز نامعلوم، نه «انجام نشد».
  await dialog(page).getByRole("button", { name: "بررسی وضعیت" }).click();
  await expect(dialog(page)).toContainText("وضعیت هنوز از سرور خوانده نشد");
  await expect(dialog(page).getByRole("button", { name: "غیرفعال کن" })).toHaveCount(0);
  await expect(dialog(page)).not.toContainText("دوباره تأیید کنید.");

  // بستن پنجره هم نامعلوم را فراموش نمی‌کند: دکمهٔ ردیف «اجرا» نیست.
  await page.keyboard.press("Escape");
  await expect(staffRow(page).getByRole("button", { name: "نتیجه نامعلوم؛ بررسی وضعیت" })).toBeVisible();
  await staffRow(page).getByRole("button", { name: "نتیجه نامعلوم؛ بررسی وضعیت" }).click();
  verifyRows = [{ ...staff, isActive: false }];
  await dialog(page).getByRole("button", { name: "بررسی وضعیت" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "غیرفعال شد" })).toBeVisible();
  expect(count(api.calls, `PATCH /users/${staff.id}`)).toBe(1);
});

test("فعال‌کردن موفق ولی خواندن دوباره شکست خورد: پیام موفقیت می‌ماند و کنش‌های کهنه بسته‌اند", async ({ page, api }) => {
  let refreshFails = false;
  const inactive = { ...withPin, isActive: false };
  api.handlers.set("GET /users", async (route, url) => {
    if (refreshFails && url.searchParams.get("includeInactive") === "false") {
      await route.fulfill({ status: 503, json: { error: { code: "test", message: "خطای آزمایشی" } } }); return;
    }
    await route.fulfill({ json: { users: [inactive] } });
  });
  api.handlers.set(`PATCH /users/${staff.id}`, async route => {
    expect(route.request().postDataJSON()).toEqual({ isActive: true });
    refreshFails = true; await route.fulfill({ json: { ...inactive, isActive: true } });
  });
  await page.goto("/"); await settings(page, "staff", "پرسنل");
  await staffRow(page).getByRole("button", { name: "فعال", exact: true }).click();
  await dialog(page).getByRole("button", { name: "فعال کن" }).click();
  await expect(page.getByRole("status").filter({ hasText: "فعال شد" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "تغییر ثبت شد، ولی فهرست به‌روز نشد." })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "خطای آزمایشی" })).toHaveCount(0);
  for (const name of ["نقش‌ها", "رمز تازه", "برداشتن PIN"]) await expect(staffRow(page).getByRole("button", { name })).toBeDisabled();

  refreshFails = false;
  await page.getByRole("button", { name: "به‌روزرسانی فهرست" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "فهرست به‌روز نشد" })).toHaveCount(0);
  await expect(staffRow(page).getByRole("button", { name: "نقش‌ها" })).toBeEnabled();
  expect(count(api.calls, `PATCH /users/${staff.id}`)).toBe(1);
});

const trusted = { id: "d2", fingerprint: "synthetic-fp-2", label: "صندوق آزمایشی", kind: "pos", branchId: "b1", branchName: "شعبه آزمایشی",
  isApproved: true, approvedAt: "2026-10-01T08:00:00Z", approvedByName: "مدیر آزمایشی", enrolled: true, enrolledAt: "2026-10-01T09:00:00Z",
  lastSeenAt: "2026-10-09T08:00:00Z", createdAt: "2026-10-01T08:00:00Z", activeSessions: 1 };

test("ابطال دستگاه: انصراف بی‌درخواست؛ پاسخ گمشده و نبودِ دستگاه نامعلوم؛ بررسی موفق می‌بندد", async ({ page, api }) => {
  let devices: unknown[] = [trusted];
  api.handlers.set("GET /devices", async route => { await route.fulfill({ json: { devices } }); });
  api.defaults["GET /sessions"] = { sessions: [] };
  api.handlers.set("POST /devices/d2/revoke", route => route.abort("connectionreset"));
  await page.goto("/"); await settings(page, "devices", "دستگاه‌ها");
  await page.getByRole("button", { name: "ابطال دستگاه" }).click();
  await dialog(page).getByRole("button", { name: "انصراف" }).click();
  expect(count(api.calls, "POST /devices/d2/revoke")).toBe(0);

  await page.getByRole("button", { name: "ابطال دستگاه" }).click();
  await dialog(page).getByRole("button", { name: "ابطال دستگاه" }).click();
  await expect(dialog(page)).toContainText("نتیجه نامعلوم");
  devices = [];
  await dialog(page).getByRole("button", { name: "بررسی وضعیت" }).click();
  await expect(dialog(page)).toContainText("وضعیت هنوز از سرور خوانده نشد");
  await expect(dialog(page).getByRole("button", { name: "ابطال دستگاه" })).toHaveCount(0);

  devices = [{ ...trusted, isApproved: false, enrolled: false }];
  await dialog(page).getByRole("button", { name: "بررسی وضعیت" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "باطل شد" })).toBeVisible();
  expect(count(api.calls, "POST /devices/d2/revoke")).toBe(1);
});

test("فعال‌کردن: هدف در شروع ثابت می‌شود؛ پس از نامعلوم و تغییر ردیف، بررسی همان هدف را می‌سنجد و عمل معکوس نمی‌رود", async ({ page, api }) => {
  // سرور عملیات را نشانده ولی پاسخش گم شده: فهرست بعدی کاربر را فعال نشان می‌دهد.
  let applied = false;
  const bodies: unknown[] = [];
  api.handlers.set("GET /users", async route => { await route.fulfill({ json: { users: [{ ...staff, isActive: applied }] } }); });
  api.handlers.set(`PATCH /users/${staff.id}`, async route => {
    bodies.push(route.request().postDataJSON()); applied = true; await route.abort("connectionreset");
  });
  await page.goto("/"); await settings(page, "staff", "پرسنل");
  await staffRow(page).getByRole("button", { name: "فعال", exact: true }).click();
  await dialog(page).getByRole("button", { name: "فعال کن" }).click();
  await expect(dialog(page)).toContainText("نتیجه نامعلوم");
  await page.keyboard.press("Escape");

  // فهرست به‌روز می‌شود و ردیف حالا «فعال» است؛ دکمهٔ ردیف همچنان «نامعلوم» است، نه «غیرفعال».
  await page.getByRole("checkbox", { name: "غیرفعال‌ها هم" }).check();
  await expect(staffRow(page)).toContainText("فعال");
  await expect(staffRow(page).getByRole("button", { name: "غیرفعال", exact: true })).toHaveCount(0);
  await staffRow(page).getByRole("button", { name: "نتیجه نامعلوم؛ بررسی وضعیت" }).click();
  await expect(dialog(page)).toContainText("فعال‌کردن");
  await dialog(page).getByRole("button", { name: "بررسی وضعیت" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "فعال شد" })).toBeVisible();
  expect(bodies).toEqual([{ isActive: true }]);
});

test("همه نشست‌ها: پاسخ نامعلوم از فهرست محدود نشست‌ها هرگز «انجام شد» یا اجازهٔ تکرار نمی‌گیرد", async ({ page, api }) => {
  let sessions: unknown[] = [{ id: "s1", userId: "u9", username: "synthetic_cashier", fullName: "صندوق‌دار آزمایشی", deviceLabel: "صندوق آزمایشی",
    authMethod: "password", pinUnlocked: false, ip: null, lastSeenAt: "2026-10-09T08:30:00Z", createdAt: "2026-10-09T08:00:00Z" }];
  api.defaults["GET /devices"] = { devices: [] };
  api.handlers.set("GET /sessions", async route => { await route.fulfill({ json: { sessions } }); });
  api.handlers.set("POST /users/u9/revoke-sessions", route => route.abort("connectionreset"));
  await page.goto("/"); await settings(page, "devices", "دستگاه‌ها");
  await page.getByRole("button", { name: "همه نشست‌ها" }).click();
  await expect(dialog(page)).toContainText("حداکثر ۵۰۰ نشست");
  await dialog(page).getByRole("button", { name: "بستن همهٔ نشست‌ها" }).click();
  await expect(dialog(page)).toContainText("نتیجه نامعلوم");
  // کاربر دیگر در فهرست قابل‌دید نیست — این اثبات نیست.
  sessions = [];
  await dialog(page).getByRole("button", { name: "بررسی وضعیت" }).click();
  await expect(dialog(page).getByRole("button", { name: "بررسی وضعیت" })).toBeEnabled();
  await expect(dialog(page)).toContainText("نتیجه نامعلوم");
  await expect(dialog(page).getByRole("button", { name: "بستن همهٔ نشست‌ها" })).toHaveCount(0);
  await expect(dialog(page)).toContainText("«رمز تازه»");
  await expect(page.getByRole("status").filter({ hasText: "بسته شد" })).toHaveCount(0);
  expect(count(api.calls, "POST /users/u9/revoke-sessions")).toBe(1);
});

test("ورود دومرحله‌ای: وضعیت موفق و کلیدها ناموفق «کلیدی ثبت نشده» نمی‌گوید؛ تلاش دوباره فقط می‌خواند", async ({ page, api }) => {
  api.defaults["GET /auth/2fa"] = { enabled: false, pending: false, recoveryCodesLeft: 0, webauthnKeys: 1, shouldHave: false };
  let keysOk = false;
  api.handlers.set("GET /auth/2fa/webauthn", async route => {
    if (keysOk) await route.fulfill({ json: { credentials: [{ id: "k1", name: "کلید آزمایشی", createdAt: "2026-10-01T08:00:00Z", lastUsedAt: null }] } });
    else await route.fulfill({ status: 503, json: { error: { code: "test", message: "خطای کلیدها" } } });
  });
  await page.goto("/"); await settings(page, "twofactor", "ورود دومرحله‌ای");
  await expect(page.getByRole("alert").filter({ hasText: "خطای کلیدها" })).toBeVisible();
  await expect(page.getByText("کلیدی ثبت نشده")).toHaveCount(0);
  keysOk = true;
  await page.locator("main").getByRole("button", { name: "تلاش دوباره" }).click();
  await expect(page.getByText("کلید آزمایشی")).toBeVisible();
  expect(api.calls.filter(c => c.startsWith("POST"))).toEqual([]);
});

test("پیامک: در بارگذاری و خطای وضعیت «شماره‌ای تأیید نشده» نمی‌گوید؛ تلاش دوباره فقط وضعیت را می‌خواند", async ({ page, api }) => {
  api.defaults["GET /auth/2fa"] = { enabled: false, pending: false, recoveryCodesLeft: 0, webauthnKeys: 0, shouldHave: false };
  api.defaults["GET /auth/2fa/webauthn"] = { credentials: [] };
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  let phase: "hold" | "fail" | "ok" = "hold";
  api.handlers.set("GET /auth/2fa/sms/status", async route => {
    if (phase === "hold") { await held; await route.fulfill({ status: 503, json: { error: { code: "test", message: "خطای پیامک" } } }); return; }
    await route.fulfill({ json: { enabled: false, maskedMobile: null } });
  });
  await page.goto("/"); await settings(page, "twofactor", "ورود دومرحله‌ای");
  const panel = page.getByRole("region", { name: "ورود دومرحله‌ای پیامکی" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("هنوز شماره‌ای تأیید نشده است.")).toHaveCount(0);
  phase = "fail"; release();
  await expect(panel.getByRole("alert").filter({ hasText: "خطای پیامک" })).toBeVisible();
  await expect(panel.getByText("هنوز شماره‌ای تأیید نشده است.")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "ارسال کد تأیید شماره" })).toBeDisabled();
  phase = "ok";
  await panel.getByRole("button", { name: "تلاش دوباره" }).click();
  await expect(panel.getByText("هنوز شماره‌ای تأیید نشده است.")).toBeVisible();
  expect(api.calls.filter(c => c.startsWith("POST"))).toEqual([]);
});
