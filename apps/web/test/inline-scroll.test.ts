/**
 * ردیف افقی در هر سه مدل تاریخی `scrollLeft` در RTL و در LTR (یافتهٔ F-110-03).
 *
 * شبیه‌ساز فقط یک چیز فیزیکی دارد: `x`، فاصلهٔ لبهٔ چپ دید از لبهٔ چپ محتوا
 * (۰ تا max). هر مدل فقط نگاشت `scrollLeft` به `x` را عوض می‌کند؛ هندسهٔ
 * زبانه‌ها در همه یکی است. اگر کد به معنای `scrollLeft` تکیه کند، دست‌کم در
 * یکی از مدل‌ها شکست می‌خورد.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { centerInline, hiddenEdges } from "../src/lib/inline-scroll.ts";

type Model = "negative" | "positive-ascending" | "positive-descending" | "ltr";
const MODELS: readonly Model[] = ["negative", "positive-ascending", "positive-descending", "ltr"];
const VIEW = 300, TAB = 100, COUNT = 8, CONTENT = TAB * COUNT, MAX = CONTENT - VIEW;

function strip(model: Model) {
  const rtl = model !== "ltr";
  let x = rtl ? MAX : 0; // دید در آغاز منطقی: RTL سمت راست، LTR سمت چپ
  const toX = (s: number) => model === "negative" ? s + MAX : model === "positive-descending" ? MAX - s : s;
  const fromX = (v: number) => model === "negative" ? v - MAX : model === "positive-descending" ? MAX - v : v;
  const scroller = {
    get scrollLeft() { return fromX(x); },
    set scrollLeft(s: number) { x = Math.min(MAX, Math.max(0, toX(s))); },
  };
  // زبانهٔ i به ترتیب منطقی؛ در RTL از راست چیده می‌شود.
  const tab = (i: number) => {
    const left = (rtl ? CONTENT - (i + 1) * TAB : i * TAB) - x;
    return { left, right: left + TAB };
  };
  const view = { left: 0, right: VIEW };
  const edges = () => hiddenEdges(view, { left: Math.min(tab(0).left, tab(COUNT - 1).left), right: Math.max(tab(0).right, tab(COUNT - 1).right) }, rtl);
  const offset = (i: number) => () => { const t = tab(i); return (t.left + t.right) / 2 - VIEW / 2; };
  const reveal = (i: number) => centerInline(scroller, offset(i));
  return { rtl, scroller, tab, edges, offset, reveal, setX: (v: number) => { x = v; } };
}

for (const model of MODELS) {
  test(`${model}: آغاز منطقی — نشانهٔ پایان، بی نشانهٔ آغاز`, () => {
    const s = strip(model);
    assert.deepEqual(s.edges(), { start: false, end: true });
    const first = s.tab(0);
    assert.ok(first.left >= 0 && first.right <= VIEW, "نخستین زبانه دیده می‌شود");
  });

  test(`${model}: میانه — هر دو نشانه`, () => {
    const s = strip(model);
    s.reveal(4);
    assert.deepEqual(s.edges(), { start: true, end: true });
    assert.ok(Math.abs(s.offset(4)()) < 1, "زبانهٔ میانی در وسط");
  });

  test(`${model}: پایان منطقی — نشانهٔ آغاز، بی نشانهٔ پایان`, () => {
    const s = strip(model);
    s.reveal(COUNT - 1);
    assert.deepEqual(s.edges(), { start: true, end: false });
    const last = s.tab(COUNT - 1);
    assert.ok(last.left >= -0.5 && last.right <= VIEW + 0.5, "آخرین زبانه کامل دیده می‌شود");
  });

  test(`${model}: برگشت به آغاز و وسط‌کردن هر زبانه تا جای ممکن`, () => {
    const s = strip(model);
    s.reveal(COUNT - 1);
    s.reveal(0);
    assert.deepEqual(s.edges(), { start: false, end: true }, "نخستین زبانه دوباره به آغاز برمی‌گردد");
    for (let i = 0; i < COUNT; i++) {
      s.reveal(i);
      const t = s.tab(i);
      assert.ok(t.left >= -0.5 && t.right <= VIEW + 0.5, `زبانهٔ ${i} پس از وسط‌کردن کامل دیده می‌شود`);
      // زبانه‌های وسطی دقیقاً وسط می‌نشینند؛ دو سر فقط تا لبهٔ محتوا.
      if (i >= 1 && i <= COUNT - 2) assert.ok(Math.abs(s.offset(i)()) < 1, `زبانهٔ ${i} در وسط`);
    }
  });

  test(`${model}: هدفی که از پیش در وسط است جابه‌جا نمی‌شود`, () => {
    const s = strip(model);
    s.reveal(3);
    const before = s.scroller.scrollLeft;
    s.reveal(3);
    assert.equal(s.scroller.scrollLeft, before);
  });
}

test("ردیف کوتاه‌تر از دید هیچ نشانه‌ای ندارد، در هر دو جهت", () => {
  for (const rtl of [true, false]) {
    assert.deepEqual(hiddenEdges({ left: 0, right: 300 }, { left: 20, right: 280 }, rtl), { start: false, end: false });
    // خطای زیرپیکسلی گرد کردن، نشانهٔ کاذب نمی‌سازد.
    assert.deepEqual(hiddenEdges({ left: 0, right: 300 }, { left: -0.6, right: 300.6 }, rtl), { start: false, end: false });
  }
});
