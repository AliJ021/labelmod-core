import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api.ts";
import { normalizeDigits } from "../lib/settings-value.ts";

export function SmsTwoFactor({ onEnrolled }: {onEnrolled?:()=>void}) {
  const [status,setStatus]=useState<{enabled:boolean;maskedMobile:string|null}|null>(null);
  const [mobile,setMobile]=useState(""),[password,setPassword]=useState(""),[code,setCode]=useState("");
  const [pending,setPending]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(""),[note,setNote]=useState("");
  useEffect(()=>{void api.get<{enabled:boolean;maskedMobile:string|null}>("/auth/2fa/sms/status").then(setStatus).catch((e:unknown)=>setError(e instanceof ApiError?e.message:"خواندن تنظیمات پیامک ممکن نشد."));},[]);
  async function act(kind:"enroll"|"confirm"|"disable") {
    if(busy)return;setBusy(true);setError("");setNote("");
    try {
      await api.post(`/auth/2fa/sms/${kind}`,kind==="confirm"?{code:normalizeDigits(code)}:kind==="enroll"?{mobile:normalizeDigits(mobile),currentPassword:password}:{currentPassword:password});
      setPassword("");setCode("");setPending(kind==="enroll");
      setNote(kind==="enroll"?"کد در صف ارسال است؛ پس از دریافت، حداکثر ظرف دو دقیقه وارد کنید.":kind==="confirm"?"ورود دومرحله‌ای پیامکی فعال شد.":"ورود پیامکی برداشته شد.");
      setStatus(await api.get("/auth/2fa/sms/status"));
      if(kind!=="enroll")onEnrolled?.();
    } catch(e){setError(e instanceof ApiError?e.message:"درخواست انجام نشد.");}finally{setBusy(false);}
  }
  return <section className="solid pad stack" aria-label="ورود دومرحله‌ای پیامکی">
    <h3>کد ورود با پیامک</h3>
    <p>پیامک یک روش اختیاری است. Passkey در برابر فیشینگ و تعویض سیم‌کارت امن‌تر است؛ می‌توانید روش‌های قبلی را نگه دارید.</p>
    <p>{status?.enabled?`فعال برای ${status.maskedMobile}`:"هنوز شماره‌ای تأیید نشده است."}</p>
    <p className="muted small">ابتدا ارسال پیامک و سرویس ملی‌پیامک را در تنظیمات آماده کنید. تغییر شماره فقط پس از تأیید شماره جدید اعمال می‌شود.</p>
    <label className="auth-field">رمز عبور فعلی برای تنظیم پیامک<input type="password" autoComplete="current-password" value={password} onChange={(e)=>setPassword(e.target.value)} /></label>
    <label className="auth-field">موبایل دریافت کد ورود<input type="tel" value={mobile} onChange={(e)=>setMobile(e.target.value)} placeholder="09xxxxxxxxx" /></label>
    <button type="button" className="btn" disabled={busy||!password||!mobile} onClick={()=>void act("enroll")}>ارسال کد تأیید شماره</button>
    {pending?<><label className="auth-field">کد تأیید پیامک<input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e)=>setCode(e.target.value)} /></label>
      <button type="button" className="btn btn--primary" disabled={busy||!/^\d{6}$/.test(normalizeDigits(code))} onClick={()=>void act("confirm")}>تأیید و فعال‌سازی پیامک</button></>:null}
    {status?.enabled?<button type="button" className="btn" disabled={busy||!password} onClick={()=>void act("disable")}>برداشتن ورود پیامکی</button>:null}
    {error?<p role="alert">{error}</p>:null}{note?<p role="status">{note}</p>:null}
  </section>;
}
