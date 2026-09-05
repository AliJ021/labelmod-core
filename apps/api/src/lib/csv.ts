/**
 * ساخت CSV — برای اکسل، و بدون اینکه اکسل کد اجرا کند.
 *
 * ── سه چیز که CSV فارسی را خراب می‌کند ─────────────────────────────
 *
 * **۱. بدون BOM، اکسل فارسی را نامفهوم نشان می‌دهد.** اکسل ویندوز
 * فایل CSV را با کدگذاری محلی می‌خواند مگر اینکه BOM ببیند. بدون آن،
 * «پیراهن» می‌شود «Ù¾ÛŒØ±Ø§Ù‡Ù†» و کاربر فکر می‌کند گزارش خراب است.
 * ماژول Import همین مخزن BOM را در **ورودی** حذف می‌کند؛ اینجا باید
 * در **خروجی** نوشته شود.
 *
 * **۲. سلولی که با `=` شروع شود، فرمول است.** نام کالا و نام مشتری
 * ورودی کاربرند. کسی که کالایی به نام
 * `=HYPERLINK("http://…","برای دیدن کلیک کنید")` بسازد، هر کسی را که
 * گزارش را در اکسل باز کند هدف گرفته — و این خارج از مرورگر اتفاق
 * می‌افتد، جایی که هیچ CSP‌ای نیست.
 *
 * اکسل `=`، `+`، `-`، `@` و نویسه‌های Tab/CR را آغاز فرمول می‌داند.
 * راه‌حل استاندارد: یک آپاستروف پیش از سلول. متن همان‌طور دیده
 * می‌شود، ولی فرمول نیست.
 *
 * ⚠️ نقل‌قول کردن **کافی نیست**: اکسل `"=cmd"` را هم فرمول می‌بیند.
 *
 * **۳. پول نباید از `number` رد شود.** مبالغ ریالی از دقت `number`
 * جاوااسکریپت بیرون می‌زنند. اینجا هر مقدار به‌شکل **رشته** می‌آید و
 * دست‌نخورده نوشته می‌شود.
 */

/** نویسه‌هایی که اکسل آغاز فرمول می‌داند. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * یک سلول.
 *
 * `null` و `undefined` سلول **خالی** می‌شوند، نه رشته «null» — که در
 * یک ستون مبلغ، عددی به نظر می‌رسد که نیست.
 */
export function cell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);

  // خنثی‌سازی فرمول **پیش از** نقل‌قول، وگرنه آپاستروف داخل نقل‌قول
  // می‌افتاد و اکسل باز هم فرمول می‌دید.
  if (FORMULA_START.test(s)) s = `'${s}`;

  // نقل‌قول فقط وقتی لازم است — ولی وقتی لازم شد، `"` دوتا می‌شود.
  if (/[",\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

/**
 * یک فایل CSV کامل.
 *
 * خط‌ها با CRLF جدا می‌شوند (RFC 4180 و انتظار اکسل) و فایل با BOM
 * شروع می‌شود.
 */
export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly (string | number | boolean | null | undefined)[])[],
): string {
  const lines = [headers.map(cell).join(",")];
  for (const r of rows) lines.push(r.map(cell).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/**
 * CSV از آرایه‌ای از شیءها، با ستون‌های نام‌دار.
 *
 * `columns` هم **ترتیب** ستون‌ها را تعیین می‌کند و هم برچسب فارسی‌شان
 * را. تکیه به ترتیب کلیدهای شیء یعنی گزارش با یک بازآرایی بی‌ربط در
 * کد، ستون‌هایش جابه‌جا شود.
 */
export function rowsToCsv<T extends Record<string, unknown>>(
  columns: readonly (readonly [key: keyof T & string, label: string])[],
  rows: readonly T[],
): string {
  return toCsv(
    columns.map(([, label]) => label),
    rows.map((r) =>
      columns.map(([key]) => {
        const v = r[key];
        if (v === null || v === undefined) return null;
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          return v;
        }
        // تاریخ و هر چیز دیگری: نمایش متنی، نه `[object Object]`.
        return v instanceof Date ? v.toISOString() : String(v);
      }),
    ),
  );
}

/**
 * نام فایل ASCII، امن برای هدر `Content-Disposition`.
 *
 * ⚠️ نام فایل نباید مستقیم از ورودی کاربر بیاید: `"` یا خط تازه در
 *    آن یعنی تزریق هدر. اینجا فقط حروف امن می‌مانند.
 *
 * نامی که هیچ حرف یا رقمی نداشته باشد — مثلاً یک نام کاملاً فارسی که
 * همه‌اش به خط تیره تبدیل می‌شود — به `report` برمی‌گردد. فایلی به نام
 * `-----.csv` از فایلی به نام `report.csv` بدتر است.
 *
 * نامِ **فارسی** از راه `filename*` می‌رود (RFC 5987)، نه از اینجا؛
 * این فقط نسخه پشتیبان برای کلاینت‌های قدیمی است.
 */
export function safeFilename(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
  return /[A-Za-z0-9]/.test(clean) ? clean : "report";
}

/**
 * مقدار کامل هدر `Content-Disposition` برای یک دانلود.
 *
 * دو نام می‌دهد: `filename` اَسکی برای کلاینت قدیمی، و `filename*`
 * درصد-کدشده به UTF-8 (RFC 5987) که مرورگرهای امروزی ترجیح می‌دهند —
 * پس کاربر نام فارسی می‌بیند، نه یک مشت خط تیره.
 *
 * `encodeURIComponent` هر نویسه خطرناک هدر را هم می‌پوشاند، پس
 * تزریق هدر از این مسیر ممکن نیست.
 */
export function contentDisposition(persianName: string, asciiName: string): string {
  const ascii = safeFilename(asciiName);
  const utf8 = encodeURIComponent(persianName);
  return `attachment; filename="${ascii}.csv"; filename*=UTF-8''${utf8}.csv`;
}
