import { useEffect, useRef, useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { Ltr } from "../components/ui/Bidi.tsx";
import { Button, Field } from "../components/ui/Controls.tsx";
import { SectionHeader } from "../components/ui/PageHeader.tsx";
import { StatusBadge } from "../components/ui/Status.tsx";
import { api, ApiError } from "../lib/api.ts";
import { normalizeDigits } from "../lib/settings-value.ts";

type SmsStatus = { enabled: boolean; maskedMobile: string | null };

/**
 * ورود دومرحله‌ای پیامکی — فقط نمایش با primitiveهای نظام طراحی.
 * مسیرها، بدنه‌ها و ترتیب «ثبت شماره → کد تأیید → فعال» همان قبلی‌اند (ADR-008).
 */
export function SmsTwoFactor({ onEnrolled }: { onEnrolled?: () => void }) {
  const [status, setStatus] = useState<SmsStatus | null>(null);
  const [mobile, setMobile] = useState(""), [password, setPassword] = useState(""), [code, setCode] = useState("");
  const [pending, setPending] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [note, setNote] = useState("");
  /** قفل همگام: دو کلیک پیش از رندر بعدی، دو پیامک نمی‌فرستد. */
  const busyRef = useRef(false);
  useEffect(() => {
    void api.get<SmsStatus>("/auth/2fa/sms/status").then(setStatus)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : "خواندن تنظیمات پیامک ممکن نشد."));
  }, []);
  async function act(kind: "enroll" | "confirm" | "disable") {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(""); setNote("");
    try {
      await api.post(`/auth/2fa/sms/${kind}`, kind === "confirm" ? { code: normalizeDigits(code) } : kind === "enroll" ? { mobile: normalizeDigits(mobile), currentPassword: password } : { currentPassword: password });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "درخواست انجام نشد.");
      busyRef.current = false; setBusy(false);
      return;
    }
    setPassword(""); setCode(""); setPending(kind === "enroll");
    setNote(kind === "enroll" ? "کد در صف ارسال است؛ پس از دریافت، حداکثر ظرف دو دقیقه وارد کنید." : kind === "confirm" ? "ورود دومرحله‌ای پیامکی فعال شد." : "ورود پیامکی برداشته شد.");
    if (kind !== "enroll") onEnrolled?.();
    // درخواست ثبت شد؛ خطای خواندن دوبارهٔ وضعیت، شکست آن درخواست نیست.
    try { setStatus(await api.get<SmsStatus>("/auth/2fa/sms/status")); }
    catch { setError("وضعیت پیامک پس از این تغییر خوانده نشد؛ برای دیدن وضعیت تازه صفحه را دوباره باز کنید."); }
    finally { busyRef.current = false; setBusy(false); }
  }
  const codeOk = /^\d{6}$/.test(normalizeDigits(code));
  return <Solid as="section" className="settings-section" aria-label="ورود دومرحله‌ای پیامکی">
    <SectionHeader title="کد ورود با پیامک" level={3}
      description="پیامک یک روش اختیاری است. Passkey در برابر فیشینگ و تعویض سیم‌کارت امن‌تر است؛ می‌توانید روش‌های قبلی را نگه دارید."
      actions={status ? <StatusBadge state={status.enabled ? "completed" : "draft"} label={status.enabled ? "فعال" : "غیرفعال"} /> : null} />
    <p className="settings-facts" style={{ margin: 0 }}>
      {status?.enabled ? <>فعال برای <Ltr>{status.maskedMobile ?? "—"}</Ltr></> : "هنوز شماره‌ای تأیید نشده است."}
    </p>
    <p className="settings-note" style={{ margin: 0 }}>ابتدا ارسال پیامک و سرویس ملی‌پیامک را در تنظیمات آماده کنید. تغییر شماره فقط پس از تأیید شماره جدید اعمال می‌شود.</p>
    <div className="settings-form">
      <Field label="رمز عبور فعلی برای تنظیم پیامک" hint="برای ثبت شماره یا برداشتن ورود پیامکی لازم است.">
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Field label="موبایل دریافت کد ورود">
        <input type="tel" value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder="09xxxxxxxxx" />
      </Field>
      <div className="settings-actions">
        <Button busy={busy && !pending} busyLabel="در حال ارسال…" disabled={busy || !password || !mobile} onClick={() => void act("enroll")}>ارسال کد تأیید شماره</Button>
        {status?.enabled ? <Button variant="danger" disabled={busy || !password} onClick={() => void act("disable")}>برداشتن ورود پیامکی</Button> : null}
      </div>
      {pending ? <>
        <Field label="کد تأیید پیامک" hint="کد ۶ رقمی؛ رقم فارسی هم پذیرفته می‌شود.">
          <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <div className="settings-actions">
          <Button variant="primary" disabled={busy || !codeOk} onClick={() => void act("confirm")}>تأیید و فعال‌سازی پیامک</Button>
        </div>
      </> : null}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      {note ? <p className="set-msg" role="status">{note}</p> : null}
    </div>
  </Solid>;
}
