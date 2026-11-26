import { useEffect, useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { api, ApiError } from "../lib/api.ts";

interface Credential {
  accountName: string;
  hasKey: boolean;
  revision: number;
  storageReady: boolean;
  canEdit: boolean;
  transport?: "console" | "panel";
  otpPattern?: number | null;
  invoicePattern?: number | null;
  digestEnabled?: boolean; digestPattern?: number | null; digestCopy?: string;
  otpCopy?: string;
  invoiceCopy?: string;
  routing?: { enabled: boolean; provider: string; sender: string; invoiceEnabled: boolean; receiptConsentRequired: boolean; hasPublicUrl: boolean; chequeEnabled: boolean };
  examples?: { otp: string; invoice: string };
}

function providerCopy(template: string) {
  let index=0;
  return template.replace(/\{(حضوری|سایت|اینستاگرام|جمع)\}/g,()=>`{${index++}}`);
}

export function MeliPayamakSettings() {
  const [value, setValue] = useState<Credential | null>(null);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [transport, setTransport] = useState<"console" | "panel">("console");
  const [otp, setOtp] = useState("");
  const [invoice, setInvoice] = useState("");
  const [otpCopy, setOtpCopy] = useState("");
  const [invoiceCopy, setInvoiceCopy] = useState("");
  const [digestEnabled, setDigestEnabled] = useState(false);
  const [digestPattern, setDigestPattern] = useState("");
  const [digestCopy, setDigestCopy] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    api.get<Credential>("/settings/melipayamak-credential").then((r) => {
      if (alive) { setValue(r); setName(r.accountName); setTransport(r.transport ?? "console");
        setOtp(r.otpPattern?.toString() ?? ""); setInvoice(r.invoicePattern?.toString() ?? "");
        setDigestEnabled(r.digestEnabled ?? false); setDigestPattern(r.digestPattern?.toString() ?? ""); setDigestCopy(r.digestCopy ?? "");
        setOtpCopy(r.otpCopy ?? ""); setInvoiceCopy(r.invoiceCopy ?? ""); }
    }).catch((e: unknown) => { if (alive) setError(e instanceof ApiError ? e.message : "دریافت تنظیم اتصال ممکن نشد"); });
    return () => { alive = false; };
  }, []);

  async function save() {
    if (!value) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const r = await api.put<Credential>("/settings/melipayamak-credential", {
        revision: value.revision, accountName: name, transport,
        digestEnabled,digestPattern:digestPattern ? Number(digestPattern) : null,digestCopy,
        otpPattern: otp ? Number(otp) : null, invoicePattern: invoice ? Number(invoice) : null, otpCopy, invoiceCopy,
        ...(key.trim() ? { apiKey: key.trim() } : {}), clearKey,
      });
      setValue(r); setName(r.accountName); setKey(""); setClearKey(false);
      setMessage("تنظیم اتصال ذخیره شد. این کار پیامکی ارسال نمی‌کند و ارسال را فعال نمی‌کند.");
    } catch (e) { setError(e instanceof ApiError ? e.message : "ذخیره انجام نشد"); }
    finally { setBusy(false); }
  }

  async function checkCredit() {
    setBusy(true); setMessage(""); setError("");
    try {
      const result = await api.post<{ credit: number }>("/settings/melipayamak-credit", {});
      setMessage(`اتصال با مشخصات ذخیره‌شده تأیید شد. اعتبار اعلام‌شدهٔ سرویس: ${result.credit.toLocaleString("fa-IR")}`);
    } catch (err) { setError(err instanceof ApiError ? err.message : "بررسی اتصال ممکن نشد."); }
    finally { setBusy(false); }
  }

  const disabled = busy || !value?.canEdit;
  return <Solid className="pad stack" style={{ gap: "var(--s-3)" }}>
    <h2 style={{ fontSize: "1.1rem", margin: 0 }}>اتصال ملی‌پیامک</h2>
    <p className="muted small" style={{ margin: 0 }}>
      نوع اتصال را مطابق محل دریافت کلید انتخاب کنید. برای کلید وب‌سرویس پنل، نام کاربری همان پنل را هم وارد کنید.
      سرویس‌دهنده و شمارهٔ فرستنده را از تنظیمات همین گروه انتخاب کنید.
    </p>
    {error ? <p role="alert">{error}</p> : null}
    {value ? <form className="stack" style={{ gap: "var(--s-3)" }} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <p className="small" style={{ margin: 0 }}>{value.hasKey ? "کلید ذخیره شده است؛ مقدار آن نمایش داده نمی‌شود." : "هنوز کلیدی ذخیره نشده است."}</p>
      {!value.storageReady ? <p role="status">ذخیرهٔ امن کلید روی سرور آماده نیست؛ برای آماده‌سازی با مدیر سرور تماس بگیرید.</p> : null}
      <label className="stack">نوع کلید ملی‌پیامک
        <select value={transport} disabled={disabled} onChange={e => setTransport(e.target.value as typeof transport)}>
          <option value="console">کلید کنسول ملی‌پیامک</option><option value="panel">کلید وب‌سرویس پنل + نام کاربری</option>
        </select></label>
      <label className="stack">{transport === "panel" ? "نام کاربری وب‌سرویس (الزامی)" : "نام حساب / نام کاربری پنل (اختیاری)"}
        <input className="set-input" value={name} maxLength={100} autoComplete="off" disabled={disabled}
          onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="stack">کلید API جدید ملی‌پیامک
        <input className="set-input" type="password" value={key} maxLength={2048} autoComplete="new-password"
          disabled={disabled || !value.storageReady || clearKey} onChange={(e) => setKey(e.target.value)} />
      </label>
      <p className="muted small" style={{ margin: 0 }}>برای نگه‌داشتن کلید فعلی، این کادر را خالی بگذارید. ذخیرهٔ کلید به معنی تأیید اتصال یا تحویل پیامک نیست.</p>
      {value.hasKey ? <label><input type="checkbox" checked={clearKey} disabled={disabled}
        onChange={(e) => { setClearKey(e.target.checked); if (e.target.checked) setKey(""); }} /> حذف کلید ذخیره‌شده (ارسال ملی‌پیامک متوقف می‌شود)</label> : null}
      <fieldset disabled={disabled} className="stack"><legend>الگوی خدماتی</legend>
        {([{ label: "ورود دومرحله‌ای", id: otp, setId: setOtp, copy: otpCopy, setCopy: setOtpCopy,
             args: ["123456"], hint: "۰: کد شش‌رقمی", example: value.examples?.otp },
          { label: "رسید خرید", id: invoice, setId: setInvoice, copy: invoiceCopy, setCopy: setInvoiceCopy,
             args: ["۱۴۰۵", "۵۰٬۰۰۰"], hint: "متغیر {0} شمارهٔ فاکتور و {1} مبلغ به تومان است. نشانی ثابت خریدهای مشتری را در خود الگوی ملی‌پیامک بنویسید.", example: value.examples?.invoice }]).map(item =>
          <section key={item.label} className="solid pad stack"><h3>{item.label}</h3>
            <label>شناسهٔ پترن {item.label}<input inputMode="numeric" pattern="[0-9]+" value={item.id} onChange={e => item.setId(e.target.value.replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))))} /></label>
            <small>{item.hint}</small>
            <p className="small">{item.label === "رسید خرید" ? "نمونه برای ثبت در ملی‌پیامک: فاکتور {0} لیبل مد ثبت شد. مبلغ فاکتور {1} تومان. سپس نشانی ثابت صفحهٔ خریدهای فروشگاه را بنویسید." : "نمونه برای ثبت در ملی‌پیامک: کد ورود لیبل مد {0} است. این کد را در اختیار دیگران نگذارید."}</p>
            {item.id ? <>
              <label>رونوشت متن تأییدشده در ملی‌پیامک<textarea maxLength={750} value={item.copy} onChange={e => item.setCopy(e.target.value)} /></label>
              <small>متن نهایی را ملی‌پیامک از پترن می‌خواند. برای پیش‌نمایش، متن همان الگو را با جای‌نگهدارهای {"{0}"} و بعدی وارد کنید.</small>
            </> : <small>بدون پترن، متن آزاد از خط فرستنده ارسال می‌شود.</small>}
            <div><strong>پیش‌نمایش با دادهٔ نمونه</strong><p style={{ whiteSpace: "pre-line", overflowWrap: "anywhere" }}>{item.id
              ? item.copy.replace(/\{(\d+)\}/g, (token, n: string) => item.args[Number(n)] ?? token) || "رونوشت متن پترن وارد نشده است." : item.example}</p></div>
          </section>)}
      </fieldset>
      <fieldset className="stack" disabled={disabled}><legend>گزارش شبانهٔ مدیر</legend>
        <label><input type="checkbox" checked={digestEnabled} onChange={e=>setDigestEnabled(e.target.checked)} /> ارسال فروش خالص روز گذشته پس از نیمه‌شب به موبایل مدیر</label>
        <label>شناسهٔ پترن گزارش مدیر<input value={digestPattern} inputMode="numeric" pattern="[0-9]+" onChange={e=>setDigestPattern(e.target.value.replace(/[۰-۹]/g,d=>String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))))}/></label>
        <label>متن و ترتیب عددها<textarea maxLength={750} value={digestCopy} onChange={e=>setDigestCopy(e.target.value)}/></label>
        <small>{"عددهای قابل انتخاب: {حضوری}، {سایت}، {اینستاگرام}، {جمع}. مبلغ‌ها به تومان و پس از کسر مرجوعی همان روز هستند."}</small>
        <div><strong>متن برای ثبت در ملی‌پیامک</strong><pre style={{whiteSpace:"pre-wrap"}}>{providerCopy(digestCopy)}</pre></div>
        <div><strong>نمونهٔ پیام مدیر</strong><p style={{whiteSpace:"pre-line"}}>{digestCopy.replace(/\{(حضوری|سایت|اینستاگرام|جمع)\}/g,(_m,k:string)=>({"حضوری":"۸۰۰٬۰۰۰","سایت":"۴۰۰٬۰۰۰","اینستاگرام":"۳۰۰٬۰۰۰","جمع":"۱٬۵۰۰٬۰۰۰"}[k] ?? ""))}</p></div>
        <small>پس از تأیید متن تازه در ملی‌پیامک، شناسهٔ همان پترن را ذخیره کنید. بدون پترن، ارسال به خط متن‌آزاد نیاز دارد.</small>
      </fieldset>
      {value.routing && <section className="solid pad stack"><h3>وضعیت مسیر ارسال</h3>
        <span>ارسال واقعی ملی‌پیامک · {value.routing.enabled && value.routing.provider === "melipayamak" ? "انتخاب و فعال شده" : "غیرفعال؛ سرویس و کلید ارسال را در گروه اعلان‌ها بررسی کنید"}</span>
        <span>رسید خرید · {value.routing.invoiceEnabled ? "فعال" : "خاموش"} · {value.routing.receiptConsentRequired ? "با رضایت رسید مشتری" : "بدون شرط رضایت رسید"} · {value.routing.hasPublicUrl ? "نشانی رسید تنظیم شده" : "نشانی عمومی فاکتور لازم است"}</span>
        <span>هشدار سررسید چک به مدیر · {value.routing.chequeEnabled ? "فعال" : "خاموش"}</span>
      </section>}
      <button className="btn" type="button" disabled={disabled || !value.hasKey} onClick={() => void checkCredit()}>تست اتصال ذخیره‌شده و استعلام اعتبار</button>
      <button className="btn btn-primary" type="submit" disabled={disabled || (transport === "panel" && !name.trim())}>{busy ? "در حال ذخیره…" : "ذخیرهٔ اتصال ملی‌پیامک"}</button>
      {message ? <p role="status">{message}</p> : null}
    </form> : !error ? <p className="muted">در حال دریافت تنظیم اتصال…</p> : null}
  </Solid>;
}
