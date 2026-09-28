import { test, expect } from "./fixtures";

for (const kind of ["cash", "transfer", "unknown"] as const) {
  test(`paid draft recovery requires explicit confirmation: ${kind}`, async ({ page, api }) => {
    const invoice = { id: "draft1", number: null, branchId: "b1", warehouseId: "w1", shiftId: "s1", createdBy: "22222222-2222-4222-8222-222222222222", customerId: null,
      status: "draft", channel: "pos", grossAmount: "200000", discountAmount: "0", netAmount: "200000", taxAmount: "0",
      shippingAmount: "0", payableAmount: "200000", paidAmount: "0", receivedAmount: "200000", recipientId: null, gift: null,
      occurredAt: "2026-09-23T00:00:00Z", lines: [{ id: "l1", lineNo: 1, variationId: "v1", productName: "کالای آزمون",
        sku: "TEST", qty: "1", unitPrice: "200000", netAmount: "200000", discountAmount: "0", listPrice: null,
        priceOverrideReason: null, discountReason: null }] };
    api.defaults["GET /payment-methods"] = { methods: [{ code: "cash", name: "نقد", kind: "cash", requiresRef: false }] };
    api.defaults["GET /shifts/current"] = { id: "s1", userId: "22222222-2222-4222-8222-222222222222", branchId: "b1", status: "open", openingCash: "0", openedAt: "2026-09-23T00:00:00Z" };
    api.defaults["GET /invoices/draft1"] = invoice;
    api.defaults["GET /invoices/draft1/payments"] = {payments:[{id:"p1",amount:"200000",name:"پرداخت آزمون"}]};
    api.defaults["GET /gift-options"] = { wraps: [], colors: [], flowers: [] };
    api.handlers.set("POST /invoices/draft1/cancel", async route => {
      await route.fulfill({ status: 409, json: { error: { code: "invoice_has_payment", message: "پرداخت باید برگشت بخورد" } } });
    });
    api.defaults["GET /invoices/draft1/draft-payments"] = { payments: [{ id: "p1", amount: "200000", kind: kind === "unknown" ? "cash" : kind,
      name: "پرداخت آزمون", status: kind === "unknown" ? "unknown" : "succeeded", direction: "in", settlement_id: null, settled_at: null, fee_amount: "0" }] };
    let submitted: Record<string, unknown> | undefined;
    let key: string | undefined;
    api.handlers.set("POST /invoices/draft1/refund-draft", async route => {
      submitted = route.request().postDataJSON() as Record<string, unknown>;
      key = route.request().headers()["idempotency-key"];
      await route.fulfill({ json: { invoice: { ...invoice, status: "cancelled" }, replayed: false } });
    });
    await page.addInitScript(() => localStorage.setItem("labelmod_open_cart", JSON.stringify({ invoiceId: "draft1", shiftId: "s1" })));
    await page.goto("/");
    await page.getByRole("tab", { name: "صندوق", exact: true }).click();
    await page.getByRole("button", { name: "رها کردن سبد", exact: true }).click();
    const panel = page.getByRole("region", { name: "برگشت پرداخت پیش‌نویس" });
    await expect(panel).toBeVisible();
    const submit = panel.getByRole("button", { name: "ثبت برگشت و لغو پیش‌نویس", exact: true });
    await expect(submit).toBeDisabled();
    await panel.getByLabel("دلیل برگشت", { exact: true }).fill("موجودی کافی نیست");
    await expect(submit).toBeDisabled();
    await panel.getByRole("checkbox").check();
    if (kind === "unknown") {
      await expect(submit).toBeDisabled();
      await expect(panel.getByRole("alert")).toContainText("نیازمند بررسی حسابدار");
      expect(submitted).toBeUndefined();
      return;
    }
    if (kind === "transfer") {
      await expect(submit).toBeDisabled();
      await panel.getByLabel("شماره پیگیری برگشت بانکی").fill("BANK-RETURN-1");
    }
    await submit.click();
    await expect(panel).not.toBeVisible();
    expect(submitted).toMatchObject({ reason: "موجودی کافی نیست", confirmed: true, paymentIds: ["p1"] });
    expect(key).toBeTruthy();
    if (kind === "transfer") expect(submitted?.refundReference).toBe("BANK-RETURN-1");
    expect(api.calls.filter(c => c === "POST /invoices/draft1/refund-draft")).toHaveLength(1);
    expect(await page.evaluate(() => localStorage.getItem("labelmod_open_cart"))).toBe("");
  });
}
