/**
 * CSV — سه چیزی که بی‌صدا خراب می‌شوند.
 *
 * هیچ‌کدام با «فایل دانلود شد» معلوم نمی‌شوند: اولی وقتی معلوم می‌شود
 * که کاربر فایل را در اکسل باز کند، دومی وقتی که دیگر دیر است، و
 * سومی وقتی که یک عدد ریالی چند رقم آخرش عوض شده باشد.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { cell, contentDisposition, rowsToCsv, safeFilename, toCsv } from "../src/lib/csv.ts";

describe("CSV", () => {
  test("فایل با BOM شروع می‌شود", () => {
    // بدون BOM اکسل ویندوز فارسی را با کدگذاری محلی می‌خواند و
    // «پیراهن» نامفهوم می‌شود. کاربر فکر می‌کند گزارش خراب است.
    const out = toCsv(["نام"], [["پیراهن"]]);
    assert.equal(out.codePointAt(0), 0xfeff, "BOM باید اولین نویسه باشد");
    assert.ok(out.includes("پیراهن"));
  });

  test("خط‌ها با CRLF جدا می‌شوند", () => {
    const out = toCsv(["a", "b"], [["1", "2"]]);
    assert.ok(out.includes("a,b\r\n1,2\r\n"), JSON.stringify(out));
  });

  // ── خنثی‌سازی فرمول ─────────────────────────────────────────────

  test("سلولی که با = شروع شود فرمول نمی‌ماند", () => {
    // **ادعای مرکزی.** نام کالا ورودی کاربر است و اکسل بیرون از
    // مرورگر باز می‌شود — جایی که هیچ CSP‌ای نیست.
    assert.equal(cell('=HYPERLINK("http://بد","کلیک")'), '"\'=HYPERLINK(""http://بد"",""کلیک"")"');
  });

  test("هر چهار آغازگر فرمول اکسل خنثی می‌شوند", () => {
    for (const c of ["=", "+", "-", "@"]) {
      assert.ok(cell(`${c}cmd`).startsWith("'"), `${c} خنثی نشد`);
    }
    // Tab و CR هم آغازگرند. این دو خودشان نقل‌قول هم می‌گیرند، پس
    // آپاستروف **داخل** نقل‌قول می‌نشیند — که همان‌جا درست است: اکسل
    // نقل‌قول را قاب می‌بیند و مقدار را با آپاستروف می‌خواند.
    assert.equal(cell("\tcmd"), "'\tcmd");
    assert.equal(cell("\rcmd"), '"\'\rcmd"');
  });

  test("متن سالم آپاستروف نمی‌گیرد", () => {
    // خنثی‌سازیِ بیش از حد یعنی هر سلول یک آپاستروف اضافه بگیرد و
    // گزارش برای خواندن آدم بدشکل شود.
    assert.equal(cell("پیراهن آبی"), "پیراهن آبی");
    assert.equal(cell("2000000"), "2000000");
    assert.equal(cell("۱۲۳"), "۱۲۳");
  });

  test("عدد منفی هم خنثی می‌شود — و این عمدی است", () => {
    // `-500` برای اکسل یک فرمول است. آپاستروف یعنی به‌شکل **متن**
    // دیده شود؛ در یک گزارش مالی، درست‌بودن مقدم بر جمع‌پذیری است.
    assert.equal(cell("-500"), "'-500");
  });

  // ── نقل‌قول ──────────────────────────────────────────────────────

  test("ویرگول، نقل‌قول و خط تازه درست Escape می‌شوند", () => {
    assert.equal(cell("الف,ب"), '"الف,ب"');
    assert.equal(cell('او گفت "سلام"'), '"او گفت ""سلام"""');
    assert.equal(cell("خط۱\nخط۲"), '"خط۱\nخط۲"');
  });

  // ── مقدار غایب ──────────────────────────────────────────────────

  test("null سلول خالی می‌شود، نه رشته null", () => {
    // در یک ستون مبلغ، «null» عددی به نظر می‌رسد که نیست.
    assert.equal(cell(null), "");
    assert.equal(cell(undefined), "");
    const out = rowsToCsv([["a", "الف"], ["b", "ب"]] as const, [{ a: "۱", b: null }]);
    assert.ok(out.endsWith("۱,\r\n"), JSON.stringify(out));
  });

  // ── ترتیب ستون ──────────────────────────────────────────────────

  test("ترتیب ستون از تعریف می‌آید، نه از ترتیب کلیدهای شیء", () => {
    // تکیه به ترتیب کلیدها یعنی یک بازآرایی بی‌ربط در کد، ستون‌های
    // گزارش را جابه‌جا کند بی‌آنکه کسی بفهمد.
    const out = rowsToCsv(
      [["b", "دوم"], ["a", "اول"]] as const,
      [{ a: "A", b: "B" }],
    );
    assert.ok(out.includes("دوم,اول\r\nB,A"), JSON.stringify(out));
  });

  // ── پول ─────────────────────────────────────────────────────────

  test("مبلغ بزرگ دست‌نخورده می‌ماند", () => {
    // مبالغ ریالی از دقت `number` جاوااسکریپت بیرون می‌زنند. اگر
    // جایی از میان `Number` رد شود، رقم‌های آخر عوض می‌شوند.
    const big = "92233720368547758079";
    const out = rowsToCsv([["amount", "مبلغ"]] as const, [{ amount: big }]);
    assert.ok(out.includes(big), "مبلغ باید عیناً بیاید");
  });

  // ── نام فایل ────────────────────────────────────────────────────

  test("نام فایل هدر را تزریق‌پذیر نمی‌کند", () => {
    assert.equal(safeFilename('a"b\nContent-Type: x'), "a-b-Content-Type--x");
    assert.equal(safeFilename(""), "report");
    assert.ok(safeFilename("x".repeat(200)).length <= 80);
  });

  test("نامی که فقط خط تیره بماند، به report برمی‌گردد", () => {
    // یک نام کاملاً فارسی همه‌اش خط تیره می‌شود. `-----.csv` از
    // `report.csv` بدتر است.
    assert.equal(safeFilename("گزارش"), "report");
    assert.equal(safeFilename("---"), "report");
  });

  test("هدر دانلود نام فارسی هم می‌دهد", () => {
    const h = contentDisposition("گزارش فروش", "sales");
    assert.ok(h.includes('filename="sales.csv"'), h);
    // RFC 5987 — مرورگر امروزی این را ترجیح می‌دهد و کاربر نام فارسی
    // می‌بیند، نه یک مشت خط تیره.
    assert.ok(h.includes("filename*=UTF-8''"), h);
    assert.ok(h.includes(encodeURIComponent("گزارش فروش")), h);
  });

  test("نام فارسی هدر را نمی‌شکند", () => {
    // درصد-کدگذاری هر نویسه خطرناک هدر را می‌پوشاند.
    const h = contentDisposition('x"\ny', "ok");
    assert.ok(!h.includes("\n"), h);
    assert.ok(!h.slice(h.indexOf("filename*")).includes('"'), h);
  });
});
