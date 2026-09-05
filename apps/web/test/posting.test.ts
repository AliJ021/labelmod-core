/**
 * «کدام دوره از داشبورد بسته می‌شود» — و چرا بقیه نه.
 *
 * چرا این تست ارزش دارد: دکمه «بستن دوره» تا امروز `onClick` نداشت و
 * بی‌صدا هیچ کاری نمی‌کرد. حالا که کار می‌کند، سه شرطی که جلویش را
 * می‌گیرند مهم‌تر از خودِ دکمه‌اند:
 *
 *   دوره شیفت    → با شمردن کشو بسته می‌شود، نه با این دکمه
 *   دوره امروز   → بستنش، هر فروش بعدیِ همان روز را رد می‌کند
 *   بدون مجوز    → سرور ۴۰۳ می‌دهد؛ دکمه نباید به بن‌بست ببرد
 *
 * هر سه شکست **بی‌صدا**اند: دکمه‌ای که نباید باشد، هیچ خطایی نمی‌دهد
 * تا وقتی کسی رویش کلیک کند.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { canClosePeriod, periodNote, type UnpostedRow } from "../src/lib/pos.ts";

const TODAY = "1405-06-14";

function row(over: Partial<UnpostedRow> = {}): UnpostedRow {
  return {
    batchId: "b1",
    batchKind: "channel_day",
    branchId: "br1",
    channel: "web",
    businessDate: "1405-06-13",
    invoiceCount: 3,
    payableAmount: "1500000",
    cogsAmount: "900000",
    ...over,
  };
}

describe("بستن دوره از داشبورد", () => {
  test("دوره کانالِ روز گذشته، با مجوز، بسته می‌شود", () => {
    assert.equal(canClosePeriod(row(), TODAY, true), true);
    assert.equal(periodNote(row(), TODAY, true), undefined, "توضیحی لازم نیست");
  });

  test("دوره شیفت از این مسیر بسته نمی‌شود", () => {
    const r = row({ batchKind: "shift" });
    assert.equal(canClosePeriod(r, TODAY, true), false);
    assert.equal(periodNote(r, TODAY, true), "با بستن شیفت صندوق بسته می‌شود");
  });

  test("دوره امروز هرگز — حتی با مجوز کامل", () => {
    // بستن دوره امروز یعنی سفارش ساعت ۸ شب همان روز با «دوره ثبت این
    // فاکتور قبلاً بسته شده است» رد شود. کار شبانه هم امروز را رد
    // می‌کند؛ این همان قاعده در لایه UI است.
    const r = row({ businessDate: TODAY });
    assert.equal(canClosePeriod(r, TODAY, true), false);
    assert.equal(periodNote(r, TODAY, true), "دوره امروز هنوز باز است");
  });

  test("بدون مجوز، دکمه نیست ولی دلیلش گفته می‌شود", () => {
    assert.equal(canClosePeriod(row(), TODAY, false), false);
    assert.equal(periodNote(row(), TODAY, false), "بستن دوره دسترسی حسابدار می‌خواهد");
  });

  test("ترتیب دلیل‌ها: نوع دوره پیش از تاریخ و مجوز", () => {
    // دوره شیفتِ امروزِ بی‌مجوز باید بگوید «با بستن شیفت» — دقیق‌ترین
    // دلیل، نه اولین شرطی که رد شده.
    const r = row({ batchKind: "shift", businessDate: TODAY });
    assert.equal(periodNote(r, TODAY, false), "با بستن شیفت صندوق بسته می‌شود");
  });
});
