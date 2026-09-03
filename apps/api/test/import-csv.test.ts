/**
 * تست Parser فایل مهاجرت — بدون دیتابیس.
 *
 * ── چرا این فایل هست ────────────────────────────────────────────────
 *
 * فایل‌های این مهاجرت را آدم در **اکسل فارسی روی ویندوز** می‌سازد، و
 * اکسل فارسی سه کار می‌کند که Parser ساده را می‌شکند و هیچ‌کدام هم
 * خطای واضحی نمی‌دهند:
 *
 *   • BOM در ابتدای فایل → نام اولین ستون یک کاراکتر نامرئی می‌گیرد
 *     و «ستون sku پیدا نشد» می‌دهد، در حالی که ستون آنجاست
 *   • نقطه‌ویرگول به‌جای کاما در برخی تنظیمات منطقه‌ای
 *   • رقم فارسی و جداکننده هزارگان در ستون مبلغ
 *
 * هر سه در همان **اولین** اجرا روی داده واقعی پیدا می‌شوند — یعنی
 * بدترین لحظه ممکن، وقتی کسی منتظر است.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, toTable, detectDelimiter, normalizeDigits, CsvError } from "../src/import/csv.ts";
import { productRow, openingRow, stockRow, validateRows } from "../src/import/schema.ts";

describe("Parser فایل CSV", () => {
  test("سطر و ستون ساده", () => {
    assert.deepEqual(parseCsv("a,b\n1,2"), [
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("BOM اکسل حذف می‌شود", () => {
    // ⚠️ بدون این، نام اولین ستون «﻿sku» می‌شود و هیچ ستونی
    //    پیدا نمی‌شود — با پیام خطایی که هیچ‌کس نمی‌فهمد.
    const t = toTable("﻿sku,name\nA-1,پیراهن");
    assert.deepEqual(t.headers, ["sku", "name"]);
    assert.equal(t.rows[0]!.values["sku"], "A-1");
  });

  test("فیلد نقل‌قولی با کامای داخلی", () => {
    const r = parseCsv('a,b\n"تهران، خیابان ولیعصر",۲');
    assert.deepEqual(r[1], ["تهران، خیابان ولیعصر", "۲"]);
  });

  test("خط تازه داخل نقل‌قول، سطر را نمی‌شکند", () => {
    const r = parseCsv('a,b\n"خط اول\nخط دوم",x');
    assert.equal(r.length, 2);
    assert.equal(r[1]![0], "خط اول\nخط دوم");
  });

  test('نقل‌قول دوتایی یعنی یک نقل‌قول واقعی', () => {
    const r = parseCsv('a\n"او گفت ""سلام"""');
    assert.equal(r[1]![0], 'او گفت "سلام"');
  });

  test("پایان خط ویندوزی", () => {
    assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), [
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("خط خالی انتهای فایل، سطر نمی‌سازد", () => {
    // اکسل تقریباً همیشه با یک خط خالی تمام می‌کند.
    const t = toTable("sku,name\nA-1,x\n\n");
    assert.equal(t.rows.length, 1);
  });

  test("نقطه‌ویرگول به‌عنوان جداکننده تشخیص داده می‌شود", () => {
    // اکسل روی ویندوزِ فارسی، در برخی تنظیمات منطقه‌ای.
    assert.equal(detectDelimiter("sku;name;price"), ";");
    const t = toTable("sku;name\nA-1;پیراهن");
    assert.equal(t.rows[0]!.values["name"], "پیراهن");
  });

  test("کامای داخل نقل‌قول، جداکننده را عوض نمی‌کند", () => {
    // ⚠️ اگر کامای داخل نقل‌قول شمرده می‌شد، یک فایل نقطه‌ویرگولی
    //    «کامایی» تشخیص داده می‌شد و همه‌چیز به هم می‌ریخت.
    assert.equal(detectDelimiter('sku;name;"تهران، ایران"'), ";");
  });

  test("نقل‌قول بسته‌نشده خطای روشن می‌دهد", () => {
    assert.throws(() => parseCsv('a\n"ناتمام'), (e: unknown) => e instanceof CsvError);
  });

  test("ستون تکراری رد می‌شود", () => {
    // دو ستون «sku» یعنی یکی‌شان بی‌صدا نادیده گرفته می‌شد.
    assert.throws(() => toTable("sku,sku\n1,2"), (e: unknown) => e instanceof CsvError);
  });

  test("نام ستون حساس به بزرگی و فاصله نیست", () => {
    const t = toTable(" SKU , Name \nA-1,x");
    assert.equal(t.rows[0]!.values["sku"], "A-1");
    assert.equal(t.rows[0]!.values["name"], "x");
  });
});

describe("نرمال‌سازی رقم", () => {
  test("رقم فارسی و عربی", () => {
    assert.equal(normalizeDigits("۱۲۳۴۵"), "12345");
    assert.equal(normalizeDigits("٩٨٧"), "987");
  });

  test("جداکننده هزارگان — لاتین، عربی و فارسی", () => {
    assert.equal(normalizeDigits("1,500,000"), "1500000");
    assert.equal(normalizeDigits("۱٬۵۰۰٬۰۰۰"), "1500000");
    assert.equal(normalizeDigits("۱،۵۰۰،۰۰۰"), "1500000");
  });

  test("فاصله و نیم‌فاصله از کپی‌کردن", () => {
    assert.equal(normalizeDigits(" ۱۵۰ ۰۰۰ "), "150000");
  });
});

describe("قرارداد فایل‌ها", () => {
  const rows = (v: Record<string, string>[]) =>
    v.map((values, i) => ({ values, line: i + 2 }));

  test("کالا: SKU و نام اجباری، بقیه اختیاری", () => {
    const r = validateRows("products.csv", productRow, rows([{ sku: "A-1", name: "پیراهن" }]));
    assert.equal(r.errors.length, 0);
    assert.equal(r.ok[0]!.color, "");
  });

  test("کالا بدون SKU رد می‌شود", () => {
    const r = validateRows("products.csv", productRow, rows([{ sku: "", name: "x" }]));
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0]!.message, /SKU/);
  });

  test("قیمت با رقم فارسی و جداکننده خوانده می‌شود", () => {
    const r = validateRows(
      "products.csv",
      productRow,
      rows([{ sku: "A-1", name: "x", price: "۱٬۵۰۰٬۰۰۰" }]),
    );
    assert.equal(r.errors.length, 0);
    assert.equal(r.ok[0]!.price, 1500000n);
  });

  test("قیمت اعشاری رد می‌شود — پول ریالی اعشار ندارد", () => {
    const r = validateRows(
      "products.csv",
      productRow,
      rows([{ sku: "A-1", name: "x", price: "1500.5" }]),
    );
    assert.equal(r.errors.length, 1);
  });

  test("همه خطاها برمی‌گردند، نه اولی", () => {
    // ⚠️ توقف روی اولین خطا یعنی کسی که فایل هزار سطری دارد، هزار
    //    بار اجرا کند تا همه را پیدا کند.
    const r = validateRows(
      "products.csv",
      productRow,
      rows([{ sku: "", name: "" }, { sku: "", name: "y" }]),
    );
    assert.equal(r.errors.length, 3);
    assert.deepEqual(
      r.errors.map((e) => e.line),
      [2, 2, 3],
    );
  });

  test("موجودی بدون بهای تمام‌شده رد می‌شود", () => {
    // ⚠️ موجودی بدون بها یعنی اولین فروشِ آن کالا سودِ صددرصد نشان
    //    می‌دهد و ترازنامه دارایی‌ای دارد که ارزشش صفر است.
    const r = validateRows("opening-stock.csv", stockRow, rows([{ sku: "A-1", qty: "5" }]));
    assert.ok(r.errors.length > 0);
  });

  test("مؤلفه افتتاحیه فقط چهار مقدار می‌گیرد", () => {
    const ok = validateRows("o.csv", openingRow, rows([{ leg: "cash", amount: "1000" }]));
    assert.equal(ok.errors.length, 0);

    // `inventory` از فایل موجودی می‌آید و `equity` رقم متوازن‌کننده
    // است — هیچ‌کدام ورودی نیستند.
    for (const leg of ["inventory", "equity", "whatever"]) {
      const bad = validateRows("o.csv", openingRow, rows([{ leg, amount: "1000" }]));
      assert.ok(bad.errors.length > 0, `«${leg}» نباید پذیرفته شود`);
    }
  });
});
