import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  LABEL_PRESETS, MAX_TOTAL, clampCount, groupByProduct, labelContentWarning, labelRequestBody, labelRequestProblem,
  labelSizeIssues, labelSizeProblem, mergeQueue, syncQueueMeta, queueTotal, ROLL_LIMITS, setQueueCount, type QueueItem,
} from "../src/lib/label-print.ts";
import { DEFAULT_SIZE_CHOICE, parseSizeChoice } from "../src/lib/label-size.ts";

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
    // پیام با رقم فارسی، هم‌خوان با بقیهٔ صفحه — «۵۰۰» نه «500».
    assert.match(labelRequestProblem(many, roll) ?? "", new RegExp(MAX_TOTAL.toLocaleString("fa-IR")));
    assert.doesNotMatch(labelRequestProblem(many, roll) ?? "", /[0-9]/);
    assert.match(labelRequestProblem([item("v1", "p1", 1)], { layout: "roll", width: 25, height: 30 }) ?? "", /عرض/);
    assert.match(labelRequestProblem([item("v1", "p1", 1)], { layout: "roll", width: 50, height: 200 }) ?? "", /ارتفاع/);
    assert.equal(labelRequestProblem([item("v1", "p1", 1)], { layout: "a4", width: NaN, height: NaN }), null);
  });

  test("کمینهٔ اندازه همان کمینهٔ سرور است و ابعاد ناممکن با پیام روشن رد می‌شوند", async () => {
    // مسیر رشته‌ای: ایمیج وب `apps/api` را ندارد و `tsc` بیلد آن نباید این را دنبال کند.
    const serverModule = "../../api/src/catalog/label.ts";
    const server = (await import(serverModule)) as { ROLL_MIN_WIDTH_MM: number; ROLL_MIN_HEIGHT_MM: number };
    assert.equal(ROLL_LIMITS.minWidth, server.ROLL_MIN_WIDTH_MM);
    assert.equal(ROLL_LIMITS.minHeight, server.ROLL_MIN_HEIGHT_MM);
    const one = [item("v1", "p1", 1)];
    assert.match(labelRequestProblem(one, { layout: "roll", width: 50, height: 10 }) ?? "", /ارتفاع.*قیمت و بارکد/);
    assert.match(labelRequestProblem(one, { layout: "roll", width: 20, height: 20 }) ?? "", /عرض.*حاشیهٔ سکوت/);
    for (const p of LABEL_PRESETS) assert.equal(labelRequestProblem(one, { layout: "roll", ...p }), null, p.id);
  });

  test("خطای اندازه جدا از تعداد سنجیده می‌شود و رقمش فارسی است", () => {
    assert.equal(labelSizeProblem({ layout: "roll", width: 50, height: 30 }), null);
    assert.equal(labelSizeProblem({ layout: "a4", width: NaN, height: NaN }), null);
    const narrow = labelSizeProblem({ layout: "roll", width: 25, height: 30 }) ?? "";
    assert.match(narrow, /عرض لیبل باید بین ۳۰ و ۱۲۰ میلی‌متر/);
    assert.doesNotMatch(narrow, /[0-9]/);
    assert.match(labelSizeProblem({ layout: "roll", width: 50, height: 15 }) ?? "", /ارتفاع لیبل باید بین ۲۰ و ۱۲۰/);
    // نوشتن نصفه (کادر خالی) هم خطاست، نه «صفر میلی‌متر قابل قبول».
    assert.match(labelSizeProblem({ layout: "roll", width: Number(""), height: 30 }) ?? "", /عرض/);
    // درخواست با اندازهٔ غلط همان پیام را می‌دهد؛ صفحه تکرارش نمی‌کند.
    assert.equal(labelRequestProblem([item("v1", "p1", 1)], { layout: "roll", width: 25, height: 30 }), narrow);
  });

  test("هشدار پیش از چاپ: تنوع بی‌قیمت یا بی‌بارکد شمرده می‌شود و «نمی‌دانیم» هشدار نیست", () => {
    assert.equal(labelContentWarning([]), null);
    assert.equal(labelContentWarning([{ count: 2, priced: true, hasBarcode: true }]), null);
    // فهرست ذخیره‌شدهٔ قدیمی این دو را ندارد: نبودن یعنی نامعلوم، نه هشدار دروغ.
    assert.equal(labelContentWarning([{ count: 2 }]), null);
    // تعداد صفر چاپ نمی‌شود، پس هشدار هم ندارد.
    assert.equal(labelContentWarning([{ count: 0, priced: false }]), null);
    const w = labelContentWarning([{ count: 1, priced: false, hasBarcode: true }, { count: 3, priced: true, hasBarcode: false }, { count: 1, priced: false }]) ?? "";
    assert.match(w, /۲ تنوع انتخاب‌شده قیمت ندارد و روی لیبلش «بدون قیمت» چاپ می‌شود/);
    assert.match(w, /۱ تنوع بارکد ندارد/);
  });

  test("اندازهٔ ذخیره‌شده فقط با شکل معتبر پذیرفته می‌شود", () => {
    assert.deepEqual(parseSizeChoice(null), DEFAULT_SIZE_CHOICE);
    assert.deepEqual(parseSizeChoice("{bad json"), DEFAULT_SIZE_CHOICE);
    assert.deepEqual(parseSizeChoice(JSON.stringify({ layout: "roll", preset: "99x99", width: "5", height: "5" })), DEFAULT_SIZE_CHOICE);
    assert.deepEqual(parseSizeChoice(JSON.stringify({ layout: "x", preset: "40x25", width: "40", height: "25" })), DEFAULT_SIZE_CHOICE);
    assert.deepEqual(parseSizeChoice(JSON.stringify({ layout: "roll", preset: "40x25", width: "40", height: "25" })),
      { layout: "roll", preset: "40x25", width: "40", height: "25" });
    assert.deepEqual(parseSizeChoice(JSON.stringify({ layout: "roll", preset: "custom", width: "۴۵", height: "28" })),
      { layout: "roll", preset: "custom", width: "۴۵", height: "28" });
    assert.equal(DEFAULT_SIZE_CHOICE.preset, "50x30");
  });

  test("افزودن دوبارهٔ همان تنوع، قیمت/بارکدِ صریح تازه را جایگزین می‌کند؛ undefined دادهٔ معلوم را پاک نمی‌کند", () => {
    const meta = (variationId: string, count: number, m: Partial<Pick<QueueItem, "priced" | "hasBarcode">>): QueueItem =>
      ({ ...item(variationId, "p1", count), ...m });
    // false → true: پس از تعیین قیمت و بارکد در صفحهٔ کالا و افزودن دوباره، هشدار برطرف می‌شود.
    const first = [meta("v1", 2, { priced: false, hasBarcode: false }), meta("v2", 1, { priced: true, hasBarcode: true })];
    const adds = [meta("v1", 3, { priced: true, hasBarcode: true })];
    const snapshot = JSON.stringify([first, adds]);
    let q = mergeQueue(first, adds);
    assert.equal(JSON.stringify([first, adds]), snapshot, "ورودی‌ها دست نمی‌خورند");
    assert.deepEqual(q.map((i) => [i.variationId, i.count, i.priced, i.hasBarcode]), [["v1", 5, true, true], ["v2", 1, true, true]]);
    assert.equal(labelContentWarning(q), null);
    // true → false: قیمت برداشته شد؛ هشدار باید برگردد. سقف هر تنوع هم می‌ماند.
    q = mergeQueue(q, [meta("v2", 100, { priced: false })]);
    assert.deepEqual(q.map((i) => [i.variationId, i.count, i.priced, i.hasBarcode]), [["v1", 5, true, true], ["v2", 100, false, true]]);
    assert.match(labelContentWarning(q) ?? "", /۱ تنوع انتخاب‌شده قیمت ندارد/);
    // صف قدیمی بی‌فراداده: افزودن تازه فرادادهٔ صریح را می‌گیرد…
    q = mergeQueue([item("v3", "p2", 1)], [meta("v3", 1, { priced: false, hasBarcode: true })]);
    assert.deepEqual(q.map((i) => [i.count, i.priced, i.hasBarcode]), [[2, false, true]]);
    // …و افزودنِ بی‌فراداده دانستهٔ قبلی را پاک نمی‌کند.
    q = mergeQueue(q, [item("v3", "p2", 1)]);
    assert.deepEqual(q.map((i) => [i.count, i.priced, i.hasBarcode]), [[3, false, true]]);
    assert.ok(!("priced" in mergeQueue([item("v4", "p3", 1)], [item("v4", "p3", 1)])[0]!), "نامعلوم نامعلوم می‌ماند");
  });

  test("خطای اندازه به‌ازای هر بُعد: بُعد درست نامعتبر اعلام نمی‌شود", () => {
    const w = labelSizeIssues({ layout: "roll", width: 25, height: 30 });
    assert.match(w.width ?? "", /عرض/); assert.equal(w.height, null);
    const h = labelSizeIssues({ layout: "roll", width: 50, height: 15 });
    assert.equal(h.width, null); assert.match(h.height ?? "", /ارتفاع/);
    const both = labelSizeIssues({ layout: "roll", width: 25, height: 15 });
    assert.ok(both.width && both.height);
    assert.deepEqual(labelSizeIssues({ layout: "a4", width: NaN, height: NaN }), { width: null, height: null });
  });

  test("راه‌حل هشدار با مشکل جور است: بی‌بارکدِ قیمت‌دار به «قیمت تعیین کنید» فرستاده نمی‌شود", () => {
    const barcodeOnly = labelContentWarning([{ count: 1, priced: true, hasBarcode: false }]) ?? "";
    assert.match(barcodeOnly, /بارکد آن تنوع را بررسی کنید/);
    assert.doesNotMatch(barcodeOnly, /قیمت را تعیین/);
    assert.match(labelContentWarning([{ count: 1, priced: false, hasBarcode: true }]) ?? "", /پیش از چاپ قیمت را تعیین کنید/);
    assert.match(labelContentWarning([{ count: 1, priced: false, hasBarcode: false }]) ?? "", /قیمت را تعیین و بارکد را بررسی کنید/);
  });

  test("دادهٔ تازهٔ کاتالوگ به تنوع‌های فهرست می‌رسد، بی‌تغییر تعداد و ترتیب و بی‌افزودن تنوع تازه", () => {
    const q: QueueItem[] = [{ ...item("v1", "p1", 3), priced: false, hasBarcode: true }, item("v2", "p1", 1), item("v9", "p9", 2)];
    const snapshot = JSON.stringify(q);
    const next = syncQueueMeta(q, [{ variationId: "v1", priced: true, hasBarcode: true }, { variationId: "v2", priced: false, hasBarcode: true },
      { variationId: "v5", priced: true, hasBarcode: true }]);
    assert.equal(JSON.stringify(q), snapshot, "ورودی دست نمی‌خورد");
    assert.deepEqual(next.map((i) => [i.variationId, i.count, i.priced, i.hasBarcode]),
      [["v1", 3, true, true], ["v2", 1, false, true], ["v9", 2, undefined, undefined]]);
    assert.equal(labelContentWarning(next.filter((i) => i.variationId === "v1")), null);
    // بی‌تغییر: همان آرایه، تا ذخیره و رندرِ بی‌دلیل رخ ندهد.
    assert.equal(syncQueueMeta(next, [{ variationId: "v1", priced: true, hasBarcode: true }]), next);
  });
});

