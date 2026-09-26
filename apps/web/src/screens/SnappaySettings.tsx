import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api.ts";

export function SnappaySettings() {
  const [accounts, setAccounts] = useState<Array<{ id: string; name: string; bankName: string }>>([]);
  const [selected, setSelected] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const message = (e: unknown) => e instanceof ApiError ? e.message : "ارتباط با سرور برقرار نشد.";
  useEffect(() => {
    let alive = true;
    void api.get<{ accounts: typeof accounts; accountId: string; enabled: boolean }>("/snappay/config")
      .then(r => { if (alive) { setAccounts(r.accounts); setSelected(r.accountId); setEnabled(r.enabled); } })
      .catch(e => { if (alive) setError(message(e)); }).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, []);
  async function save() {
    setBusy(true); setError(""); setNote("");
    try { await api.put("/snappay/config", { accountId: selected }); setEnabled(!!selected); setNote("تنظیم اسنپ‌پی ذخیره شد."); }
    catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }
  return <section className="solid pad stack"><h1>اسنپ‌پی</h1>
    <p>فقط پرداختی را ثبت کنید که تأیید آن را از اسنپ‌پی گرفته‌اید. این گزینه درخواست پرداخت بانکی، دریافت وجه بانک یا محاسبهٔ خودکار کارمزد انجام نمی‌دهد.</p>
    <p>وضعیت: <strong>{busy ? "در حال بررسی…" : enabled ? "آمادهٔ ثبت دستی" : "غیرفعال"}</strong></p>
    <label className="auth-field">حساب واسط و بانک تسویه<select value={selected} disabled={busy} onChange={e => setSelected(e.target.value)}>
      <option value="">غیرفعال — حسابی انتخاب نشده</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.name} ← {a.bankName}</option>)}</select></label>
    <p className="muted">فهرست فقط حساب‌های فعالِ درگاه با بانک تسویه و نگاشت دفتر معتبر را نشان می‌دهد. شمارهٔ پیگیری در هر پرداخت اجباری است؛ می‌توان بقیهٔ فاکتور را نقد یا با کارت‌خوان پرداخت کرد.</p>
    <button className="btn btn--primary" type="button" disabled={busy} onClick={() => void save()}>ذخیرهٔ تنظیم اسنپ‌پی</button>
    {error && <p role="alert">{error}</p>}{note && <p role="status">{note}</p>}
  </section>;
}
