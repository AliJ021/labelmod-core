/**
 * ریاضی مرجوعی.
 *
 * مبلغ بازپرداخت را **کلاینت می‌فرستد**، پس این اعداد روی پولی که
 * از کشو بیرون می‌رود اثر دارند. سقفش را دیتابیس می‌گذارد، ولی عددی
 * که با سند نخواند یعنی صندوق‌دار روی صفحه یک مبلغ می‌بیند و روی
 * سند مبلغ دیگری.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  clampQty,
  hasSelection,
  maxReturnable,
  selectionToLines,
  type Returnable,
  type Selection,
} from "../src/lib/returns.ts";

const line = (over: Partial<Returnable> = {}): Returnable => ({
  invoiceLineId: "l1",
  soldQty: "2",
  remainingQty: "2",
  netAmount: "2000000",
  ...over,
});

const pick = (pairs: Array<[string, number]>): Selection => new Map(pairs);

describe("چقدر قابل برگشت است", () => {
  test("همان مقدار باقی‌مانده", () => {
    assert.equal(maxReturnable(line({ remainingQty: "3" })), 3);
  });

  test("سطری که کاملاً برگشته", () => {
    assert.equal(maxReturnable(line({ remainingQty: "0" })), 0);
  });

  test("انتخاب بیش از باقی‌مانده بریده می‌شود", () => {
    assert.equal(clampQty(line({ remainingQty: "2" }), 5), 2);
  });

  test("انتخاب منفی یا بی‌معنا صفر است", () => {
    assert.equal(clampQty(line(), -1), 0);
    assert.equal(clampQty(line(), Number.NaN), 0);
  });
});

describe("انتخاب", () => {
  test("تشخیص انتخاب خالی", () => {
    assert.equal(hasSelection(pick([])), false);
    assert.equal(hasSelection(pick([["a", 0]])), false);
    assert.equal(hasSelection(pick([["a", 0], ["b", 1]])), true);
  });

  test("تبدیل به شکل درخواست، بدون سطرهای صفر", () => {
    const out = selectionToLines(pick([["a", 2], ["b", 0], ["c", 1]]));
    assert.deepEqual(out, [
      { invoiceLineId: "a", qty: "2", restock: true },
      { invoiceLineId: "c", qty: "1", restock: true },
    ]);
  });

  test("تعداد رشته است، نه عدد", () => {
    // همان قاعده سراسری: عدد جاوااسکریپت در مرز API قابل اعتماد نیست.
    const [first] = selectionToLines(pick([["a", 3]]));
    assert.equal(typeof first?.qty, "string");
  });
});
