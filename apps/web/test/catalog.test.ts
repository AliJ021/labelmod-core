/**
 * جداکردن فهرست رنگ و سایز.
 *
 * ادعای مرکزی: **ویرگول فارسی هم جداکننده است.**
 *
 * انباردار روی صفحه‌کلید فارسی «سبز، مشکی، سرمه‌ای» می‌نویسد. اگر فقط
 * `,` لاتین شناخته می‌شد، این یک رنگ با نام سه‌تایی می‌شد — و بعد یک
 * بارکد و یک ردیف موجودی برای چیزی که در قفسه سه کالاست. هیچ خطایی هم
 * نمی‌داد.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitList } from "../src/lib/catalog.ts";

test("ویرگول فارسی جدا می‌کند، نه فقط لاتین", () => {
  assert.deepEqual(splitList("سبز، مشکی، سرمه‌ای"), ["سبز", "مشکی", "سرمه‌ای"]);
  assert.deepEqual(splitList("سبز, مشکی"), ["سبز", "مشکی"]);
  assert.deepEqual(splitList("S،M,L"), ["S", "M", "L"]);
});

test("نقطه‌ویرگول فارسی و لاتین هم", () => {
  assert.deepEqual(splitList("۳۰؛ ۳۲; ۳۴"), ["۳۰", "۳۲", "۳۴"]);
});

test("خط تازه هم جداکننده است — چسباندن از فایل کار می‌کند", () => {
  assert.deepEqual(splitList("مشکی\nسفید\nآبی"), ["مشکی", "سفید", "آبی"]);
});

test("فاصله اضافی حذف می‌شود ولی فاصله داخل نام می‌ماند", () => {
  assert.deepEqual(splitList("  سبز لجنی  ،  آبی نفتی "), ["سبز لجنی", "آبی نفتی"]);
});

test("ورودی خالی و جداکننده‌های پشت‌سرهم، آیتم تهی نمی‌سازند", () => {
  assert.deepEqual(splitList(""), []);
  assert.deepEqual(splitList("،،،"), []);
  assert.deepEqual(splitList("مشکی،،سفید،"), ["مشکی", "سفید"]);
});

test("تکراری حذف می‌شود — «مشکی، مشکی» دو تنوع نیست", () => {
  assert.deepEqual(splitList("مشکی، سفید، مشکی"), ["مشکی", "سفید"]);
  // ترتیب اولین ظهور حفظ می‌شود
  assert.deepEqual(splitList("L, S, L, M, S"), ["L", "S", "M"]);
});

test("تکراری با فاصله متفاوت هم یکی شمرده می‌شود", () => {
  assert.deepEqual(splitList("مشکی،  مشکی  "), ["مشکی"]);
});

// ── قیمت فروش در فهرست ────────────────────────────────────────────────

import { priceSummary } from "../src/lib/catalog.ts";

test("قیمت‌های برابر یک مبلغ است، نه بازه", () => {
  assert.deepEqual(
    priceSummary({ sellableCount: 3, sellablePricedCount: 3, priceMin: "12500000", priceMax: "12500000" }),
    { kind: "single", rial: "12500000", missing: 0 },
  );
});

test("قیمت‌های متفاوت بازهٔ واقعی می‌دهند", () => {
  assert.deepEqual(
    priceSummary({ sellableCount: 2, sellablePricedCount: 2, priceMin: "9000000", priceMax: "11000000" }),
    { kind: "range", min: "9000000", max: "11000000", missing: 0 },
  );
});

test("بی‌قیمت هرگز صفر یا مبلغ کامل نیست", () => {
  const s = priceSummary({ sellableCount: 2, sellablePricedCount: 0, priceMin: null, priceMax: null });
  assert.deepEqual(s, { kind: "unpriced", missing: 2 });
  assert.ok(!("rial" in s), "بی‌قیمت نباید مبلغی داشته باشد");
});

test("بخشی بی‌قیمت: مبلغ می‌ماند ولی کسری گفته می‌شود", () => {
  assert.deepEqual(
    priceSummary({ sellableCount: 3, sellablePricedCount: 2, priceMin: "7000000", priceMax: "7000000" }),
    { kind: "single", rial: "7000000", missing: 1 },
  );
  assert.deepEqual(
    priceSummary({ sellableCount: 3, sellablePricedCount: 2, priceMin: "7000000", priceMax: "8000000" }),
    { kind: "range", min: "7000000", max: "8000000", missing: 1 },
  );
});

test("بدون تنوع فروختنی هیچ قیمتی ادعا نمی‌شود", () => {
  assert.deepEqual(
    priceSummary({ sellableCount: 0, sellablePricedCount: 0, priceMin: null, priceMax: null }),
    { kind: "none" },
  );
});

test("مبلغ بزرگ‌تر از Number.MAX_SAFE_INTEGER با bigint مقایسه می‌شود", () => {
  // با Number هر دو به یک عدد گرد می‌شدند و بازه «یک مبلغ» به نظر می‌رسید.
  assert.deepEqual(
    priceSummary({ sellableCount: 2, sellablePricedCount: 2, priceMin: "900719925474099300", priceMax: "900719925474099301" }),
    { kind: "range", min: "900719925474099300", max: "900719925474099301", missing: 0 },
  );
  assert.equal(Number("900719925474099300"), Number("900719925474099301"));
});
