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
} from "../src/sales/invoice-page.ts";

describe("صفحه عمومی فاکتور", () => {
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
});
