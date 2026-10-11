/**
 * «نیاز به رسیدگی» داشبورد — هر مورد علت و اقدام (دکمه، پیوند مجاز یا جملهٔ
 * «کار چه کسی است») دارد؛ دورهٔ امروز اطلاع است نه هشدار. رفتار مرورگر و سه
 * حالتِ «خالی / بی‌دسترسی / خطا» در `e2e/dashboard-attention.spec.ts`.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { attentionItems } from "../src/lib/dashboard-attention.ts";
import type { UnpostedRow } from "../src/lib/pos.ts";

const TODAY = "2026-09-16";
const row = (over: Partial<UnpostedRow>): UnpostedRow => ({
  batchId: "x", batchKind: "channel_day", branchId: "b1", channel: "web", businessDate: "2026-09-15",
  invoiceCount: 12, payableAmount: "12340000", cogsAmount: "9000000", ...over,
} as UnpostedRow);

describe("نیاز به رسیدگی", () => {
  test("دورهٔ گذشتهٔ کانال: علت + دکمهٔ بستن فقط با مجوز؛ بی‌مجوز جملهٔ «کار حسابدار است»", () => {
    const [ok] = attentionItems([row({})], TODAY, true, "/?page=pos");
    assert.equal(ok!.tone, "attention");
    assert.equal(ok!.title, "۱۲ فاکتور سایت در ۲۴ شهریور ۱۴۰۵ هنوز به دفتر نرفته");
    assert.match(ok!.cause, /سود و ترازنامه ناقص‌اند/);
    assert.deepEqual(ok!.action, { kind: "close" });
    assert.equal(ok!.note, null);
    const [no] = attentionItems([row({})], TODAY, false, "/?page=pos");
    assert.equal(no!.action, null);
    assert.equal(no!.note, "بستن دوره دسترسی حسابدار می‌خواهد");
    assert.match(no!.cause, /به حسابدار یا مدیر خبر دهید/);
  });

  test("دورهٔ امروز اطلاع است، نه هشدار؛ هرگز دکمهٔ بستن ندارد", () => {
    for (const kind of ["channel_day", "shift"]) {
      const [i] = attentionItems([row({ batchKind: kind, businessDate: TODAY })], TODAY, true, "/?page=pos");
      assert.equal(i!.tone, "info", kind);
      assert.equal(i!.action, null, kind);
      assert.ok(i!.note, `${kind}: جملهٔ توضیح`);
      assert.match(i!.cause, /کاری لازم نیست/);
    }
  });

  test("شیفت گذشته: پیوند صندوق فقط برای نقشی که صندوق دارد؛ وگرنه کار صندوق‌دار است", () => {
    const shift = row({ batchKind: "shift", channel: "pos", businessDate: "2026-09-14" });
    const [withPos] = attentionItems([shift], TODAY, true, "/?page=pos");
    assert.deepEqual(withPos!.action, { kind: "link", href: "/?page=pos", label: "رفتن به صندوق" });
    assert.equal(withPos!.tone, "attention");
    const [without] = attentionItems([shift], TODAY, true, null);
    assert.equal(without!.action, null);
    assert.equal(without!.note, "با بستن شیفت صندوق بسته می‌شود");
    assert.match(without!.cause, /صندوق‌دار کشو را نشمارد/);
  });

  test("کارهای مانده اول، اطلاع‌ها بعد — بی گم‌شدن هیچ سطر", () => {
    const rows = [
      row({ batchId: "t", businessDate: TODAY }),
      row({ batchId: "a" }),
      row({ batchId: "s", batchKind: "shift", businessDate: TODAY }),
      row({ batchId: "b", businessDate: "2026-09-10" }),
    ];
    const items = attentionItems(rows, TODAY, true, null);
    assert.deepEqual(items.map(i => i.key), ["a", "b", "t", "s"]);
    assert.deepEqual(items.map(i => i.tone), ["attention", "attention", "info", "info"]);
  });
});
