import { openZone } from "./fixtures";
import { test, expect } from "./fixtures";

for (const decision of ["approved", "rejected"] as const) {
  test(`مرجوعی سایت با تصمیم صریح انسانی: ${decision}`, async ({ page, api }) => {
    api.defaults["GET /payment-methods"] = { methods: [] };
    api.defaults["GET /return-reasons"] = { reasons: [] };
    api.defaults["GET /web-refund-requests"] = { items: [{ id: "r1", invoiceId: "i1", number: "F-1",
      requestedAt: "2026-09-24T10:00:00Z", requestedBy: "اتصال سایت", payload: { orderId: "100", refundId: "101",
        amount: "100000", shippingAmount: "0", lines: [{ lineNo: 1, qty: "1", restock: true }] } }] };
    let submitted: unknown;
    let releaseDecision!: () => void;
    const decisionGate = new Promise<void>((resolve) => { releaseDecision = resolve; });
    api.handlers.set("POST /web-refund-requests/r1/decision", async (route) => {
      await decisionGate;
      submitted = route.request().postDataJSON();
      await route.fulfill({ json: { requestId: "r1", status: decision === "approved" ? "posted" : "rejected" } });
    });
    await page.goto("/");
    await openZone(page, "مرجوعی");
    const panel = page.getByRole("region", { name: "بررسی مرجوعی سایت" });
    await panel.getByRole("button", { name: "دریافت درخواست‌های منتظر تأیید" }).click();
    await panel.getByRole("button", { name: "بررسی فاکتور F-1 · مرجوعی سایت 101" }).click();
    const approve = panel.getByRole("button", { name: "تأیید و ثبت سند مرجوعی" });
    const reject = panel.getByRole("button", { name: "رد درخواست بدون ثبت سند" });
    await expect(approve).toBeDisabled(); await expect(reject).toBeDisabled();
    await panel.getByLabel("دلیل تصمیم").fill("رسید و کالای برگشتی بررسی شد");
    await expect(approve).toBeDisabled();
    if (decision === "approved") await panel.getByRole("checkbox").check();
    await (decision === "approved" ? approve : reject).click();
    releaseDecision();
    await expect(panel.getByRole("status")).toContainText(decision === "approved" ? "سند مرجوعی ثبت شد" : "سند و موجودی تغییر نکردند");
    expect(submitted).toEqual({ decision, reason: "رسید و کالای برگشتی بررسی شد" });
    expect(api.calls.filter((call) => call === "POST /web-refund-requests/r1/decision")).toHaveLength(1);
  });
}
