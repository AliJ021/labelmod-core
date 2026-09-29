/**
 * گسترش نظام طراحی، دستهٔ ۱ — کارهای پرتکرار داشبورد از رجیستری ناوبری.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FEATURES, NAV_OPERATIONS, QUICK_ACTIONS, ZONES, quickActionView, type Verdict } from "../src/lib/navigation.ts";

const map = (entries: Record<string, Verdict>) => new Map(Object.entries(entries));
const names = (v: ReturnType<typeof quickActionView>) => v.visible.map(a => a.name);
const every = (verdict: Verdict) => map(Object.fromEntries(NAV_OPERATIONS.map(op => [op, verdict])));

describe("کارهای پرتکرار داشبورد", () => {
  test("مجوز هر کار از مقصدش می‌آید و پرسش تازه‌ای نمی‌سازد", () => {
    for (const a of QUICK_ACTIONS) {
      assert.ok(a.anyOf.length > 0, `${a.name}: کار بی‌مجوز داشبورد وجود ندارد`);
      for (const op of a.anyOf) assert.ok(NAV_OPERATIONS.includes(op), `${a.name}: ${op} بیرون از پرسش‌های ناوبری`);
      const zone = new URL(a.href, "http://x").searchParams.get("page");
      const z = ZONES.find(z => z.key === zone);
      assert.ok(z, `${a.name}: مقصد ناشناخته`);
      const feature = FEATURES.find(f => f.href === a.href);
      assert.deepEqual([...a.anyOf], [...(feature?.anyOf ?? z.anyOf)], `${a.name}: همان مجوز مقصد/ویژگی`);
    }
  });
  test("مدیر کامل: هر چهار کار", () => {
    assert.equal(quickActionView({ state: "ready", verdicts: every("allow") }).visible.length, QUICK_ACTIONS.length);
  });
  test("صندوق‌دار: بدون چاپ لیبل (catalog.manage ندارد)", () => {
    const v = quickActionView({ state: "ready", verdicts: map({ ...Object.fromEntries(NAV_OPERATIONS.map(op => [op, "deny" as Verdict])), "sale.create": "allow", "return.same_day": "allow" }) });
    assert.deepEqual(names(v), ["فروش جدید", "رسیدگی به پیش‌نویس‌ها", "فاکتورها و چاپ رسید"]);
    assert.equal(v.pending, 0); assert.equal(v.degraded, false);
  });
  test("بی هیچ مجوز: هیچ کاری، هیچ جای‌نگهداری", () => {
    const v = quickActionView({ state: "ready", verdicts: every("deny") });
    assert.deepEqual(v, { visible: [], pending: 0, degraded: false });
  });
  test("در حال بررسی: فقط جای‌نگهدار بی‌برچسب — هیچ کار مجوزدار", () => {
    const v = quickActionView({ state: "loading", verdicts: new Map() });
    assert.deepEqual(v.visible, []);
    assert.equal(v.pending, QUICK_ACTIONS.length);
  });
  test("پاسخ نرسیده «مجاز» نیست؛ پیام بررسی دوباره", () => {
    const v = quickActionView({ state: "degraded", verdicts: map({ "sale.create": "allow", "return.same_day": "deny", "return.late": "deny" }) });
    assert.deepEqual(names(v), ["فروش جدید", "رسیدگی به پیش‌نویس‌ها", "فاکتورها و چاپ رسید"]);
    assert.equal(v.pending, 0, "پس از خطا جای‌نگهدار دائمی نمی‌ماند");
    assert.equal(v.degraded, true);
  });
  test("داشبورد فهرست کار جدا ندارد و شرط نقش نمی‌نویسد", () => {
    const src = readFileSync(new URL("../src/screens/Dashboard.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(src, /const QUICK\b/);
    assert.match(src, /quickActionView\(access\)/);
    assert.doesNotMatch(src, /roles\.includes|role ===|"admin"/);
  });
});
