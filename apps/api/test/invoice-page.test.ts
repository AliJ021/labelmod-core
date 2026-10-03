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
    assert.equal(toTomanExact(12_345_675n), "۱٬۲۳۴٬۵۶۷٫۵");
    assert.equal(toTomanExact(10n), "۱");
    assert.equal(toTomanExact(-15n), "−۱٫۵");
    assert.ok(html.includes("۲٬۴۳۴٬۵۶۷٫۵"), "جمع دقیق روی رسید");
    assert.ok(html.includes("۴۳۴٬۵۶۷٫۵"), "مانده دقیق (۴٬۳۴۵٬۶۷۵ ریال)");
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
    assert.match(html, /<span class="qty">۲<\/span> × <span class="unit">۱٬۲۳۴٬۵۶۷٫۵<\/span>/);
    assert.match(html, /class="disc"[\s\S]*− ۳۴٬۵۶۷٫۵/);
  });
});

