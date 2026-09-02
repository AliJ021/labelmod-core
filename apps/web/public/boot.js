/**
 * بوت تم — پیش از اولین رنگ.
 *
 * چرا یک فایل جدا و نه یک <script> درون‌خطی در index.html:
 * CSP تولیدی `script-src 'self' 'wasm-unsafe-eval'` است، بدون
 * `unsafe-inline` و بدون nonce. صفحه‌ای که Caddy از دیسک سرو می‌کند
 * nonce ندارد و نمی‌تواند داشته باشد؛ پس اسکریپت درون‌خطی یعنی یا
 * CSP سست شود یا صفحه بی‌صدا با تم غلط بالا بیاید.
 *
 * این فایل عمداً `type="module"` **نیست** و `defer` هم ندارد: باید
 * پیش از رندر بدنه اجرا شود، وگرنه صفحه یک لحظه با تم غلط بالا
 * می‌آید و بعد می‌پرد — چیزی که روی تبلت صندوق در تاریکی آزاردهنده
 * است.
 */
try {
  var t = localStorage.getItem("lm.theme");
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  var p = localStorage.getItem("lm.perf");
  if (p === "on" || p === "off") document.documentElement.setAttribute("data-perf", p);
} catch (_) {}
