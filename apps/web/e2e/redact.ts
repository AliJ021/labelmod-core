/**
 * حذف ساختاری Query و Fragment از شواهد شکست (LM-106-L03).
 *
 * شواهد آزمون مرورگر در لاگ CI چاپ می‌شوند. هر مقداری که در Query یا Fragment یک نشانی
 * باشد — token، code، key، رمز — ممکن است راز باشد، پس اصلاً ثبت نمی‌شود؛ فقط یک نشانه
 * می‌ماند که «چیزی حذف شد». نشانی نامعتبر هرگز خام برنمی‌گردد.
 *
 * همین قواعد در `.github/scripts/e2e-failure-report.py` هم پیاده شده‌اند؛ تغییر یکی بی
 * دیگری، آزمون `test/e2e-redact.test.ts` را قرمز می‌کند.
 */
export const REDACTED = "[redacted]";
export const UNPARSEABLE = "[unparseable-url]";

const WEB_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);
// پس از `?` یا `#` یا یک طرح مات، تا فاصلهٔ بعدی همه‌چیز حذف می‌شود — حتی نقل‌قول یا پرانتز:
// مقداری مثل token='…' نباید با بسته‌شدن نقل‌قول نیمه‌کاره بماند و بیرون بریزد.
const ABSOLUTE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>`?#]+(?:[?#]\S*)?/g;
const OPAQUE = /\b(?:data|blob|javascript|about):\S+/gi;
const FRAGMENT = /(\/[^\s"'<>`?#]*)#\S+/g;
const QUERY = /\?(?![.?\s])\S+/g;

/** برای درخواست و ناوبری: فقط مسیر. Query، Fragment و اطلاعات کاربر هرگز. */
export function safeRequestPath(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { return UNPARSEABLE; }
  return WEB_SCHEMES.has(url.protocol) ? url.pathname || "/" : `${url.protocol}[omitted]`;
}

/** برای متن آزاد (کنسول، خطای صفحه، پیام آزمون): هر Query و Fragment حذف می‌شود. */
export function redactText(text: string): string {
  return text
    .replace(ABSOLUTE, match => {
      let url: URL;
      try { url = new URL(match); } catch { return UNPARSEABLE; }
      if (!WEB_SCHEMES.has(url.protocol)) return `${url.protocol}[omitted]`;
      const dropped = url.search !== "" || url.hash !== "" || match.includes("?") || match.includes("#");
      return `${url.protocol}//${url.host}${url.pathname}${dropped ? `?${REDACTED}` : ""}`;
    })
    .replace(OPAQUE, match => `${match.slice(0, match.indexOf(":") + 1)}[omitted]`)
    .replace(FRAGMENT, `$1#${REDACTED}`)
    .replace(QUERY, `?${REDACTED}`);
}
