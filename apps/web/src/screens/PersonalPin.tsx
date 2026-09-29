import { useEffect, useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { ResultState } from "../components/ResultState.tsx";
import { PageHeader } from "../components/ui/PageHeader.tsx";
import { Button, Field } from "../components/ui/Controls.tsx";
import { StatusBadge } from "../components/ui/Status.tsx";
import { Skeleton } from "../components/ui/Skeleton.tsx";
import { api, ApiError } from "../lib/api.ts";
import { formatCount } from "../lib/format.ts";
import { normalizeDigits } from "../lib/settings-value.ts";

/**
 * PIN من — بخش شخصی؛ فقط نشست خودِ کاربر (`/auth/pin`).
 *
 * قاعده‌های امنیتی دست‌نخورده‌اند: هر تغییر یا برداشتن PIN رمز فعلی
 * می‌خواهد (همان گام امنیتی، نه تأیید تزئینی)، و سرور تنها مرجع است.
 */
export function PersonalPin() {
  const [status,setStatus] = useState<{ hasPin:boolean; length:number } | null>(null);
  const [loadError,setLoadError] = useState<string|null>(null);
  const [pin,setPin] = useState(""), [repeat,setRepeat] = useState(""), [password,setPassword] = useState("");
  const [busy,setBusy] = useState<"save"|"remove"|null>(null), [error,setError] = useState(""), [note,setNote] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void api.get<{hasPin:boolean;length:number}>("/auth/pin", { signal: controller.signal }).then(setStatus)
      .catch((e:unknown) => { if (!controller.signal.aborted) setLoadError(e instanceof ApiError ? e.message : "دریافت وضعیت PIN ممکن نشد."); });
    return () => controller.abort();
  },[]);
  async function save(remove=false) {
    if(busy || !status) return; setBusy(remove ? "remove" : "save"); setError(""); setNote("");
    try { await api.post("/auth/pin",{pin:remove ? null : normalizeDigits(pin),currentPassword:password});
      setStatus({...status,hasPin:!remove}); setPin("");setRepeat("");setPassword("");setNote(remove ? "PIN برداشته شد." : "PIN ذخیره شد.");
    } catch(e) { setError(e instanceof ApiError ? e.message : "ذخیره انجام نشد."); } finally { setBusy(null); }
  }
  const digits = normalizeDigits(pin), again = normalizeDigits(repeat);
  const shapeOk = !!status && new RegExp(`^\\d{${status.length}}$`).test(digits);
  const valid = shapeOk && digits === again;
  const pinError = status && pin !== "" && !shapeOk ? `PIN باید دقیقاً ${formatCount(status.length)} رقم باشد.` : null;
  const repeatError = repeat !== "" && shapeOk && digits !== again ? "تکرار با PIN جدید یکی نیست." : null;
  return <div className="settings-page">
    <PageHeader title="ساخت و تغییر PIN من"
      context="PIN فقط قفل نشست همین روز را روی دستگاه تأییدشده باز می‌کند؛ جای رمز ورود یا ورود دومرحله‌ای نیست."
      {...(status ? { meta: <StatusBadge state={status.hasPin ? "completed" : "draft"} label={status.hasPin ? "PIN فعال است" : "هنوز PIN ندارید"} /> } : {})} />
    <Solid as="section" className="settings-section" aria-label="PIN من">
      <p className="settings-note">برای تأیید دستگاه: تنظیمات ← دستگاه‌ها. برای قفل کردن: دکمهٔ قفل در نوار بالای برنامه.</p>
      {loadError ? <ResultState kind="error" title={loadError} /> : !status ? <Skeleton variant="row" lines={3} label="در حال دریافت وضعیت PIN…" /> : <>
        <p className="settings-facts">طول PIN: {formatCount(status.length)} رقم</p>
        <div className="settings-form">
          <Field label="رمز عبور فعلی" hint="برای ساخت، تغییر یا برداشتن PIN لازم است.">
            <input type="password" autoComplete="current-password" value={password} onChange={(e)=>setPassword(e.target.value)} />
          </Field>
          <Field label="PIN جدید" error={pinError}>
            <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={8} value={pin} onChange={(e)=>setPin(e.target.value)} />
          </Field>
          <Field label="تکرار PIN جدید" error={repeatError}>
            <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={8} value={repeat} onChange={(e)=>setRepeat(e.target.value)} />
          </Field>
          <div className="settings-actions">
            <Button variant="primary" busy={busy==="save"} busyLabel="در حال ذخیره…" disabled={busy!==null||!valid||!password} onClick={()=>void save()}>{status.hasPin ? "تغییر PIN" : "ساخت PIN"}</Button>
            {status.hasPin ? <Button variant="danger" busy={busy==="remove"} busyLabel="در حال برداشتن…" disabled={busy!==null||!password} onClick={()=>void save(true)}>برداشتن PIN من</Button> : null}
          </div>
          {error ? <p className="field-error" role="alert">{error}</p> : null}{note ? <p className="set-msg" role="status">{note}</p> : null}
        </div>
      </>}
    </Solid>
  </div>;
}
