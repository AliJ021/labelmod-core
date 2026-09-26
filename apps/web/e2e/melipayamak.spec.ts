import { openZone } from "./fixtures";
import { test, expect } from "./fixtures";

test("MelliPayamak settings rotate, preserve and explicitly clear a write-only key", async ({ page, api }) => {
  api.defaults["GET /settings"] = { groups: [{ key: "notify", title: "اعلان‌ها", subtitle: null, settings: [] }] };
  let state = { accountName: "پنل قدیمی", hasKey: true, revision: 2, storageReady: true, canEdit: true };
  api.handlers.set("GET /settings/melipayamak-credential", async route => { await route.fulfill({ json: state }); });
  const submissions: Record<string, unknown>[] = [];
  api.handlers.set("PUT /settings/melipayamak-credential", async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    submissions.push(body);
    state = { ...state, accountName: String(body.accountName), revision: state.revision + 1, hasKey: !body.clearKey };
    await route.fulfill({ json: state });
  });
  await page.goto("/"); await openZone(page, "تنظیمات");
  const key = page.getByLabel("کلید API جدید ملی‌پیامک", { exact: true });
  const account = page.getByLabel("نام حساب / نام کاربری پنل (اختیاری)", { exact: true });
  const save = page.getByRole("button", { name: "ذخیرهٔ اتصال ملی‌پیامک", exact: true });
  await expect(key).toHaveAttribute("type", "password"); await expect(key).toHaveValue("");
  await account.fill("پنل جدید"); await key.fill("test-key-no-real-secret"); await save.click();
  await expect(key).toHaveValue("");
  expect(submissions[0]).toMatchObject({ revision: 2, accountName: "پنل جدید", apiKey: "test-key-no-real-secret", clearKey: false });
  await account.fill("نام بدون تعویض کلید"); await save.click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1]).not.toHaveProperty("apiKey");
  await page.getByRole("checkbox", { name: /حذف کلید ذخیره‌شده/ }).check(); await save.click();
  await expect(page.getByText("هنوز کلیدی ذخیره نشده است.", { exact: true })).toBeVisible();
  expect(submissions[2]).toMatchObject({ clearKey: true });
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("test-key-no-real-secret");
});

test("MelliPayamak settings show concurrent-update failure without claiming success", async ({ page, api }) => {
  api.defaults["GET /settings"] = { groups: [{ key: "notify", title: "اعلان‌ها", subtitle: null, settings: [] }] };
  api.defaults["GET /settings/melipayamak-credential"] = { accountName: "", hasKey: false, revision: 0, storageReady: true, canEdit: true };
  api.handlers.set("PUT /settings/melipayamak-credential", async route => {
    await route.fulfill({ status: 409, json: { error: { code: "credential_conflict", message: "تنظیم اتصال هم‌زمان تغییر کرده؛ صفحه را تازه کنید" } } });
  });
  await page.goto("/"); await openZone(page, "تنظیمات");
  await page.getByLabel("کلید API جدید ملی‌پیامک", { exact: true }).fill("test-new-key");
  await page.getByRole("button", { name: "ذخیرهٔ اتصال ملی‌پیامک", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("هم‌زمان تغییر کرده");
  await expect(page.getByText("تنظیم اتصال ذخیره شد.", { exact: false })).toHaveCount(0);
});

test("MelliPayamak settings respect permission and missing secure storage", async ({ page, api }) => {
  api.defaults["GET /settings"] = { groups: [{ key: "notify", title: "اعلان‌ها", subtitle: null, settings: [] }] };
  api.defaults["GET /settings/melipayamak-credential"] = { accountName: "", hasKey: false, revision: 0, storageReady: false, canEdit: false };
  await page.goto("/"); await openZone(page, "تنظیمات");
  await expect(page.getByLabel("کلید API جدید ملی‌پیامک", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "ذخیرهٔ اتصال ملی‌پیامک", exact: true })).toBeDisabled();
  expect(api.calls.filter(c => c.startsWith("PUT /settings/melipayamak-credential"))).toHaveLength(0);
});
