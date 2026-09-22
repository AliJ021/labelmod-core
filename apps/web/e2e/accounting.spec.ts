import { test, expect } from "./fixtures";

test("cash refund explicitly selects one of several open drawers", async ({ page, api }) => {
  api.defaults["GET /payment-methods"] = { methods: [{ code: "cash", name: "نقد", kind: "cash" }] };
  api.defaults["GET /return-reasons"] = { reasons: [{ code: "defective", label: "معیوب" }] };
  api.defaults["GET /invoices/lookup"] = { id: "i1", branchId: "b1", number: "F-1", netAmount: "200000", lines: [{ id: "l1", productName: "کالای آزمون", sku: "TEST" }] };
  api.defaults["GET /invoices/i1/returnable"] = { invoiceId: "i1", late: false, hoursSinceSale: 1,
    lines: [{ invoiceLineId: "l1", soldQty: "1", returnedQty: "0", remainingQty: "1", netAmount: "200000" }] };
  api.defaults["GET /shifts/open"] = [{ id: "s1", userName: "صندوق اول", openedAt: "2026-09-22T08:00:00Z" },
    { id: "s2", userName: "صندوق دوم", openedAt: "2026-09-22T09:00:00Z" }];
  let submitted: Record<string, unknown> | undefined;
  api.handlers.set("POST /returns", async route => {
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ json: { id: "r1", number: "R-1", status: "draft" } });
  });
  api.defaults["POST /returns/r1/post"] = { id: "r1", number: "R-1", status: "posted" };
  await page.goto("/");
  await page.getByRole("tab", { name: "مرجوعی", exact: true }).click();
  await page.getByLabel("شماره فاکتور", { exact: true }).fill("F-1");
  await page.getByRole("button", { name: "پیدا کن", exact: true }).click();
  await page.getByRole("button", { name: "اضافه کردن کالای آزمون", exact: true }).click();
  await page.getByRole("combobox", { name: "علت مرجوعی", exact: true }).selectOption("defective");
  const submit = page.getByRole("button", { name: "ثبت مرجوعی", exact: true });
  await expect(submit).toBeDisabled();
  await page.getByRole("combobox", { name: "صندوق بازپرداخت", exact: true }).selectOption("s2");
  await submit.click();
  await expect(page.getByRole("status")).toContainText("R-1");
  expect(submitted?.shiftId).toBe("s2");
  expect(submitted?.refundAmount).toBe("200000");
  expect(api.calls.filter(x => x.startsWith("POST /returns?" ) || x === "POST /returns")).toHaveLength(1);
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
  await page.getByRole("tablist", { name: "بخش‌ها", exact: true }).getByRole("tab", { name: "انبار و خرید", exact: true }).click();
  await page.getByRole("button", { name: "تأمین‌کننده جدید", exact: true }).click();
  await page.getByLabel("کد تأمین‌کننده", { exact: true }).fill("AUDIT");
  await page.getByLabel("نام تأمین‌کننده", { exact: true }).fill("تأمین‌کننده آزمون");
  await page.getByRole("button", { name: "ذخیره تأمین‌کننده", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "تأمین‌کننده", exact: true })).toHaveValue("new-supplier");
  expect(submitted).toEqual({ code: "AUDIT", name: "تأمین‌کننده آزمون" });
  expect(api.calls.filter(x => x === "POST /suppliers")).toHaveLength(1);
});
