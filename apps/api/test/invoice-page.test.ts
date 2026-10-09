/**
 * صفحه عمومی فاکتور — و hashی که اگر عقب بماند، بی‌صدا می‌شکند.
 *
 * ── چرا این تست وجود دارد ────────────────────────────────────────────
 *
 * دکمه «چاپ یا ذخیره PDF» یک بلوک `<script>` دارد و CSP این صفحه
 * `unsafe-inline` ندارد — فقط یک **hash**. اگر متن اسکریپت یک
 * کاراکتر عوض شود و hash نه، مرورگر اسکریپت را رد می‌کند:
 *
 *   دکمه دیده می‌شود، فشرده می‌شود، و هیچ اتفاقی نمی‌افتد.
 *   هیچ خطایی هم در کنسولِ کاربر نیست.
 *
 * همان کلاسی که `wasm-unsafe-eval` در اسکنر بارکد داشت.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  INVOICE_PAGE_CSP,
  PRINT_SCRIPT,
  invoicePage,
  latinDigits,
  receiptFooterFromSettings,
  toTomanExact,
} from "../src/sales/invoice-page.ts";

describe("صفحه عمومی فاکتور", () => {
  test("انتقال تعویض جدا از وجه و مانده معتبر نمایش داده می‌شود و متن‌ها escape می‌شوند", () => {
    const data = { number: "<img src=x>", shopName: "<script>shop</script>", customerName: "<svg onload=x>",
      occurredAt: new Date("2026-09-06T10:00:00Z"), lines: [], netAmount: 1200000n, taxAmount: 0n,
      shippingAmount: 0n, payableAmount: 1200000n, paidAmount: 200000n, exchangeAmount: 1000000n, dueAmount: 0n };
    const html = invoicePage(data, "Asia/Tehran");
    assert.match(html, /تسویه از تعویض/);
    assert.doesNotMatch(html, /class="due"/);
    assert.doesNotMatch(html, /<img src=x>|<svg onload=x>|<script>shop/);
    assert.match(html, /&lt;img src=x&gt;/);
    assert.match(invoicePage({ ...data, dueAmount: 600000n }, "Asia/Tehran"), /class="due"/);
  });
  test("hash در CSP با متن واقعی اسکریپت می‌خواند", () => {
    const want =
      "sha256-" + createHash("sha256").update(PRINT_SCRIPT, "utf8").digest("base64");
    assert.ok(
      INVOICE_PAGE_CSP.includes(want),
      `hash عقب مانده. CSP باید «${want}» داشته باشد.`,
    );
  });

  test("CSP هرگز unsafe-inline برای اسکریپت نمی‌گیرد", () => {
    // نام کالا ورودی کاربر است و در همین صفحه درج می‌شود. `esc()`
    // لایه اول است و CSP لایه دوم؛ `unsafe-inline` لایه دوم را
    // برمی‌دارد.
    const scriptSrc = INVOICE_PAGE_CSP.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("script-src"));
    assert.ok(scriptSrc, "script-src باید صریح باشد، نه ارثی");
    assert.ok(
      !scriptSrc.includes("unsafe-inline"),
      "script-src نباید unsafe-inline بگیرد",
    );
    assert.ok(scriptSrc.includes("sha256-"), "script-src باید hash داشته باشد");
  });

  test("دکمه با id کار می‌کند، نه با onclick", () => {
    // hash روی `onclick` اعمال **نمی‌شود** — فقط روی بلوک
    // `<script>`. اگر کسی به onclick برگردد، CSP ردش می‌کند و باز هم
    // بی‌صدا.
    assert.ok(
      PRINT_SCRIPT.includes("getElementById('print-btn')"),
      "اسکریپت باید دکمه را با id پیدا کند",
    );
    assert.ok(!PRINT_SCRIPT.includes("onclick"), "onclick با hash کار نمی‌کند");
  });

  test("صفحه واقعاً همان اسکریپت را درج می‌کند", () => {
    const html = invoicePage(
      {
        number: "۱۴۰۵-۰۰۱",
        shopName: "لیبل مد",
        occurredAt: new Date("2026-09-06T10:00:00Z"),
        customerName: null,
        lines: [
          {
            productName: "پیراهن",
            color: "آبی",
            size: "L",
            qty: "1",
            unitPrice: 1000000n,
            discountAmount: 0n,
            netAmount: 1000000n,
          },
        ],
        netAmount: 1000000n,
        taxAmount: 0n,
        shippingAmount: 0n,
        payableAmount: 1000000n,
        paidAmount: 1000000n,
      },
      "Asia/Tehran",
    );

    assert.ok(html.includes(`<script>${PRINT_SCRIPT}</script>`),
      "متن درج‌شده باید دقیقاً همان رشته‌ای باشد که hash از آن ساخته شده");
    assert.ok(html.includes('id="print-btn"'), "دکمه باید id داشته باشد");
    // ⚠️ صفحه چاپ نباید سود یا بها را نشان دهد — این صفحه را مشتری
    // می‌بیند.
    assert.ok(!html.includes("بهای تمام‌شده"));
    assert.ok(!html.includes("سود"));
  });

  test("استایل چاپ، دکمه را روی کاغذ نمی‌فرستد", () => {
    const html = invoicePage(
      {
        number: "۱", shopName: "لیبل مد",
        occurredAt: new Date("2026-09-06T10:00:00Z"),
        customerName: null, lines: [],
        netAmount: 0n, taxAmount: 0n,
        shippingAmount: 0n, payableAmount: 0n, paidAmount: 0n,
      },
      "Asia/Tehran",
    );
    assert.match(html, /@media print/, "بدون استایل چاپ، دکمه روی کاغذ چاپ می‌شود");
    assert.match(html, /\.print-bar\s*\{\s*display:\s*none/);
  });

  // ── عنوان قلم بدون سایز (درخواست مالک ۱۴۰۵/۰۷/۱۰) ──────────────────

  function page(lines: Array<{ productName: string; color: string | null; size: string | null }>) {
    return invoicePage(
      {
        number: "۱", shopName: "لیبل مد",
        occurredAt: new Date("2026-09-06T10:00:00Z"),
        customerName: null,
        lines: lines.map((l) => ({
          ...l, qty: "1", unitPrice: 1000000n, discountAmount: 0n, netAmount: 1000000n,
        })),
        netAmount: 1000000n, taxAmount: 0n,
        shippingAmount: 0n, payableAmount: 1000000n, paidAmount: 1000000n,
      },
      "Asia/Tehran",
    );
  }
  const nameCells = (html: string) =>
    [...html.matchAll(/<td class="name"[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);

  test("عنوان قلم رنگ را دارد و سایز ساخت‌یافته را نه", () => {
    const cells = nameCells(page([{ productName: "پیراهن", color: "آبی", size: "XXL-SIZE" }]));
    assert.deepEqual(cells, ["پیراهن <small>آبی</small>"]);
    assert.ok(!cells[0]!.includes("XXL-SIZE"));
    assert.ok(!cells[0]!.includes(" · "), "جداکنندهٔ رنگ و سایز هم نمی‌ماند");
  });

  test("بی‌رنگ: فقط نام، بی <small> خالی — و سایز باز هم نه", () => {
    assert.deepEqual(nameCells(page([{ productName: "شال", color: null, size: "ONE-SIZE" }])), ["شال"]);
    assert.deepEqual(nameCells(page([{ productName: "شال", color: "", size: "M" }])), ["شال"]);
  });

  test("نام کالا دست‌نخورده است، حتی اگر کلمه‌ای شبیه سایز داشته باشد", () => {
    // فقط میدان ساخت‌یافتهٔ سایز حذف می‌شود؛ هیچ Regexی روی نام اجرا نمی‌شود.
    const cells = nameCells(page([{ productName: "شلوار XL مدل 42", color: "مشکی", size: "XL" }]));
    assert.deepEqual(cells, ["شلوار XL مدل 42 <small>مشکی</small>"]);
  });

  test("نام و رنگ همچنان Escape می‌شوند و سایزِ مخرب جایی درج نمی‌شود", () => {
    const html = page([{ productName: "<img src=x onerror=a()>", color: "<b>قرمز</b>", size: "<script>bad()</script>" }]);
    const cells = nameCells(html);
    assert.equal(cells[0], "&lt;img src=x onerror=a()&gt; <small>&lt;b&gt;قرمز&lt;/b&gt;</small>");
    assert.ok(!html.includes("bad()"), "سایز در هیچ جای صفحه نمی‌آید");
    assert.equal((html.match(/<script>/g) ?? []).length, 1, "فقط اسکریپت چاپ hashدار");
  });

  test("هر قلم سطر خودش را دارد: دو سایز یک کالا دو سطر می‌مانند", () => {
    // حذف سایز از عنوان، سطرها را ادغام نمی‌کند؛ هر سطر همان سطر فاکتور است.
    const cells = nameCells(page([
      { productName: "پیراهن", color: "آبی", size: "M" },
      { productName: "پیراهن", color: "آبی", size: "L" },
    ]));
    assert.equal(cells.length, 2);
  });
});

describe("رسید حرارتی ۸۰ میلی‌متری", () => {
  const data = {
    number: "F-1405-000123", shopName: "لیبل مد", customerName: "مشتری آزمون",
    occurredAt: new Date("2026-09-06T10:00:00Z"),
    lines: [
      { productName: "مانتو کتان بلند با آستین پفی و جیب‌های دوخت دستی مدل تابستانهٔ ۱۴۰۵", color: "سرمه‌ای", size: "L",
        qty: "2.000", unitPrice: 12_345_675n, discountAmount: 345_675n, netAmount: 24_345_675n },
    ],
    netAmount: 24_345_675n, taxAmount: 0n, shippingAmount: 0n,
    payableAmount: 24_345_675n, paidAmount: 20_000_000n,
  };
  const html = invoicePage(data, "Asia/Tehran");

  test("تومان دقیق: ریال کسری حذف نمی‌شود، حتی در منفی", () => {
    assert.equal(toTomanExact(12_345_675n), "1,234,567.5");
    assert.equal(toTomanExact(10n), "1");
    assert.equal(toTomanExact(-15n), "−1.5");
    assert.ok(html.includes("2,434,567.5"), "جمع دقیق روی رسید");
    assert.ok(html.includes("434,567.5"), "مانده دقیق (۴٬۳۴۵٬۶۷۵ ریال)");
  });

  test("قلاب‌های چاپ مستقیم دست‌نخورده‌اند", () => {
    assert.match(html, /<div class="sheet">/);
    assert.match(html, /<table class="totals">/);
    assert.match(html, /id="print-btn"/);
    assert.ok(html.includes(`<script>${PRINT_SCRIPT}</script>`));
  });

  test("چاپ ۷۲mm تک‌رنگ است و ارتفاع کاغذ را تحمیل نمی‌کند", () => {
    assert.match(html, /\.sheet \{\s*width: 72mm; max-width: 72mm;/);
    assert.match(html, /@page \{ margin: 0; \}/);
    assert.doesNotMatch(html, /@page \{[^}]*size/, "طول رول را درایور تعیین می‌کند");
    const printCss = html.slice(html.indexOf("@media print"));
    assert.doesNotMatch(printCss.slice(0, printCss.indexOf("</style>")), /#(?!000|FFF|fff)[0-9a-fA-F]{3,6}\b/, "رنگ غیرسیاه‌وسفید در چاپ");
  });

  test("نام بلند می‌شکند و مبلغ یکپارچه می‌ماند", () => {
    assert.match(html, /\.name \{[^}]*overflow-wrap: anywhere/);
    assert.match(html, /\.num \{[^}]*white-space: nowrap/);
    // تعداد، قیمت واحد و جمع هر کدام ستون خودشان را دارند (نسخهٔ ۳) — همان سه عدد دقیق.
    assert.match(html, /<td class="qty">2<\/td><td class="num unit">1,234,567\.5<\/td><td class="num total">2,434,567\.5<\/td>/);
    assert.match(html, /<th class="qty">تعداد<\/th><th class="num">قیمت واحد<\/th><th class="num">جمع<\/th>/);
    assert.match(html, /class="disc"><td class="idx"><\/td><td colspan="2">تخفیف قلم<\/td><td class="num"><bdi dir="ltr">− 34,567\.5<\/bdi><\/td>/);
  });

  test("پابرگ از تنظیمات زنده: مهلت مرجوعی و سایت؛ متن ثابت سیاست چاپ نمی‌شود", () => {
    const f48 = receiptFooterFromSettings({ return_hours: "48", site_url: "https://labelmod.ir/" });
    assert.deepEqual(f48, { returnWindowHours: 48, website: "labelmod.ir" });
    const page48 = invoicePage({ ...data, ...f48 }, "Asia/Tehran");
    assert.match(page48, /مهلت مرجوعی: 2 روز \(48 ساعت\) پس از خرید/);
    assert.match(page48, /<bdi dir="ltr">labelmod\.ir<\/bdi>/);
    assert.match(invoicePage({ ...data, returnWindowHours: 36 }, "Asia/Tehran"), /مهلت مرجوعی: 36 ساعت پس از خرید/);
    // بی تنظیم معتبر، هیچ سطر سیاستی نیست — حدس زده نمی‌شود.
    assert.deepEqual(receiptFooterFromSettings({ return_hours: null, site_url: "javascript:alert(1)" }), { returnWindowHours: null, website: null });
    assert.doesNotMatch(html, /مهلت مرجوعی/);
    // شماره فاکتور برچسب‌دار و LTR جدا، در جعبهٔ مشخصات (بازطراحی ۱۴۰۵/۰۷).
    assert.match(html, /<dt>شمارهٔ فاکتور<\/dt><dd><bdi dir="ltr" class="docno">F-1405-000123<\/bdi><\/dd>/);
  });
});

describe("بازطراحی رسید — جمع‌ها، پرداخت و وضعیت تسویه", () => {
  const line = (over: Partial<{ discountAmount: bigint; netAmount: bigint; unitPrice: bigint }> = {}) => ({
    productName: "شال", color: null, size: null, qty: "1", unitPrice: 1_000_000n, discountAmount: 0n, netAmount: 1_000_000n, ...over,
  });
  const base = {
    number: "F-1", shopName: "لیبل مد", customerName: null, occurredAt: new Date("2026-09-06T10:00:00Z"),
    taxAmount: 0n, shippingAmount: 0n,
  };

  test("پرداخت‌شده دیده می‌شود و مانده با برچسب و وضعیت «تسویه نشده» برجسته است", () => {
    const html = invoicePage({ ...base, lines: [line()], netAmount: 1_000_000n, payableAmount: 1_000_000n, paidAmount: 400_000n }, "Asia/Tehran");
    assert.match(html, /<tr class="paid"><th>پرداخت‌شده<\/th><td class="num">40,000<\/td><\/tr>/);
    assert.match(html, /<tr class="due"><th><span class="due-tag">مانده<\/span><\/th><td class="num">60,000 <small>تومان<\/small><\/td><\/tr>/);
    assert.match(html, /class="settle settle--open">تسویه نشده/);
  });

  test("فاکتور صفر (تخفیف ۱۰۰٪): قابل پرداخت ۰، بی سطر پرداخت و مانده، «تسویه‌شده»", () => {
    const html = invoicePage({ ...base, lines: [line({ discountAmount: 1_000_000n, netAmount: 0n })],
      netAmount: 0n, payableAmount: 0n, paidAmount: 0n }, "Asia/Tehran");
    assert.match(html, /<tr class="grand"><th>قابل پرداخت<\/th><td class="num">0 <small>تومان<\/small><\/td><\/tr>/);
    assert.doesNotMatch(html, /class="paid"|class="due"/);
    assert.match(html, /<div class="settle">تسویه‌شده<\/div>/);
    assert.match(html, /<tr class="incl"><th>شامل تخفیف اقلام<\/th><td class="num">100,000<\/td><\/tr>/);
  });

  test("«شامل تخفیف اقلام» جمع دقیق تخفیف‌های ذخیره‌شده است و بی تخفیف نمی‌آید؛ «سود» هرگز", () => {
    const html = invoicePage({ ...base, lines: [line({ discountAmount: 12_345n, netAmount: 987_655n }), line({ discountAmount: 5n, netAmount: 999_995n })],
      netAmount: 1_987_650n, payableAmount: 1_987_650n, paidAmount: 1_987_650n }, "Asia/Tehran");
    assert.match(html, /شامل تخفیف اقلام<\/th><td class="num">1,235<\/td>/, "۱۲٬۳۵۰ ریال = ۱٬۲۳۵ تومان، دقیق");
    assert.ok(!html.includes("سود"));
    const plain = invoicePage({ ...base, lines: [line()], netAmount: 1_000_000n, payableAmount: 1_000_000n, paidAmount: 1_000_000n }, "Asia/Tehran");
    assert.doesNotMatch(plain, /class="incl"/);
  });

  test("اقلام شماره‌دارند، بی rowspan؛ ۳۰+ قلم هر کدام سطر خودش را دارد", () => {
    const lines = Array.from({ length: 32 }, () => line());
    const html = invoicePage({ ...base, lines, netAmount: 32_000_000n, payableAmount: 32_000_000n, paidAmount: 32_000_000n }, "Asia/Tehran");
    assert.equal((html.match(/<tbody class="item">/g) ?? []).length, 32);
    assert.match(html, /<td class="idx">32<\/td><td class="name"/);
    assert.doesNotMatch(html, /rowspan/);
    assert.match(html, /<dt>اقلام<\/dt><dd>32 قلم<\/dd>/);
  });

  test("نام مشتری ایزوله است و راهنمای چاپ محدودیت مرورگر را پنهان نمی‌کند", () => {
    const html = invoicePage({ ...base, customerName: "Elizabeth / الیزابت", lines: [line()], netAmount: 1_000_000n, payableAmount: 1_000_000n, paidAmount: 1_000_000n }, "Asia/Tehran");
    assert.match(html, /<dt>مشتری<\/dt><dd><bdi>Elizabeth \/ الیزابت<\/bdi><\/dd>/);
    assert.match(html, /<p class="print-note">[^<]*بی تأیید شما چاپ نمی‌کند/);
    // راهنما داخل print-bar است و همان قاعدهٔ «روی کاغذ نمی‌آید» را دارد.
    assert.match(html, /<div class="print-bar">[\s\S]*class="print-note"[\s\S]*<\/div>/);
  });
});

describe("رقم لاتین روی فاکتور و پیش‌فاکتور (خواستهٔ مالک ۱۴۰۵/۰۷/۱۷)", () => {
  const PERSIAN_OR_ARABIC_DIGIT = /[\u06F0-\u06F9\u0660-\u0669]/;
  const data = {
    number: "F-۱۴۰۵-٠٠٧", shopName: "لیبل مد ۲", customerName: "مریم ۰۹۱۲",
    occurredAt: new Date("2026-10-02T15:40:00Z"),
    lines: [
      { productName: "مانتو مدل ۱۴۰۵ سری ١٢", color: "طوسی ۳", size: "L",
        qty: "1.500", unitPrice: 12_345_675n, discountAmount: 345_675n, netAmount: 18_172_837n },
    ],
    netAmount: 18_172_837n, taxAmount: 0n, shippingAmount: 0n,
    payableAmount: 18_172_837n, paidAmount: 10_000_000n, returnWindowHours: 48, website: "labelmod.ir",
  };
  /** متن دیدنی صفحه: پس از </style>، بی اسکریپت چاپ. */
  const body = (html: string) => html.slice(html.indexOf("</style>")).replace(/<script>[\s\S]*?<\/script>/g, "");

  test("latinDigits فقط رقم فارسی و عربی را عوض می‌کند و متن را دست نمی‌زند", () => {
    assert.equal(latinDigits("مانتو ۱۴۰۵ سری ١٢ — L/XL"), "مانتو 1405 سری 12 — L/XL");
    assert.equal(latinDigits("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩"), "01234567890123456789");
    assert.equal(latinDigits("بی‌رقم"), "بی‌رقم");
  });

  test("هیچ رقم فارسی/عربی در متن فاکتور نیست: مبلغ، تعداد، شماره، تاریخ، ساعت، مهلت و متن ورودی", () => {
    const html = invoicePage(data, "Asia/Tehran");
    assert.doesNotMatch(body(html), PERSIAN_OR_ARABIC_DIGIT);
    assert.doesNotMatch(html.slice(0, html.indexOf("<style>")), PERSIAN_OR_ARABIC_DIGIT, "عنوان صفحه هم");
    // تقویم جلالی می‌ماند (۱۴۰۵/۰۷/۱۰، ساعت ۱۹:۱۰ تهران)؛ فقط شکل رقم لاتین است.
    assert.match(html, /<dt>تاریخ و ساعت<\/dt><dd>10 مهر 1405،? 19:10<\/dd>/);
    assert.match(html, /<bdi dir="ltr" class="docno">F-1405-007<\/bdi>/);
    assert.match(html, /مانتو مدل 1405 سری 12 <small>طوسی 3<\/small>/);
    assert.match(html, /<bdi>مریم 0912<\/bdi>/);
    assert.match(html, /<td class="qty">1\.5<\/td><td class="num unit">1,234,567\.5<\/td><td class="num total">1,817,283\.7<\/td>/);
    assert.match(html, /<dt>اقلام<\/dt><dd>1 قلم<\/dd>/);
    assert.match(html, /<td class="idx">1<\/td>/);
    assert.match(html, /مهلت مرجوعی: 2 روز \(48 ساعت\)/);
    assert.match(html, /<div class="shop">لیبل مد 2<\/div>|<div class="brand">لیبل مد 2<\/div>/);
    // مبالغ همان bigintها، فقط با رقم لاتین.
    assert.ok(html.includes("1,817,283.7"));
    assert.match(html, /<tr class="paid"><th>پرداخت‌شده<\/th><td class="num">1,000,000<\/td><\/tr>/);
    assert.match(html, /<tr class="due">[\s\S]*?817,283\.7 <small>تومان/);
    // جهت و زبان صفحه فارسی می‌ماند؛ هیچ فونت «FD» که رقم را فارسی بکشد در فهرست نیست.
    assert.match(html, /<html lang="fa" dir="rtl">/);
    assert.doesNotMatch(html, /font-family:[^;]*(?:\bVazir\b(?!matn)|FD\b)/);
  });

  test("تعداد هزار به بالا گروه‌بندی نمی‌شود و اعشار بی‌معنا حذف می‌شود", () => {
    const html = invoicePage({ ...data, lines: [{ ...data.lines[0]!, qty: "1200.000", unitPrice: 10n, netAmount: 12_000n, discountAmount: 0n }],
      netAmount: 12_000n, payableAmount: 12_000n, paidAmount: 12_000n }, "Asia/Tehran");
    assert.match(html, /<td class="qty">1200<\/td>/);
  });

  test("پیش‌فاکتور: تیتر و هشدار «فاکتور نهایی نیست»، شمارهٔ مرجع، بی وضعیت تسویه؛ مبالغ همان", () => {
    const sale = invoicePage(data, "Asia/Tehran");
    const pro = invoicePage({ ...data, number: "پیش‌نویس ۱۲", documentKind: "proforma" }, "Asia/Tehran");
    assert.match(pro, /<div class="doc"><span>پیش‌فاکتور<\/span><\/div>/);
    assert.match(pro, /<\/header>\s*<div class="proforma-note">برای بررسی اقلام و قیمت‌ها؛ فاکتور نهایی نیست\.<\/div>/);
    assert.match(pro, /<title>پیش‌فاکتور پیش‌نویس 12 — /);
    // شماره همان دادهٔ فراخوان است (فقط رقمش لاتین)، با برچسب «مرجع» نه «فاکتور».
    assert.match(pro, /<dt>شمارهٔ مرجع<\/dt><dd><bdi dir="ltr" class="docno">پیش‌نویس 12<\/bdi><\/dd>/);
    assert.doesNotMatch(pro, /شمارهٔ فاکتور|رسید فروش/);
    assert.doesNotMatch(pro, /class="settle|تسویه‌شده|تسویه نشده/);
    // جدول جمع و اقلام بایت‌به‌بایت همان فاکتور فروش است.
    const part = (html: string, from: string, to: string) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
    assert.equal(part(pro, '<table class="items">', "</table>"), part(sale, '<table class="items">', "</table>"));
    assert.equal(part(pro, '<table class="totals">', "</table>"), part(sale, '<table class="totals">', "</table>"));
    assert.doesNotMatch(body(pro), PERSIAN_OR_ARABIC_DIGIT);
    // قلاب‌های چاپ همان‌اند.
    assert.ok(pro.includes(`<script>${PRINT_SCRIPT}</script>`));
    assert.match(pro, /<div class="sheet">[\s\S]*<table class="totals">/);
  });

  test("پیش‌فرض فروش است: بی documentKind همان رسید فروش با وضعیت تسویه", () => {
    const html = invoicePage(data, "Asia/Tehran");
    assert.match(html, /<div class="doc"><span>رسید فروش<\/span><\/div>/);
    assert.match(html, /<dt>شمارهٔ فاکتور<\/dt>/);
    assert.doesNotMatch(body(html), /proforma-note|پیش‌فاکتور/);
    assert.match(html, /class="settle settle--open">تسویه نشده/);
    assert.equal(invoicePage({ ...data, documentKind: "sale" }, "Asia/Tehran"), html);
  });
});
