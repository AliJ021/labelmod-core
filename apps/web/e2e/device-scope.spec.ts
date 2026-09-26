import { test, expect, settings } from "./fixtures";

for (const initial of [true, false]) {
  test(`تأیید دستگاه با شعبه صریح؛ تازه=${initial}`, async ({ page, api }) => {
    const branchId = "11111111-1111-4111-8111-111111111111";
    const device = { id: "d1", fingerprint: "synthetic-device", label: "صندوق آزمایشی", kind: "desktop",
      branchId: initial ? null : branchId, branchName: initial ? null : "شعبه آزمایشی",
      isApproved: false, approvedAt: null, approvedByName: null, enrolled: false,
      enrolledAt: null, lastSeenAt: null, createdAt: "2026-09-26T00:00:00Z", activeSessions: 0 };
    api.defaults["GET /devices"] = { devices: [device] };
    api.defaults["GET /sessions"] = { sessions: [] };
    api.defaults["GET /branches"] = { allBranches: initial,
      branches: [{ id: branchId, code: "TEST", name: "شعبه آزمایشی", warehouses: [] }] };
    let submitted: unknown;
    api.handlers.set("POST /devices/d1/approve", async route => {
      submitted = route.request().postDataJSON();
      api.defaults["GET /devices"] = { devices: [{ ...device, isApproved: true, branchId }] };
      await route.fulfill({ json: { ok: true } });
    });
    await page.goto("/"); await settings(page, "devices", "دستگاه‌ها");
    await page.getByRole("button", { name: "تأیید دستگاه", exact: true }).click();
    const approve = page.getByRole("button", { name: "تأیید", exact: true });
    if (initial) {
      await expect(approve).toBeDisabled();
      expect(api.calls.filter(c => c === "POST /devices/d1/approve")).toHaveLength(0);
      await page.getByRole("combobox", { name: "شعبه دستگاه" }).selectOption(branchId);
    } else {
      await expect(page.getByRole("combobox", { name: "شعبه دستگاه" })).toHaveValue(branchId);
    }
    await page.getByRole("textbox", { name: "نام دستگاه" }).fill("صندوق یک");
    await approve.click();
    await expect(page.getByRole("status")).toContainText("تأیید شد");
    expect(submitted).toEqual({ label: "صندوق یک", branchId });
    expect(api.calls.filter(c => c === "POST /devices/d1/approve")).toHaveLength(1);
  });
}
