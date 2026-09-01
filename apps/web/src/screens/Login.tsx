/**
 * ورود و قفل صفحه.
 *
 * ADR-002 این ناحیه را «شیشه کامل» گذاشته: لحظه اول است، هیچ کار
 * حساسی در جریان نیست و عددی روی صفحه نیست که خوانده شود. ولی خودِ
 * ورودی‌ها `Solid`اند — رمز و PIN باید پرتضاد تایپ شوند.
 *
 * دو حالت، یک فایل، چون یک تصمیم‌اند: «چه کسی پشت این صفحه است؟»
 *
 *   ورود   نام کاربری و رمز — نشست تازه می‌سازد
 *   قفل    فقط PIN — نشستِ موجود را باز می‌کند
 *
 * PIN عمداً نشست **نمی‌سازد**. بند ۱ SECURITY.md: «PIN برای باز کردن
 * قفل نشست موجود است، نه برای ساختن نشست جدید.» اگر نشست رفته باشد،
 * سرور `no_session` می‌دهد و همین‌جا به فرم ورود برمی‌گردیم.
 */
import { useEffect, useRef, useState } from "react";
import { Glass, Solid } from "../components/Glass.tsx";
import { ApiError } from "../lib/api.ts";
import { deviceFingerprint } from "../lib/device.ts";
import { isNoSession, session } from "../lib/session.ts";

/** پیام خطای کاربرپسند از هر چیزی که پرتاب شده. */
function message(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "ارتباط با سرور برقرار نشد. اتصال شبکه را بررسی کنید.";
}

export function Login({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => first.current?.focus(), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await session.login({
        username: username.trim(),
        password,
        deviceFingerprint: deviceFingerprint(),
      });
      // رمز حتی یک لحظه بیشتر از لازم در حافظه نمی‌ماند.
      setPassword("");
      onDone();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <Glass as="section" radius="lg" className="pad auth-card" live>
        <h1 className="auth-title">لیبل مد</h1>
        <p className="muted" style={{ marginTop: 0 }}>برای ادامه وارد شوید.</p>

        <form onSubmit={submit} className="stack" style={{ gap: "var(--s-3)" }}>
          <Solid className="auth-field">
            <label htmlFor="lm-user">نام کاربری</label>
            <input
              id="lm-user"
              ref={first}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="off"
              spellCheck={false}
              required
            />
          </Solid>

          <Solid className="auth-field">
            <label htmlFor="lm-pass">رمز عبور</label>
            <input
              id="lm-pass"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Solid>

          {error ? (
            <p className="auth-error" role="alert">
              <span className="dot dot--crit" aria-hidden="true">●</span> {error}
            </p>
          ) : null}

          <button type="submit" className="auth-submit" disabled={busy}>
            {busy ? "در حال ورود…" : "ورود"}
          </button>
        </form>
      </Glass>
    </div>
  );
}

/**
 * صفحه قفل — نشست زنده است، فقط پشت یک PIN.
 *
 * «ورود با کاربر دیگر» همیشه در دسترس است: اگر شیفت عوض شده باشد،
 * نفر بعدی نباید پشت PIN نفر قبلی گیر کند.
 */
export function LockScreen({
  fullName,
  onUnlocked,
  onSwitchUser,
}: {
  fullName: string;
  onUnlocked: () => void;
  onSwitchUser: () => void;
}) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLInputElement>(null);

  useEffect(() => box.current?.focus(), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await session.unlock({ pin, deviceFingerprint: deviceFingerprint() });
      setPin("");
      onUnlocked();
    } catch (err) {
      // نشست دیگر نیست — نگه‌داشتن کاربر پشت صفحه PIN بی‌فایده است.
      if (isNoSession(err)) {
        onSwitchUser();
        return;
      }
      setError(message(err));
      setPin("");
      box.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <Glass as="section" radius="lg" className="pad auth-card" live>
        <h1 className="auth-title">صفحه قفل است</h1>
        <p className="muted" style={{ marginTop: 0 }}>{fullName}</p>

        <form onSubmit={submit} className="stack" style={{ gap: "var(--s-3)" }}>
          <Solid className="auth-field">
            <label htmlFor="lm-pin">PIN</label>
            {/*
              `type="text"` با `inputMode="numeric"`، نه `type="number"`:
              همان دلیلی که در فرم تنظیمات هست — ورودی عددی مرورگر با
              صفحه‌کلید فارسی بدرفتاری می‌کند. اینجا `pattern` هم فقط
              رقم لاتین می‌پذیرد چون PIN را سرور با `^\d{4,8}$` می‌سنجد.
            */}
            <input
              id="lm-pin"
              ref={box}
              type="password"
              inputMode="numeric"
              pattern="[0-9]{4,8}"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              autoComplete="off"
              required
            />
          </Solid>

          {error ? (
            <p className="auth-error" role="alert">
              <span className="dot dot--crit" aria-hidden="true">●</span> {error}
            </p>
          ) : null}

          <button type="submit" className="auth-submit" disabled={busy}>
            {busy ? "در حال باز کردن…" : "باز کردن"}
          </button>
          <button type="button" className="auth-alt" onClick={onSwitchUser}>
            ورود با کاربر دیگر
          </button>
        </form>
      </Glass>
    </div>
  );
}

/**
 * ارتقای نشست — تنها راه درآوردن نشست از حالت PIN.
 *
 * بند ۱ SECURITY.md: «بازپرداخت، ابطال فاکتور، تغییر قیمت و اصلاح
 * موجودی نیازمند احراز هویت کامل مجدد است — نه PIN.» یعنی
 * `identity.can()` این عملیات را روی نشست PIN می‌بندد و تنها
 * `/auth/reauth` بازشان می‌کند.
 *
 * چرا یک فرم جدا و نه «دوباره وارد شو»: خروج و ورود دوباره نشست را
 * **عوض** می‌کند و سبد نیمه‌تمام صندوق‌دار را می‌اندازد. ارتقا همان
 * نشست را نگه می‌دارد.
 */
export function ReauthPanel({
  onDone,
  onCancel,
}: {
  onDone: () => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLInputElement>(null);

  useEffect(() => box.current?.focus(), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await session.reauth(password);
      setPassword("");
      onDone();
    } catch (err) {
      setError(message(err));
      setPassword("");
      box.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <Glass as="section" radius="lg" className="pad auth-card" live>
        <h1 className="auth-title">ارتقای نشست</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          این نشست با PIN باز شده. برای بازپرداخت، ابطال فاکتور یا تغییر قیمت، رمز کامل
          لازم است.
        </p>

        <form onSubmit={submit} className="stack" style={{ gap: "var(--s-3)" }}>
          <Solid className="auth-field">
            <label htmlFor="lm-reauth">رمز عبور</label>
            <input
              id="lm-reauth"
              ref={box}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Solid>

          {error ? (
            <p className="auth-error" role="alert">
              <span className="dot dot--crit" aria-hidden="true">●</span> {error}
            </p>
          ) : null}

          <button type="submit" className="auth-submit" disabled={busy}>
            {busy ? "…" : "ارتقا"}
          </button>
          <button type="button" className="auth-alt" onClick={onCancel} disabled={busy}>
            بعداً
          </button>
        </form>
      </Glass>
    </div>
  );
}
