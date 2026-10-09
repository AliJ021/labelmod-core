/**
 * لوگوی رسید — جاسازی data:، درمان تک‌رنگ از روی پیکسل‌ها، و نبودِ فایل.
 * PNGها همین‌جا ساخته می‌شوند (تصویر آزمایشی، نه لوگوی برند).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";
import { analyzePng, receiptLogoFromBuffer, ReceiptLogoError } from "../src/sales/receipt-logo.ts";
import { INVOICE_PAGE_CSP, invoicePage } from "../src/sales/invoice-page.ts";

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** PNG هشت‌بیتی؛ `pixel(x,y)` بایت‌های یک پیکسل را می‌دهد. سطرها با فیلتر Sub برای آزمودن بازسازی. */
function png(width: number, height: number, colorType: 2 | 6, pixel: (x: number, y: number) => number[]): Buffer {
  const ch = colorType === 6 ? 4 : 3;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const raw = Buffer.from(Array.from({ length: width }, (_, x) => pixel(x, y)).flat());
    const sub = Buffer.alloc(raw.length);
    for (let i = 0; i < raw.length; i++) sub[i] = (raw[i]! - (i >= ch ? raw[i - ch]! : 0)) & 0xff;
    rows.push(Buffer.concat([Buffer.from([1]), sub]));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = colorType;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

// سفید روی شفاف (مثل نسخهٔ light-on-dark): وسط سفید، دور شفاف.
const whiteOnTransparent = png(40, 12, 6, (x, y) => (x > 4 && x < 35 && y > 2 && y < 9 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
const opaque = png(40, 12, 2, (x) => (x > 10 && x < 30 ? [20, 20, 20] : [255, 255, 255]));

const sale = {
  number: "F-1405-000123", shopName: "فروشگاه لیبل مد", customerName: null,
  occurredAt: new Date("2026-10-02T15:40:00Z"), lines: [], netAmount: 1000000n, taxAmount: 0n,
  shippingAmount: 0n, payableAmount: 1000000n, paidAmount: 1000000n,
};

describe("لوگوی رسید", () => {
  test("لوگوی شفاف سیاه چاپ می‌شود؛ پس‌زمینهٔ مات فقط خاکستری (نه مستطیل سیاه)", () => {
    assert.deepEqual(analyzePng(whiteOnTransparent), { width: 40, height: 12, transparent: true });
    assert.equal(receiptLogoFromBuffer(whiteOnTransparent).treatment, "black");
    assert.equal(receiptLogoFromBuffer(opaque).treatment, "gray");
  });

  test("جاسازی data: زیر همان CSP؛ سربرگ کم‌ارتفاع و کامل؛ نام شعبه alt و زیرنویس", () => {
    const logo = receiptLogoFromBuffer(whiteOnTransparent);
    const html = invoicePage({ ...sale, logo }, "Asia/Tehran");
    assert.ok(html.includes(`<img class="logo logo--black" src="data:image/png;base64,${whiteOnTransparent.toString("base64")}" width="40" height="12" alt="فروشگاه لیبل مد">`));
    assert.match(INVOICE_PAGE_CSP, /img-src data:/);
    assert.doesNotMatch(html, /src="https?:/, "هیچ منبع شبکه‌ای برای چاپ");
    assert.match(html, /\.logo \{[^}]*max-height: 48px; object-fit: contain;/);
    assert.match(html, /\.logo \{ max-height: 12mm; max-width: 48mm; \}/); // سقف چاپ پس از اصلاح بصری ۴۲۳۸۸f1
    assert.match(html, /\.logo--black \{ filter: brightness\(0\); \}/);
    assert.match(html, /<div class="shop">فروشگاه لیبل مد<\/div>/);
    assert.doesNotMatch(html, /<div class="brand">/);
    assert.match(html, /<div class="sheet">[\s\S]*<table class="totals">/, "قلاب چاپ مستقیم");
  });

  test("بی فایل لوگو: نشان متنی نام شعبه، بی تصویر ساختگی", () => {
    const html = invoicePage({ ...sale, logo: null }, "Asia/Tehran");
    assert.match(html, /<div class="brand">فروشگاه لیبل مد<\/div>/);
    assert.doesNotMatch(html, /<img/);
  });

  test("فایل نامعتبر یا بزرگ پذیرفته نمی‌شود", () => {
    assert.throws(() => receiptLogoFromBuffer(Buffer.from("GIF89a")), ReceiptLogoError);
    assert.throws(() => receiptLogoFromBuffer(Buffer.concat([whiteOnTransparent, Buffer.alloc(210 * 1024)])), /200KB/);
  });
});
