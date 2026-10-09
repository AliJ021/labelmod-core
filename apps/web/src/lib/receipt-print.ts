/** Load the authenticated receipt with its original CSP; only an explicit button calls this. */
export function printReceipt(invoiceId: string, signal: AbortSignal): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(invoiceId)) return Promise.reject(new Error("شناسهٔ رسید معتبر نیست."));
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    const path = `/api/invoices/${invoiceId}/print`;
    frame.title = "رسید آمادهٔ چاپ";
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    // Keep a laid-out document: display:none can produce blank receipts in browsers.
    frame.style.cssText = "position:fixed;left:-10000px;top:0;width:800px;height:600px;border:0;pointer-events:none";
    let settled = false;
    let requested = false;
    let finishTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => finish(new Error("آماده‌سازی رسید طول کشید؛ اتصال را بررسی و دوباره تلاش کنید.")), 15000);
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(finishTimer);
      signal.removeEventListener("abort", abort);
      frame.remove();
      if (error) reject(error); else resolve();
    }
    function abort() { finish(new DOMException("چاپ لغو شد", "AbortError")); }
    frame.onerror = () => finish(new Error("رسید خوانده نشد؛ اتصال و ورود به حساب را بررسی کنید."));
    frame.onload = () => { void (async () => {
      if (settled || requested) return;
      const win = frame.contentWindow, doc = frame.contentDocument;
      if (!win || !doc || win.location.origin !== location.origin || win.location.pathname !== path
        || doc.contentType !== "text/html" || !doc.querySelector(".sheet .totals") || !doc.getElementById("print-btn")) {
        throw new Error("رسید معتبر خوانده نشد؛ اتصال و ورود به حساب را بررسی کنید.");
      }
      await doc.fonts.ready;
      // The embedded brand logo must be decoded before print, or the header can print empty.
      // A broken image falls back to its alt text (the shop name) instead of blocking the sale receipt.
      // `complete` also covers a failed image: its error event has already fired.
      // decode() rejects for that case, so the alt-text fallback can print immediately.
      await Promise.all(Array.from(doc.images, img => img.complete
        ? img.decode().catch(() => undefined)
        : new Promise<void>(done => {
          img.addEventListener("load", () => done(), { once: true });
          img.addEventListener("error", () => done(), { once: true });
        })));
      if (settled || signal.aborted) return;
      requested = true;
      clearTimeout(timeout);
      // afterprint means the browser finished the print flow, not that paper was printed.
      win.addEventListener("afterprint", () => { finishTimer = setTimeout(() => finish(), 500); }, { once: true });
      win.print();
      // Some kiosk browsers omit afterprint. Retain the frame briefly after print returns.
      if (!finishTimer) finishTimer = setTimeout(() => finish(), 1000);
    })().catch(() => finish(new Error("چاپ رسید آغاز نشد؛ اتصال و ورود به حساب را بررسی و دوباره تلاش کنید."))); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    frame.src = path;
    document.body.append(frame);
  });
}
