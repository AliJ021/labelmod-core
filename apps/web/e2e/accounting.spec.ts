import { openZone } from "./fixtures";
import { test, expect } from "./fixtures";

test("cash refund explicitly selects one of several open drawers", async ({ page, api }) => {
  api.defaults["GET /payment-methods"] = { methods: [{ code: "cash", name: "نقد", kind: "cash" }] };
  api.defaults["GET /return-reasons"] = { reasons: [{ code: "defective", label: "معیوب" }] };
  api.defaults["GET /invoices/lookup"] = { id: "i1", branchId: "b1", number: "F-1", netAmount: "200000", lines: [{ id: "l1", productName: "کالای آزمون", sku: "TEST" }] };
  api.defaults["GET /invoices/i1/refund-sources"] = { payments: [] };
  api.defaults["GET /invoices/i1/returnable"] = { invoiceId: "i1", late: false, hoursSinceSale: 1,
    lines: [{ invoiceLineId: "l1", soldQty: "1", returnedQty: "0", remainingQty: "1", netAmount: "200000" }] };
  api.defaults["GET /shifts/open"] = [{ id: "s1", userName: "صندوق اول", openedAt: "2026-09-22T08:00:00Z" },
    { id: "s2", userName: "صندوق دوم", openedAt: "2026-09-22T09:00:00Z" }];
  let submitted: Record<string, unknown> | undefined;
  let idempotencyKey: string | undefined;
  api.handlers.set("POST /returns/commit", async route => {
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    idempotencyKey = route.request().headers()["idempotency-key"];
    await route.fulfill({ json: { id: "r1", number: "R-1", status: "posted" } });
  });
  await page.goto("/");
  await openZone(page, "مرجوعی");
  await page.getByLabel("شماره فاکتور", { exact: true }).fill("F-1");
  await page.getByRole("button", { name: "پیدا کن", exact: true }).click();
  await page.getByRole("button", { name: "اضافه کردن کالای آزمون", exact: true }).click();
  await page.getByRole("combobox", { name: "علت مرجوعی", exact: true }).selectOption("defective");
  const submit = page.getByRole("button", { name: "۱. بررسی مرجوعی", exact: true });
  await expect(submit).toBeDisabled();
  expect(submitted).toBeUndefined();
  await page.getByRole("combobox", { name: "صندوق بازپرداخت", exact: true }).selectOption("s2");
  await submit.click();
  expect(submitted).toBeUndefined();
  await page.getByRole("button", { name: "اقلام و مبلغ را تأیید می‌کنم؛ ثبت مرجوعی", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("R-1");
  expect(submitted?.shiftId).toBe("s2");
  expect(submitted?.refundAmount).toBe("200000");
  expect(submitted?.confirmed).toBe(true);
  expect(idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(api.calls.filter(x => x === "POST /returns/commit")).toHaveLength(1);
  expect(api.calls.filter(x => x === "POST /returns" || x === "POST /returns/r1/post")).toHaveLength(0);
});

test("purchase screen creates and selects a supplier without leaving the receipt", async ({ page, api }) => {
  let submitted: Record<string, unknown> | undefined;
  api.handlers.set("POST /suppliers", async route => {
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    const supplier = { id: "new-supplier", code: "AUDIT", name: "تأمین‌کننده آزمون" };
    api.defaults["GET /suppliers"] = [supplier];
    await route.fulfill({ status: 201, json: supplier });
  });
  await page.goto("/");
  await openZone(page, "انبار و خرید");
  await page.getByRole("button", { name: "تأمین‌کننده جدید", exact: true }).click();
  await page.getByLabel("کد تأمین‌کننده", { exact: true }).fill("AUDIT");
  await page.getByLabel("نام تأمین‌کننده", { exact: true }).fill("تأمین‌کننده آزمون");
  await page.getByRole("button", { name: "ذخیره تأمین‌کننده", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "تأمین‌کننده", exact: true })).toHaveValue("new-supplier");
  expect(submitted).toEqual({ code: "AUDIT", name: "تأمین‌کننده آزمون" });
  expect(api.calls.filter(x => x === "POST /suppliers")).toHaveLength(1);
});
