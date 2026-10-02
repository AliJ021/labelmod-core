import { useEffect, useRef, useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { Ltr } from "../components/ui/Bidi.tsx";
import { Button, Field } from "../components/ui/Controls.tsx";
import { ApiError } from "../lib/api.ts";
import { normalizeDigits } from "../lib/settings-value.ts";
import { woo, pluginPackage, type PluginPackage, type WooConfig, type WooResult } from "../lib/woocommerce.ts";

export function WooCommerceSettings() {
  const [config, setConfig] = useState<WooConfig | null>(null);
  const [pkg, setPkg] = useState<PluginPackage | null>(null);
  const [packageError, setPackageError] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<WooResult | null>(null);
  const [order, setOrder] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    void woo.config(controller.signal).then(setConfig).catch(() => {
      if (!controller.signal.aborted) setError("خواندن تنظیمات ممکن نشد؛ دسترسی یا ارتباط را بررسی کنید.");
    });
    void pluginPackage(controller.signal).then(setPkg).catch(() => {
      if (!controller.signal.aborted) setPackageError("بستهٔ قابل دانلود در این ساخت تأیید نشد.");
    });
    return () => { controller.abort(); active.current?.abort(); };
  }, []);
  async function test() {
    if (busy) return;
    const raw = normalizeDigits(order).trim();
    const id = raw === "" ? undefined : Number(raw);
    if (raw !== "" && (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id! <= 0)) {
      setError("شمارهٔ داخلی سفارش باید عدد صحیح مثبت باشد."); return;
    }
    const controller = new AbortController();
    active.current = controller;
    setBusy(true); setError(""); setResult(null);
    try { setResult(await woo.test(id, controller.signal)); }
    catch (e) { if (!controller.signal.aborted) setError(e instanceof ApiError ? e.message : "اتصال کامل نشد؛ دوباره تست کنید."); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  const remote = result?.remote;
  const yes = (value: boolean) => value ? "بله" : "خیر";
  return <Solid as="section" className="pad">
    <h2>اتصال ووکامرس</h2>
    <p className="muted">سفارش پرداخت‌شده از سایت به لیبل مد می‌آید؛ موجودی مطلق و قیمت از لیبل مد به سایت می‌روند.</p>
    {error && <p role="alert" className="pos-alert">{error}</p>}
    {!config && !error && <p role="status">در حال خواندن تنظیمات…</p>}
    {config && <>
      <p>نشانی سایت: <Ltr>{config.siteUrl || "—"}</Ltr></p>
      <p>ارسال لحظه‌ای فعال: {yes(config.pushEnabled)}؛ کلید امضای API تنظیم شده: {yes(config.signingConfigured)}</p>
      <p>انبار سایت: <Ltr>{config.warehouseId || "—"}</Ltr></p>
    </>}
    <Field label="شمارهٔ داخلی سفارش ووکامرس (اختیاری)">
      <input inputMode="numeric" value={order} onChange={e => setOrder(e.target.value)} disabled={busy} />
    </Field>
    <p><Button onClick={() => void test()} busy={busy} busyLabel="در حال بررسی…">تست اتصال</Button></p>
    <p className="muted">این بررسی فاکتور، موجودی، پرداخت یا صف سفارش را تغییر نمی‌دهد. فقط Nonce امنیتی اتصال ثبت می‌شود.</p>
    {result && <div role="status">
      <p>{result.message}</p>
      {remote && <>
        <p>نسخهٔ نصب‌شده: <Ltr>{remote.pluginVersion}</Ltr>؛ ووکامرس: <Ltr>{remote.wooVersion}</Ltr></p>
        <p>کلید API در افزونه موجود: {yes(remote.apiKeyConfigured)}؛ اعتبار آن از تست داخل وردپرس بررسی می‌شود.</p>
        <p>دریافت دوره‌ای موجودی فعال: {yes(remote.stockPolling)}؛ رویداد زمان‌بند ثبت‌شده: {yes(remote.stockScheduled)}</p>
        {remote.cronDisabled && <p>WP-Cron خاموش است؛ اجرای cron سیستم نیاز به بررسی جداگانه دارد.</p>}
        <p>محصولات دارای شناسهٔ اتصال: {remote.mapping.linkedProducts?.toLocaleString("fa-IR") ?? "خواندن شمارش ممکن نشد"}؛ ارسال سفارش همچنان به SKU معتبر نیاز دارد.</p>
        {remote.order && <>
          <p>سفارش پیدا شد: {yes(remote.order.found)}؛ پرداخت تأییدشده: {yes(remote.order.paymentConfirmed)}؛ آمادهٔ ارسال: {yes(remote.order.eligible)}</p>
          <p>شناسهٔ فاکتور ثبت‌شده: {yes(remote.order.recorded)}؛ در صف زمان‌بند: {yes(remote.order.scheduled)}؛ تعداد تلاش: {remote.order.attempts.toLocaleString("fa-IR")}</p>
          <p>اقلام بدون SKU: {remote.order.missingSku.toLocaleString("fa-IR")}؛ خطای ارسال ثبت‌شده: {yes(remote.order.hasError)}</p>
          <p className="muted">برای جزئیات خطا و تأیید واقعی پرداخت، همان سفارش را در پیشخوان ووکامرس بررسی کنید.</p>
        </>}
      </>}
    </div>}
    <h3>بستهٔ افزونه و راه‌اندازی</h3>
    {packageError && <p role="alert">{packageError}</p>}
    {pkg && <>
      <p>نسخهٔ بسته: <Ltr>{pkg.version}</Ltr></p>
      <p>اثر انگشت SHA-256:</p><p className="break-anywhere"><Ltr>{pkg.sha256}</Ltr></p>
      <a className="btn" href={`/downloads/${pkg.filename}`} download>دانلود افزونه</a>
    </>}
    <ol>
      <li>بسته را در وردپرس ← افزونه‌ها ← افزودن ← بارگذاری نصب یا به‌روزرسانی کنید.</li>
      <li>در ووکامرس ← اتصال لیبل مد، نشانی HTTPS نهایی سامانه و کلید API مجاز همان شعبه را ذخیره کنید.</li>
      <li>شعبه، انبار، واحد ریال/تومان و نگاشت درگاه پرداخت را مطابق تنظیم واقعی انتخاب کنید.</li>
      <li>برای ارسال لحظه‌ای، مدیر سرور کلید امضا را در API، Worker و ثابت LMC_PUSH_SECRET وردپرس یکسان تنظیم کند؛ کلید را در تنظیمات عمومی ننویسید.</li>
      <li>در هر دو سمت «تست اتصال» را بزنید. داخل وردپرس شناسهٔ محصول را هم وارد کنید تا SKU و شناسهٔ اتصال با Core تطبیق داده شوند.</li>
      <li>پس از تأیید دسترسی TEST، یک سفارش کنترل‌شده و تکرار همان درخواست باید فقط یک فاکتور و یک خروج موجودی بسازند؛ این پذیرش زنده هنوز انجام نشده است.</li>
    </ol>
  </Solid>;
}
