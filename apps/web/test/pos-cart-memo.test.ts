/**
 * قفلِ ساختاریِ بهینه‌سازی سبد صندوق (FND-016).
 *
 * بودجهٔ مصوب ADR-002: «افزودن قلم به سبد زیر ۱۰۰ میلی‌ثانیه روی
 * ضعیف‌ترین دستگاه هدف». اندازه‌گیری در مرورگر واقعی نشان داد از ۵۰ قلم
 * شکسته می‌شد و هزینه **کارِ جاوااسکریپت کلاینت** بود. اصلاح، سه تکه
 * داشت که هر سه **لازم**اند و هر سه بی‌صدا برمی‌گردند:
 *
 *   ۱. `memo` با مقایسه‌کنندهٔ دستی — چون پاسخ سرور شیء تازه می‌دهد و
 *      مقایسهٔ سطحیِ پیش‌فرض همیشه «عوض شده» می‌گوید.
 *   ۲. دیسپچر پایدار با `useMemo(..., [])` — یک وابستگی تازه در آن
 *      آرایه، Prop سطر را هر Render عوض می‌کند و memo را خاموش.
 *   ۳. `fieldset[disabled]` به‌جای `disabled={busy}` روی هر دکمهٔ سطر.
 *
 * ⚠️ **چرا تست روی سورس و نه روی Render:** هر سه تکه وقتی می‌شکنند که
 *    خروجی همچنان **درست** است — صفحه کار می‌کند و فقط کند می‌شود. یک
 *    تست رفتاری این را نمی‌بیند؛ بنچمارک مرورگر می‌بیند ولی در CI
 *    نیست. پس همان چیزی سنجیده می‌شود که واقعاً برمی‌گردد: ساختار.
 *
 * ⚠️ و بند ۲ خطرناک‌ترین است: میدانی که به نمایش سطر اضافه شود و به
 *    مقایسه‌کننده نه، سطر را **به‌روز نشده** می‌گذارد — یعنی صندوق‌دار
 *    عدد کهنه می‌بیند. این بار باگ ساکت نیست، **غلط** است.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/screens/Pos.tsx", import.meta.url), "utf8");

/** بدنهٔ کامپوننت سطر — از `memo(` تا `}, sameLine);`. */
function cartLineBody(): string {
  const start = src.indexOf("const CartLine = memo(function CartLine");
  assert.ok(start > 0, "کامپوننت CartLine پیدا نشد — نام یا شکلش عوض شده.");
  const end = src.indexOf("}, sameLine);", start);
  assert.ok(end > start, "پایان `}, sameLine);` پیدا نشد — مقایسه‌کننده وصل نیست.");
  return src.slice(start, end);
}

/** بدنهٔ مقایسه‌کننده. */
function comparator(): string {
  const start = src.indexOf("function sameLine(");
  assert.ok(start > 0, "مقایسه‌کنندهٔ sameLine پیدا نشد.");
  const end = src.indexOf("\ninterface CartLineProps", start);
  assert.ok(end > start, "پایان sameLine پیدا نشد.");
  return src.slice(start, end);
}

test("مقایسه‌کننده به memo وصل است و panel و on را هم می‌سنجد", () => {
  const cmp = comparator();
  // بی این دو، پنل قیمت و تخفیف سطر باز نمی‌شود و دکمه‌ها به Handler
  // کهنه وصل می‌مانند — یعنی memo کار می‌کند و صفحه خراب است.
  assert.match(cmp, /a\.panel !== b\.panel/, "مقایسه‌کننده `panel` را نمی‌سنجد.");
  assert.match(cmp, /a\.on !== b\.on/, "مقایسه‌کننده `on` را نمی‌سنجد.");
});

test("هر میدانی که سطر می‌کشد در مقایسه‌کننده هست", () => {
  const body = cartLineBody();
  const cmp = comparator();

  const read = new Set<string>();
  for (const m of body.matchAll(/\bl\.([A-Za-z_][A-Za-z0-9_]*)/g)) read.add(m[1]!);

  // ضد‌پوچی: اگر استخراج چیزی پیدا نکند، این تست همیشه سبز می‌شد.
  assert.ok(
    read.size >= 6,
    `فقط ${read.size} میدان استخراج شد — الگوی استخراج شکسته است، نه اینکه سطر ساده شده.`,
  );

  const missing = [...read].filter(
    (f) => !new RegExp(`x\\.${f} === y\\.${f}`).test(cmp),
  );
  assert.deepEqual(
    missing,
    [],
    `این میدان‌ها در سطر نمایش داده می‌شوند ولی در sameLine نیستند: ${missing.join("، ")} — سطر با عوض‌شدنشان به‌روز نمی‌شود.`,
  );
});

test("کمک‌تابعی که کل سطر را می‌گیرد باید شناخته‌شده باشد", () => {
  const body = cartLineBody();
  /*
   * `lineGross(l)` و `adjusted(l)` میدان‌ها را **بدون** نقطه می‌خوانند،
   * پس اسکن بالا آن‌ها را نمی‌بیند. فهرست مجاز یعنی کمک‌تابع تازه
   * این تست را قرمز کند و کسی برود میدان‌هایش را به sameLine اضافه کند.
   *
   *   adjusted(l)   → listPrice، discountAmount
   *   lineGross(l)  → netAmount، discountAmount
   *
   * هر چهار میدان در sameLine هستند.
   */
  const known = new Set(["adjusted", "lineGross"]);
  const whole = new Set<string>();
  for (const m of body.matchAll(/\b([a-zA-Z_][A-Za-z0-9_]*)\(l\)/g)) whole.add(m[1]!);
  const unknown = [...whole].filter((f) => !known.has(f));
  assert.deepEqual(
    unknown,
    [],
    `این کمک‌تابع‌ها کل سطر را می‌گیرند و میدان‌هایشان سنجیده نشده: ${unknown.join("، ")}`,
  );
  assert.ok(whole.size >= 1, "الگوی استخراج کمک‌تابع شکسته است.");
});

test("دیسپچر سطر با آرایهٔ وابستگی خالی ساخته می‌شود", () => {
  // یک وابستگی در این آرایه یعنی هر Render شیء تازه بسازد و memo خاموش
  // شود — بی اینکه هیچ چیزی خراب به نظر بیاید.
  const at = src.indexOf("const rowActions = useMemo<RowActions>(");
  assert.ok(at > 0, "دیسپچر پایدار `rowActions` پیدا نشد.");
  const tail = src.slice(at, src.indexOf("const attachCustomer", at));
  assert.match(tail, /\n {4}\[\],\n {2}\);/, "آرایهٔ وابستگی `rowActions` خالی نیست.");
  // و باید از ref بخواند، وگرنه Closure کهنه می‌گیرد.
  assert.match(tail, /live\.current\./, "دیسپچر از `live.current` نمی‌خواند.");
});

test("غیرفعال‌سازی سطر از fieldset می‌آید، نه از busy روی هر دکمه", () => {
  assert.match(
    src,
    /<fieldset className="lines-wrap" disabled=\{busy\}>/,
    "پوشش `fieldset[disabled]` سبد برداشته شده.",
  );
  /*
   * ⚠️ کامنت‌ها **اول** برداشته می‌شوند: خودِ بدنهٔ سطر یک کامنت دارد که
   *    می‌نویسد «`disabled={busy}` اینجا نیست» — و جست‌وجوی خام روی متن،
   *    همان توضیح را به‌جای کد می‌گرفت و تست را برای همیشه قرمز نگه
   *    می‌داشت. اندازه‌گیری شد، نه حدس.
   */
  const body = cartLineBody().replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/disabled=\{busy/.test(body), "دکمه‌های سطر دوباره `disabled={busy}` گرفتند.");
  assert.ok(
    !/\bbusy\b(?!\s*=\s*\{false\})/.test(body),
    "سطر سبد دوباره به `busy` وابسته شده — memo بی‌اثر می‌شود.",
  );
});
