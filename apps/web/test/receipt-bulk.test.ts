/**
 * افزودن گروهی به رسید — مرورگر فقط می‌سنجد و همان را می‌فرستد؛ جمع و ادغام سمت
 * سرور است (`purchasing.integration.test.ts`). رفتار مرورگر در `e2e/receipt-bulk.spec.ts`.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { bulkLines, byColor, parseQty } from "../src/lib/receipt-bulk.ts";

describe("افزودن گروهی رسید", () => {
  test("تعداد: رقم فارسی، تا سه اعشار، بزرگ‌تر از صفر", () => {
    assert.equal(parseQty("۱۲"), "12");
    assert.equal(parseQty("۲٫۵"), "2.5");
    assert.equal(parseQty("1.125"), "1.125");
    for (const bad of ["", "0", "0.000", "-1", "1.1234", "abc", "1e3"]) assert.equal(parseQty(bad), null, bad);
  });

  test("بدنه: یک نرخ ریالی برای همه، هر تنوع یک بار، بی هیچ جمعی در مرورگر", () => {
    const sel = new Map([["a", "2"], ["b", "۳"]]);
    assert.deepEqual(bulkLines(sel, 1_000_000n), { ok: true, lines: [
      { variationId: "a", qty: "2", unitPrice: "1000000" },
      { variationId: "b", qty: "3", unitPrice: "1000000" },
    ] });
    assert.deepEqual(bulkLines(new Map(), 1n), { ok: false, reason: "empty", invalid: [] });
    assert.deepEqual(bulkLines(sel, null), { ok: false, reason: "price", invalid: [] });
    assert.deepEqual(bulkLines(sel, 0n), { ok: false, reason: "price", invalid: [] });
    assert.deepEqual(bulkLines(new Map([["a", "2"], ["b", "0"]]), 10n), { ok: false, reason: "qty", invalid: ["b"] });
  });

  test("گروه رنگ ترتیب سرور را نگه می‌دارد", () => {
    const v = (id: string, color: string | null, size: string) => ({ id, sku: id, barcode: null, color, size });
    assert.deepEqual(byColor([v("1", "مشکی", "S"), v("2", "مشکی", "M"), v("3", null, "L")]).map(g => [g.color, g.items.map(i => i.size)]),
      [["مشکی", ["S", "M"]], ["بی‌رنگ", ["L"]]]);
  });
});
