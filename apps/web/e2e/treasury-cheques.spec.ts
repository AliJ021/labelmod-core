/**
 * WP4 خزانه — چک‌ها و تقویم سررسید مثل طرح ۱۰.
 *
 * - «سررسیدگذشته»/«نزدیک سررسید» زیر تاریخ چک فقط از `urgency` سرور (نمای `cheque_due`)، نه از ساعت مرورگر.
 * - سررسیدها: سه کارت و سطر «خالص» از جمع SQL سرور (عمداً با جمع ردیف‌ها فرق دارد تا ثابت شود صفحه خودش
 *   جمع نمی‌زند)؛ «N روز گذشته/مانده» از `daysLeft` سرور؛ پاسخ قدیمی‌تر بی جمع، کارتی نمی‌سازد.
 * - رگرسیون: `due_soon` سرور «نزدیک» است، نه «آینده».
 */
import { test, expect } from "./fixtures";

const cheque = (id: string, over: Record<string, unknown>) => ({ id, number: null, direction: "received", branchId: "b1", chequeNo: id, sayadId: null,
  bankName: "ملت", bankBranch: null, drawerName: null, amount: "24900000", issuedOn: "2026-09-01", dueOn: "2026-10-27", partyType: "customer",
  partyId: "c1", partyName: "مریم توکلی", bankAccountId: null, depositAccountId: null, depositAccountName: null, status: "in_hand", note: null,
  createdAt: "2026-09-01T08:00:00Z", ...over });

test.describe("چک‌ها و سررسید (طرح ۱۰)", () => {
  test("cheque list marks overdue and due-soon from the server's urgency only", async ({ page, api }) => {
    api.defaults["GET /cheques"] = { cheques: [
      cheque("6612", { urgency: "overdue" }),
      cheque("7720", { urgency: "due_soon", dueOn: "2026-11-02", partyName: "رضا کاظمی", status: "deposited" }),
      cheque("0440", { urgency: null, status: "cleared", dueOn: "2020-01-01", partyName: "پوشاک آریا" }),
    ] };
    await page.goto("/?page=treasury&treasury.tab=cheques");
    const table = page.getByRole("table", { name: "چک‌ها؛ مبلغ‌ها به تومان" });
    const row = (n: string) => table.locator("tbody tr").filter({ hasText: n });
    await expect(row("6612")).toContainText("سررسیدگذشته");
    await expect(row("7720")).toContainText("نزدیک سررسید");
    // تاریخ ۲۰۲۰ ولی سرور urgency نداده (تسویه‌شده): صفحه خودش «گذشته» حدس نمی‌زند.
    await expect(row("0440")).not.toContainText("سررسیدگذشته");
  });

  test("due calendar: cards and net from server totals, days from the server, due_soon reads as near", async ({ page, api }) => {
    api.defaults["GET /cheques/due"] = {
      due: [
        { id: "a", chequeNo: "6612", direction: "received", bankName: "ملت", amount: "24900000", dueOn: "2026-10-27", status: "in_hand", partyName: "مریم توکلی", urgency: "overdue", daysLeft: -2 },
        { id: "b", chequeNo: "7720", direction: "received", bankName: "صادرات", amount: "15000000", dueOn: "2026-11-02", status: "deposited", partyName: "رضا کاظمی", urgency: "due_soon", daysLeft: 4 },
        { id: "c", chequeNo: "0441", direction: "issued", bankName: "ملت", amount: "84000000", dueOn: "2026-11-03", status: "issued", partyName: "تولیدی نخ‌آرا", urgency: "future", daysLeft: 0 },
      ],
      // عمداً با جمع ردیف‌ها فرق دارد: صفحه باید عدد سرور را نشان دهد.
      totals: { received: "99900000", receivedCount: 2, issued: "84000000", issuedCount: 1, net: "15900000" },
    };
    await page.goto("/?page=treasury&treasury.tab=due");
    const cards = page.getByRole("region", { name: "جمع سررسیدها" });
    await expect(cards.getByRole("region", { name: "دریافتی باز" })).toContainText("9٬990٬000");
    await expect(cards.getByRole("region", { name: "پرداختی باز" })).toContainText("8٬400٬000");
    await expect(cards.getByRole("region", { name: "خالص سررسیدها" })).toContainText("1٬590٬000");

    const table = page.getByRole("table", { name: "تقویم سررسید چک‌ها؛ مبلغ‌ها به تومان" });
    expect((await table.locator("thead th").allInnerTexts()).map(h => h.trim())).toEqual(["تاریخ", "جهت", "طرف", "چک", "مبلغ", "وضعیت"]);
    const row = (n: string) => table.locator("tbody tr").filter({ hasText: n });
    await expect(row("6612")).toContainText("گذشته · 2 روز گذشته");
    await expect(row("7720")).toContainText("نزدیک · 4 روز مانده");
    await expect(row("7720")).not.toContainText("آینده");
    await expect(row("0441")).toContainText("امروز");
    await expect(row("0441")).toContainText("پرداختی");
    await expect(table.locator("tfoot")).toContainText("خالص");
    await expect(table.locator("tfoot")).toContainText("1٬590٬000");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });

  test("an older due response without totals or days shows no cards and no invented days", async ({ page, api }) => {
    api.defaults["GET /cheques/due"] = { due: [{ id: "a", chequeNo: "6612", direction: "received", bankName: "ملت", amount: "24900000",
      dueOn: "2026-10-27", status: "in_hand", partyName: "مریم توکلی", urgency: "overdue" }] };
    await page.goto("/?page=treasury&treasury.tab=due");
    const table = page.getByRole("table", { name: "تقویم سررسید چک‌ها؛ مبلغ‌ها به تومان" });
    await expect(table.locator("tbody tr").first()).toContainText("گذشته");
    await expect(table.locator("tbody tr").first()).not.toContainText("روز");
    await expect(page.getByRole("region", { name: "جمع سررسیدها" })).toHaveCount(0);
    await expect(table.locator("tfoot")).toHaveCount(0);
  });
});
