/**
 * مسیرهای عمومی — بدون نشست، بدون کوکی.
 *
 * امروز فقط یکی: صفحه فاکتور مشتری، همان لینکی که در پیامک می‌رود.
 *
 * ── چرا اصلاً یک مسیر بدون احراز هویت ───────────────────────────────
 *
 * مشتری حساب کاربری ندارد و نباید داشته باشد. ساختن حساب برای دیدن یک
 * فاکتور، یعنی هیچ‌کس فاکتورش را نمی‌بیند.
 *
 * ── و چه چیزی جای احراز هویت را می‌گیرد ─────────────────────────────
 *
 * توکن ۲۴ بایت تصادفی روی خودِ فاکتور (`sales.ensure_public_token`).
 * شمردنی نیست و حدس‌زدنی هم.
 *
 * سه چیز که این مسیر را از یک نشت جدا می‌کند:
 *
 * ۱. **فقط فاکتور نهایی‌شده.** پیش‌نویس هنوز سبد است، نه سند؛ و
 *    فاکتور باطل‌شده نباید مثل یک فاکتور معتبر دیده شود.
 * ۲. **پاسخ یکسان برای توکن غلط و فاکتور نامناسب.** اگر «یافت نشد» و
 *    «هست ولی پیش‌نویس است» دو پاسخ می‌گرفتند، همان تفاوت یک راه
 *    شمارش بود.
 * ۳. **`X-Robots-Tag: noindex`.** لینکی که در پیامک می‌رود ممکن است در
 *    یک پیام‌رسان باز شود و خزنده‌اش دنبالش کند. فاکتور مشتری نباید
 *    در گوگل پیدا شود.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "kysely";
import type { Db } from "../db/client.ts";
import { parseMoney } from "../lib/money.ts";
import {
  invoicePage,
  INVOICE_PAGE_CSP,
  type InvoicePageLine,
} from "../sales/invoice-page.ts";

/** مسیرهایی که این ماژول ثبت می‌کند و باید در فهرست عمومی باشند. */
export const PUBLIC_ROUTE_PATHS = ["/i/:token"] as const;

const tokenParam = z.object({
  // همان الفبای base64url که `ensure_public_token` می‌سازد. طول ثابت
  // نیست چون padding حذف می‌شود، ولی الگو هست: هر چیز دیگری اصلاً به
  // دیتابیس نمی‌رسد.
  token: z.string().regex(/^[A-Za-z0-9_-]{20,64}$/),
});

interface Row {
  number: string;
  occurred_at: Date;
  customer_name: string | null;
  net_amount: string;
  tax_amount: string;
  shipping_amount: string;
  payable_amount: string;
  paid_amount: string;
  shop_name: string | null;
  timezone: string;
}

export function registerPublicRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const { db } = deps;

  app.get("/i/:token", async (req, reply) => {
    const parsed = tokenParam.safeParse(req.params);
    if (!parsed.success) return notFound(reply);
    const { token } = parsed.data;

    const head = await sql<Row>`
      SELECT i.number, i.occurred_at,
             c.full_name AS customer_name,
             i.net_amount::text, i.tax_amount::text, i.shipping_amount::text,
             i.payable_amount::text, i.paid_amount::text,
             (SELECT b.name FROM platform.branch b WHERE b.id = i.branch_id) AS shop_name,
             platform.setting_text('platform.timezone', 'Asia/Tehran') AS timezone
        FROM sales.invoice i
        LEFT JOIN sales.customer c ON c.id = i.customer_id
       WHERE i.public_token = ${token}
         -- فقط سند واقعی. پیش‌نویس هنوز سبد است و باطل‌شده دیگر سند
         -- نیست؛ هیچ‌کدام نباید مثل فاکتور معتبر دیده شوند.
         AND i.status IN ('finalized','paid','partially_returned','returned')
    `.execute(db);

    const row = head.rows[0];
    if (!row) return notFound(reply);

    const lines = await sql<{
      product_name: string;
      color: string | null;
      size: string | null;
      qty: string;
      unit_price: string;
      discount_amount: string;
      net_amount: string;
    }>`
      SELECT p.name_internal AS product_name, v.color, v.size,
             l.qty::text, l.unit_price::text,
             l.discount_amount::text, l.net_amount::text
        FROM sales.invoice_line l
        JOIN sales.invoice    i ON i.id = l.invoice_id
        JOIN catalog.variation v ON v.id = l.variation_id
        JOIN catalog.product   p ON p.id = v.product_id
       WHERE i.public_token = ${token}
       ORDER BY l.line_no
    `.execute(db);

    const pageLines: InvoicePageLine[] = lines.rows.map((l) => ({
      productName: l.product_name,
      color: l.color,
      size: l.size,
      qty: l.qty,
      unitPrice: parseMoney(l.unit_price),
      discountAmount: parseMoney(l.discount_amount),
      netAmount: parseMoney(l.net_amount),
    }));

    const html = invoicePage(
      {
        number: row.number,
        occurredAt: row.occurred_at,
        shopName: row.shop_name ?? "فروشگاه",
        customerName: row.customer_name,
        lines: pageLines,
        netAmount: parseMoney(row.net_amount),
        taxAmount: parseMoney(row.tax_amount),
        shippingAmount: parseMoney(row.shipping_amount),
        payableAmount: parseMoney(row.payable_amount),
        paidAmount: parseMoney(row.paid_amount),
      },
      row.timezone,
    );

    return reply
      .code(200)
      .header("content-type", "text/html; charset=utf-8")
      .header("content-security-policy", INVOICE_PAGE_CSP)
      // فاکتور مشتری نباید در گوگل پیدا شود.
      .header("x-robots-tag", "noindex, nofollow")
      // و نباید در Cache واسط بماند: لینک عمومی است ولی محتوا شخصی.
      .header("cache-control", "private, no-store")
      .send(html);
  });
}

/**
 * یک پاسخ، برای هر دلیلِ ندیدن.
 *
 * توکن غلط، فاکتور پیش‌نویس و فاکتور باطل‌شده همه همین را می‌گیرند —
 * تفاوتشان یک راه شمارش بود.
 */
function notFound(reply: {
  code: (n: number) => {
    header: (k: string, v: string) => {
      header: (k: string, v: string) => { send: (b: string) => unknown };
    };
  };
}): unknown {
  return reply
    .code(404)
    .header("content-type", "text/html; charset=utf-8")
    .header("content-security-policy", INVOICE_PAGE_CSP)
    .send(
      `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8">
<title>یافت نشد</title>
<style>body{font-family:Vazirmatn,Tahoma,sans-serif;background:#EDEBF2;color:#14121C;
display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px}</style>
<div><h1>این فاکتور در دسترس نیست</h1>
<p>ممکن است لینک ناقص کپی شده باشد. لطفاً دوباره از پیامک بازش کنید.</p></div></html>`,
    );
}
