import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api.ts";
import { normalizeDigits } from "../lib/settings-value.ts";

export function PersonalPin() {
  const [status,setStatus] = useState<{ hasPin:boolean; length:number } | null>(null);
  const [pin,setPin] = useState(""), [repeat,setRepeat] = useState(""), [password,setPassword] = useState("");
  const [busy,setBusy] = useState(false), [error,setError] = useState(""), [note,setNote] = useState("");
  useEffect(() => { void api.get<{hasPin:boolean;length:number}>("/auth/pin").then(setStatus).catch((e:unknown) => setError(e instanceof ApiError ? e.message : "دریافت وضعیت PIN ممکن نشد.")); },[]);
  async function save(remove=false) {
    if(busy || !status) return; setBusy(true); setError(""); setNote("");
    try { await api.post("/auth/pin",{pin:remove ? null : normalizeDigits(pin),currentPassword:password});
      setStatus({...status,hasPin:!remove}); setPin("");setRepeat("");setPassword("");setNote(remove ? "PIN برداشته شد." : "PIN ذخیره شد.");
    } catch(e) { setError(e instanceof ApiError ? e.message : "ذخیره انجام نشد."); } finally { setBusy(false); }
  }
  const valid=!!status && new RegExp(`^\\d{${status.length}}$`).test(normalizeDigits(pin)) && normalizeDigits(pin)===normalizeDigits(repeat);
  return <section className="solid pad stack" aria-label="PIN من">
    <h2>ساخت و تغییر PIN من</h2>
    <p>PIN فقط قفل نشست همین روز را روی دستگاه تأییدشده باز می‌کند؛ جای رمز ورود یا ورود دومرحله‌ای نیست.</p>
    <p>برای تأیید دستگاه: تنظیمات ← دستگاه‌ها. برای قفل کردن: دکمهٔ قفل در نوار بالای برنامه.</p>
    {status ? <p>وضعیت: {status.hasPin ? "PIN فعال است" : "هنوز PIN ندارید"} · طول: {status.length} رقم</p> : null}
    <label className="auth-field">رمز عبور فعلی<input type="password" autoComplete="current-password" value={password} onChange={(e)=>setPassword(e.target.value)} /></label>
    <label className="auth-field">PIN جدید<input type="password" inputMode="numeric" autoComplete="new-password" maxLength={8} value={pin} onChange={(e)=>setPin(e.target.value)} /></label>
    <label className="auth-field">تکرار PIN جدید<input type="password" inputMode="numeric" autoComplete="new-password" maxLength={8} value={repeat} onChange={(e)=>setRepeat(e.target.value)} /></label>
    <button type="button" className="btn btn--primary" disabled={busy||!valid||!password} onClick={()=>void save()}>{status?.hasPin ? "تغییر PIN" : "ساخت PIN"}</button>
    {status?.hasPin ? <button type="button" className="btn" disabled={busy||!password} onClick={()=>void save(true)}>برداشتن PIN من</button> : null}
    {error ? <p role="alert">{error}</p> : null}{note ? <p role="status">{note}</p> : null}
  </section>;
}
