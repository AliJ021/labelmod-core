import { describe, test } from "node:test";
import { ROLL_MIN_HEIGHT_MM, ROLL_MIN_WIDTH_MM } from "../../api/src/catalog/label.ts";
import assert from "node:assert/strict";
import {
  LABEL_PRESETS, MAX_TOTAL, clampCount, groupByProduct, labelRequestBody, labelRequestProblem,
  mergeQueue, queueTotal, ROLL_LIMITS, setQueueCount, type QueueItem,
} from "../src/lib/label-print.ts";

const item = (variationId: string, productId: string, count: number): QueueItem => ({
  variationId, productId, productName: `کالا ${productId}`, sku: `SKU-${variationId}`, color: "مشکی", size: "M", count,
});

describe("فهرست چاپ گروهی لیبل", () => {
  test("افزودن دوباره همان تنوع جمع می‌شود و ترتیب اولین افزودن می‌ماند", () => {
    let q = mergeQueue([], [item("v1", "p1", 2), item("v2", "p1", 1)]);
    q = mergeQueue(q, [item("v3", "p2", 4), item("v1", "p1", 3)]);
    assert.deepEqual(q.map((i) => [i.variationId, i.count]), [["v1", 5], ["v2", 1], ["v3", 4]]);
    assert.equal(queueTotal(q), 10);
    assert.deepEqual(groupByProduct(q).map((g) => [g.productId, g.items.length]), [["p1", 2], ["p2", 1]]);
  });

  test("صفر و منفی افزوده نمی‌شوند، سقف هر تنوع ۱۰۰ است، تعداد صفر حذف می‌کند", () => {
    assert.deepEqual(mergeQueue([], [item("v1", "p1", 0), item("v2", "p1", -3)]), []);
    assert.equal(mergeQueue([item("v1", "p1", 90)], [item("v1", "p1", 50)])[0]!.count, 100);
    assert.equal(clampCount(2.7), 2);
    assert.deepEqual(setQueueCount([item("v1", "p1", 2), item("v2", "p1", 1)], "v1", 0).map((i) => i.variationId), ["v2"]);
  });

  test("بدنهٔ درخواست همان قرارداد `POST /labels` است و اندازهٔ رول فقط برای رول می‌رود", () => {
    const q = [item("v1", "p1", 2), item("v2", "p2", 1)];
    assert.deepEqual(labelRequestBody(q, { layout: "roll", width: 40, height: 25 }),
      { items: [{ variationId: "v1", count: 2 }, { variationId: "v2", count: 1 }], layout: "roll", rollWidthMm: 40, rollHeightMm: 25 });
    assert.deepEqual(labelRequestBody(q, { layout: "a4", width: 40, height: 25 }),
      { items: [{ variationId: "v1", count: 2 }, { variationId: "v2", count: 1 }], layout: "a4" });
  });

  test("سقف‌ها همان سقف‌های سرورند", () => {
    const roll = { layout: "roll" as const, width: 50, height: 30 };
    assert.equal(labelRequestProblem([], roll), "هیچ لیبلی انتخاب نشده است.");
    assert.equal(labelRequestProblem([item("v1", "p1", 3)], roll), null);
    const many = Array.from({ length: 6 }, (_, n) => item(`v${n}`, "p", 100));
    assert.match(labelRequestProblem(many, roll) ?? "", new RegExp(String(MAX_TOTAL)));
    assert.match(labelRequestProblem([item("v1", "p1", 1)], { layout: "roll", width: 25, height: 30 }) ?? "", /عرض/);
    assert.match(labelRequestProblem([item("v1", "p1", 1)], { layout: "roll", width: 50, height: 200 }) ?? "", /ارتفاع/);
    assert.equal(labelRequestProblem([item("v1", "p1", 1)], { layout: "a4", width: NaN, height: NaN }), null);
  });

  test("کمینهٔ اندازه همان کمینهٔ سرور است و ابعاد ناممکن با پیام روشن رد می‌شوند", () => {
    assert.equal(ROLL_LIMITS.minWidth, ROLL_MIN_WIDTH_MM);
    assert.equal(ROLL_LIMITS.minHeight, ROLL_MIN_HEIGHT_MM);
    const one = [item("v1", "p1", 1)];
    assert.match(labelRequestProblem(one, { layout: "roll", width: 50, height: 10 }) ?? "", /ارتفاع.*قیمت و بارکد/);
    assert.match(labelRequestProblem(one, { layout: "roll", width: 20, height: 20 }) ?? "", /عرض.*حاشیهٔ سکوت/);
    for (const p of LABEL_PRESETS) assert.equal(labelRequestProblem(one, { layout: "roll", ...p }), null, p.id);
  });
});
