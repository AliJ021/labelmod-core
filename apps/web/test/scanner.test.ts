/**
 * تشخیص اسکنر از تایپ انسان.
 *
 * این تست‌ها زمان را **می‌سازند** نه اینکه صبر کنند: `push` زمان را
 * پارامتر می‌گیرد، پس سناریوی «انسان تند تایپ می‌کند» واقعاً ساختنی
 * است و تست نه کند می‌شود نه لرزان.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ScanBuffer, type ScanStep } from "../src/lib/scanner.ts";

/** یک رشته را با فاصله ثابت میان کلیدها می‌خوراند. */
function type(buf: ScanBuffer, text: string, gapMs: number, start = 1000): ScanStep[] {
  const out: ScanStep[] = [];
  let t = start;
  for (const ch of text) {
    out.push(buf.push(ch, t));
    t += gapMs;
  }
  return out;
}

const EAN13 = "2001234567890";

describe("اسکن واقعی", () => {
  test("رشته سریع با Enter، یک بارکد می‌دهد", () => {
    const buf = new ScanBuffer();
    type(buf, EAN13, 10);
    const end = buf.push("Enter", 1000 + 13 * 10);
    assert.deepEqual(end, { kind: "scanned", barcode: EAN13 });
  });

  test("بعد از اسکن، بافر خالی است", () => {
    const buf = new ScanBuffer();
    type(buf, EAN13, 10);
    buf.push("Enter", 1200);
    assert.equal(buf.pending, "");
  });

  test("دو اسکن پشت سر هم، دو بارکد جدا", () => {
    const buf = new ScanBuffer();
    type(buf, EAN13, 10, 1000);
    assert.deepEqual(buf.push("Enter", 1130), { kind: "scanned", barcode: EAN13 });

    const second = "2009876543210";
    type(buf, second, 10, 5000);
    assert.deepEqual(buf.push("Enter", 5130), { kind: "scanned", barcode: second });
  });

  test("فقط رقم اول عبور می‌کند؛ بقیه بلعیده می‌شوند", () => {
    // یعنی حداکثر یک رقم می‌تواند در فیلد فوکوس‌دار نشت کند.
    const buf = new ScanBuffer();
    const steps = type(buf, EAN13, 10);
    assert.deepEqual(steps[0], { kind: "ignored" }, "رقم اول هنوز قابل تشخیص نیست");
    for (const s of steps.slice(1)) {
      assert.deepEqual(s, { kind: "consumed" });
    }
  });

  test("EAN-8 هم پذیرفته می‌شود", () => {
    const buf = new ScanBuffer();
    type(buf, "20012345", 10);
    assert.deepEqual(buf.push("Enter", 1100), { kind: "scanned", barcode: "20012345" });
  });
});

describe("تایپ انسان اسکن حساب نمی‌شود", () => {
  test("سرعت انسانی، حتی با Enter، بارکد نمی‌دهد", () => {
    // ۱۲۰ میلی‌ثانیه بین کلیدها — تایپ تند ولی انسانی.
    const buf = new ScanBuffer();
    type(buf, EAN13, 120);
    const end = buf.push("Enter", 1000 + 13 * 120);
    assert.deepEqual(end, { kind: "ignored" });
  });

  test("هیچ کلیدی از تایپ انسان بلعیده نمی‌شود", () => {
    // مهم‌ترین ادعای این فایل: اگر صندوق‌دار در فیلد مبلغ نقد عدد
    // بزند، هیچ رقمی نباید ناپدید شود.
    const buf = new ScanBuffer();
    for (const s of type(buf, "1500000", 150)) {
      assert.deepEqual(s, { kind: "ignored" });
    }
  });

  test("Enter تنها — تأیید فرم — دست‌نخورده می‌ماند", () => {
    const buf = new ScanBuffer();
    assert.deepEqual(buf.push("Enter", 1000), { kind: "ignored" });
  });

  test("عدد کوتاهِ سریع بارکد نیست", () => {
    // صفحه‌کلید عددی: «۱۲۳» تند زده شده. زیر حداقل طول است.
    const buf = new ScanBuffer();
    type(buf, "123", 10);
    assert.deepEqual(buf.push("Enter", 1040), { kind: "ignored" });
  });
});

describe("رشته خراب دور انداخته می‌شود", () => {
  test("حرف وسط بارکد، کل بافر را باطل می‌کند", () => {
    const buf = new ScanBuffer();
    type(buf, "200123", 10, 1000);
    assert.deepEqual(buf.push("a", 1060), { kind: "ignored" });
    assert.equal(buf.pending, "", "بافر خالی شد");
    // Enter بعدی نباید بقیه رشته را به‌عنوان بارکد جا بزند.
    assert.deepEqual(buf.push("Enter", 1070), { kind: "ignored" });
  });

  test("مکث وسط اسکن، رشته را نصف نمی‌کند بلکه از نو شروع می‌کند", () => {
    const buf = new ScanBuffer();
    type(buf, "200123", 10, 1000);
    // ۵۰۰ میلی‌ثانیه مکث، بعد ادامه سریع.
    type(buf, "4567890", 10, 1600);
    // آنچه مانده فقط بخش دوم است — نه چسبِ دو تکه که یک بارکد جعلی بسازد.
    assert.equal(buf.pending, "4567890");
    assert.deepEqual(buf.push("Enter", 1700), { kind: "ignored" }, "زیر حداقل طول");
  });

  test("رشته بلندتر از سقف پذیرفته نمی‌شود", () => {
    const buf = new ScanBuffer({ maxLength: 12 });
    type(buf, "1234567890123", 10);
    assert.equal(buf.pending, "");
  });

  test("کلیدهای کنترلی مثل Shift و Tab بافر را باطل می‌کنند", () => {
    const buf = new ScanBuffer();
    type(buf, "200123", 10, 1000);
    assert.deepEqual(buf.push("Tab", 1060), { kind: "ignored" });
    assert.equal(buf.pending, "");
  });
});

describe("تنظیم‌پذیری", () => {
  test("آستانه سست‌تر، تایپ انسان را هم اسکن می‌خواند", () => {
    // اثباتِ اینکه آستانه واقعاً همان چیزی است که تصمیم می‌گیرد.
    const buf = new ScanBuffer({ maxGapMs: 200 });
    type(buf, EAN13, 120);
    assert.deepEqual(buf.push("Enter", 1000 + 13 * 120), {
      kind: "scanned",
      barcode: EAN13,
    });
  });
});
