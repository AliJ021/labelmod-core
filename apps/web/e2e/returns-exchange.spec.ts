import { test, expect, openZone, fontsReady, type MockApi } from "./fixtures";
import type { Page } from "@playwright/test";

const invoice = { id: "i1", number: "F-TEST-1", branchId: "b1", warehouseId: "w1", shiftId: "s1", customerId: null,
  channel: "pos", status: "finalized", grossAmount: "2000000", discountAmount: "0", netAmount: "2000000", taxAmount: "0",
  shippingAmount: "0", payableAmount: "2000000", paidAmount: "2000000", receivedAmount: "2000000", occurredAt: "2026-10-02T08:00:00Z",
  lines: [{ id: "l1", lineNo: 1, variationId: "v1", productName: "پیراهن آزمایشی", sku: "TEST-M", qty: "2", unitPrice: "1000000",
    netAmount: "2000000", discountAmount: "0", taxAmount: "0" }] };
function fixture(api: MockApi) {
  api.defaults["GET /payment-methods"] = { methods: [{ code: "cash", name: "نقد", kind: "cash", requiresRef: false }] };
  api.defaults["GET /return-reasons"] = { reasons: [{ code: "changed_mind", label: "تغییر نظر" }] };
  api.defaults["GET /invoices/lookup"] = invoice;
  api.defaults["GET /invoices/i1"] = invoice;
  api.defaults["GET /invoices/i1/refund-sources"] = { payments: [] };
  api.defaults["GET /shifts/open"] = [{ id: "s1", userName: "صندوق آزمایشی", openedAt: "2026-10-02T08:00:00Z" }];
  api.defaults["GET /invoices/i1/returnable"] = { invoiceId: "i1", invoiceStatus: "finalized", late: false,
    lines: [{ invoiceLineId: "l1", variationId: "v1", soldQty: "2", returnedQty: "0", remainingQty: "2",
      unitPrice: "1000000", netAmount: "2000000", returnedNetAmount: "0", taxAmount: "0", returnedTaxAmount: "0" }] };
  api.defaults["GET /exchanges/variation/v1"] = { id: "v1", name: "پیراهن آزمایشی", sku: "TEST-M" };
  api.defaults["POST /exchanges/quote"] = { token: "a".repeat(64), returnedValue: "1000000", replacementValue: "1000000",
    debt: "0", funds: "2000000", debtApplied: "0", transferAmount: "1000000", fundedTransfer: "1000000", collectAmount: "0", refundAmount: "0", policy: "carry_debt" };
}
async function choose(page: Page) {
  await page.goto("/"); await openZone(page, "مرجوعی");
  await page.getByLabel("شماره فاکتور", { exact: true }).fill("F-TEST-1");
  await page.getByRole("button", { name: "پیدا کن", exact: true }).click();
  await page.getByRole("button", { name: "اضافه کردن پیراهن آزمایشی", exact: true }).click();
  await page.getByRole("combobox", { name: "علت مرجوعی", exact: true }).selectOption("changed_mind");
}

test("partial return has two-stage confirmation and persists lost-response identity across reload", async ({ page, api }, testInfo) => {
  fixture(api);
  let key = "", posts = 0;
  api.handlers.set("POST /returns/commit", async route => {
    posts++; key = route.request().headers()["idempotency-key"]!;
    expect(route.request().postDataJSON()).toMatchObject({ confirmed: true, lines: [{ invoiceLineId: "l1", qty: "1" }] });
    api.defaults[`GET /returns/status/${key}`] = { status: "posted", number: "R-TEST-1" };
    await route.fulfill({ status: 502, json: { error: { code: "response_lost", message: "پاسخ آزمایشی قطع شد" } } });
  });
  await choose(page);
  await page.getByRole("button", { name: "۱. بررسی مرجوعی", exact: true }).click();
  expect(posts).toBe(0);
  await fontsReady(page); await page.screenshot({ path: testInfo.outputPath("return-confirm-synthetic.png"), fullPage: true });
  await page.getByRole("button", { name: "اقلام و مبلغ را تأیید می‌کنم؛ ثبت مرجوعی", exact: true }).click();
  await expect.poll(() => posts).toBe(1);
  await page.reload();
  await expect(page.getByRole("region", { name: "بازیابی عملیات مالی" })).toBeVisible();
  await page.getByRole("button", { name: "بررسی وضعیت", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("عملیات R-TEST-1 ثبت شد.");
  expect(posts).toBe(1);
});

test("exchange separately quotes settlement before explicit final confirmation", async ({ page, api }, testInfo) => {
  fixture(api);
  let posts = 0;
  api.handlers.set("POST /exchanges", async route => {
    posts++; expect(route.request().postDataJSON()).toMatchObject({ token: "a".repeat(64), confirmed: true,
      replacements: [{ variationId: "v1", qty: "1" }] });
    await route.fulfill({ json: { status: "posted", number: "E-TEST-1" } });
  });
  await choose(page);
  await page.getByRole("button", { name: "تعویض", exact: true }).click();
  await expect(page.getByRole("button", { name: "۱. بررسی مرجوعی", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /جایگزین با همان تنوع/ }).click();
  await page.getByRole("button", { name: "۱. محاسبه و بررسی تسویه", exact: true }).click();
  await page.getByRole("button", { name: "۲. بررسی نهایی تعویض", exact: true }).click();
  expect(posts).toBe(0);
  await fontsReady(page); await page.screenshot({ path: testInfo.outputPath("exchange-confirm-synthetic.png"), fullPage: true });
  await page.getByRole("button", { name: "اقلام و تسویه را تأیید می‌کنم؛ ثبت تعویض", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("عملیات E-TEST-1 ثبت شد.");
  expect(posts).toBe(1);
});

test("phone results are explicit choices with pagination; not-found recovery never reposts", async ({ page, api }) => {
  fixture(api);
  api.handlers.set("GET /invoices/by-phone", async (route, url) => {
    expect(url.searchParams.get("phone")).toBe("۰۹۱۲۰۰۰۰۰۰۰");
    await route.fulfill({ json: { invoices: [{ id: "i1", number: "F-TEST-1", payableAmount: "2000000" }], next: "next-1" } });
  });
  await page.goto("/"); await openZone(page, "مرجوعی");
  await page.getByLabel("جست‌وجو با", { exact: true }).selectOption("phone");
  await page.getByLabel("شماره همراه", { exact: true }).fill("۰۹۱۲۰۰۰۰۰۰۰");
  await page.getByRole("button", { name: "پیدا کن", exact: true }).click();
  await expect(page.getByRole("button", { name: "صفحه بعد", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /F-TEST-1/ }).click();
  await expect(page.getByRole("button", { name: "اضافه کردن پیراهن آزمایشی", exact: true })).toBeVisible();
  const key = "11111111-1111-4111-8111-111111111111";
  await page.evaluate(k => localStorage.setItem("labelmod.return-operation.22222222-2222-4222-8222-222222222222", JSON.stringify({
    key: k, kind: "exchanges", userId: "22222222-2222-4222-8222-222222222222" })), key);
  api.defaults[`GET /exchanges/status/${key}`] = { status: "not_found" };
  await page.reload();
  await page.getByRole("button", { name: "بررسی وضعیت", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("نتیجه هنوز معلوم نیست");
  await expect(page.getByRole("button", { name: "پیدا کن", exact: true })).toBeDisabled();
  expect(api.calls.filter(c => c === "POST /exchanges")).toHaveLength(0);
});

for (const kind of ["returns", "exchanges"] as const) {
  test(`${kind}: lost before server survives reload and explicitly retries identical key and body`, async ({ page, api }, testInfo) => {
    fixture(api);
    const requests: Array<{ key: string; body: string | null }> = [];
    api.handlers.set(`POST /${kind === "returns" ? "returns/commit" : kind}`, async route => {
      requests.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postData() });
      api.defaults[`GET /${kind}/status/${requests[0]!.key}`] = { status: "not_found" };
      if (requests.length === 1) await route.fulfill({ status: 502, json: { error: { code: "before_server", message: "درخواست به سرور نرسید" } } });
      else await route.fulfill({ json: { status: "posted", number: "RECOVERED-1" } });
    });
    await choose(page);
    if (kind === "returns") {
      await page.getByRole("button", { name: "۱. بررسی مرجوعی", exact: true }).click();
      await page.getByRole("button", { name: "اقلام و مبلغ را تأیید می‌کنم؛ ثبت مرجوعی", exact: true }).click();
    } else {
      await page.getByRole("button", { name: "تعویض", exact: true }).click();
      await page.getByRole("button", { name: /جایگزین با همان تنوع/ }).click();
      await page.getByRole("button", { name: "۱. محاسبه و بررسی تسویه", exact: true }).click();
      await page.getByRole("button", { name: "۲. بررسی نهایی تعویض", exact: true }).click();
      await page.getByRole("button", { name: "اقلام و تسویه را تأیید می‌کنم؛ ثبت تعویض", exact: true }).click();
    }
    await expect.poll(() => requests.length).toBe(1);
    await page.reload();
    await page.getByRole("button", { name: "بررسی وضعیت", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("نتیجه هنوز معلوم نیست");
    expect(requests).toHaveLength(1);
    await page.getByRole("button", { name: "ارسال دوباره همان عملیات", exact: true }).click();
    await fontsReady(page); await page.screenshot({ path: testInfo.outputPath(`${kind}-retry-synthetic.png`), fullPage: true });
    expect(requests).toHaveLength(1);
    await page.getByRole("button", { name: "همان درخواست را با همان شناسه ارسال کن", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("عملیات RECOVERED-1 ثبت شد.");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
  });
}
