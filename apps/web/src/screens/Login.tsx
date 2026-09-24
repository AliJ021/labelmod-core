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
import { getAssertion, webauthnAvailable } from "../lib/webauthn.ts";
import { normalizeDigits } from "../lib/settings-value.ts";

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

  /**
   * مرحله دوم.
   *
   * `null` یعنی هنوز رمز داده نشده. مقدار داشتن یعنی رمز **درست** بوده
   * و حالا کد لازم است — و در این حالت هیچ نشستی وجود ندارد؛ بلیتش در
   * کوکی HttpOnly است و این کد هرگز نمی‌بیندش.
   */
  const [second, setSecond] = useState<{
    fullName: string;
    methods: Array<"totp" | "webauthn" | "recovery" | "sms">;
  } | null>(null);
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [useSms, setUseSms] = useState(false);
  const [smsNote, setSmsNote] = useState("");

  useEffect(() => first.current?.focus(), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const out = await session.login({
        username: username.trim(),
        password,
        deviceFingerprint: deviceFingerprint(),
      });
      // رمز حتی یک لحظه بیشتر از لازم در حافظه نمی‌ماند — چه ورود
      // تمام شده باشد چه به مرحله دوم رفته باشیم.
      setPassword("");

      if ("needsSecondFactor" in out) {
        setSecond({ fullName: out.fullName, methods: out.methods });
        setUseSms(out.methods.includes("sms") && !out.methods.includes("totp") && !out.methods.includes("webauthn"));
        setUseRecovery(false); setSmsNote("");
        return;
      }
      onDone();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * ورود با کلید امنیتی.
   *
   * انصراف کاربر (`NotAllowedError`) خطا نیست و پیام قرمز نمی‌گیرد —
   * کاربر همان‌جا می‌ماند و می‌تواند راه دیگری را انتخاب کند.
   */
  async function submitKey() {
    if (busy || second === null) return;
    setBusy(true);
    setError(null);
    try {
      const options = await session.beginWebauthnLogin();
      let response: Record<string, unknown>;
      try {
        response = await getAssertion(options);
      } catch (err) {
        if ((err as { name?: string }).name === "NotAllowedError") return;
        throw new Error("مرورگر نتوانست کلید را بخواند. دوباره تلاش کنید.", {
          cause: err,
        });
      }
      await session.verifyWebauthnLogin(response);
      onDone();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (busy || second === null) return;
    setBusy(true);
    setError(null);
    try {
      await session.secondFactor(useRecovery ? "recovery" : useSms ? "sms" : "totp", {
        code: normalizeDigits(code),
        deviceFingerprint: deviceFingerprint(),
      });
      setCode("");
      onDone();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  if (second !== null) {
    // «چه چیزی نشان داده شود» از **روش‌های همین کاربر** می‌آید، نه از
    // یک فرض ثابت که همه TOTP دارند.
    const codeMethod = useRecovery || useSms || second.methods.includes("totp");
    const showKey = !useRecovery && !useSms && second.methods.includes("webauthn") && webauthnAvailable();
    return (
      <div className="auth-wrap">
        <Glass as="section" radius="lg" className="pad auth-card" live>
          <h1 className="auth-title">مرحله دوم</h1>
          <p className="muted" style={{ marginTop: 0 }}>
            {second.fullName} — {useRecovery
              ? "یکی از کدهای بازیابی را وارد کنید."
              : useSms ? "کد شش‌رقمی پیامک را وارد کنید." : codeMethod
                ? "کد شش‌رقمی برنامه Authenticator را وارد کنید."
                : "با کلید امنیتی خود ادامه دهید."}
          </p>

          {/*
            کلید اول می‌آید چون بند ۱ SECURITY.md آن را **اولویت اول**
            گذاشته: مقاوم در برابر فیشینگ. کد شش‌رقمی در یک صفحه جعلی
            تایپ شود، همان لحظه لو رفته است.
          */}
          {showKey ? (
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy}
              onClick={() => void submitKey()}
              style={{ marginBottom: "var(--s-3)" }}
            >
              {busy ? "در حال بررسی…" : "ورود با کلید امنیتی"}
            </button>
          ) : null}

          {/*
            کاربری که فقط کلید دارد نباید فرم کدی ببیند که هرگز
            نمی‌تواند پرش کند — یک بن‌بست بی‌صدا.
          */}
          {second.methods.includes("sms") ? <button type="button" className="btn" disabled={busy} onClick={async () => {
            setBusy(true); setError(null); setUseRecovery(false); setUseSms(true); setCode("");
            try { const r = await session.requestSms(); setSmsNote(`کد برای ${r.maskedMobile} در صف ارسال است؛ اعتبار دو دقیقه.`); }
            catch (e) { setError(message(e)); } finally { setBusy(false); }
          }}>ارسال کد ورود با پیامک</button> : null}
          {smsNote ? <p role="status">{smsNote}</p> : null}
          {useSms && (second.methods.includes("totp") || second.methods.includes("webauthn")) ? <button type="button" className="link" onClick={() => { setUseSms(false); setCode(""); }}>استفاده از Authenticator یا کلید امنیتی</button> : null}
          {codeMethod ? (
          <form onSubmit={submitCode} className="stack" style={{ gap: "var(--s-3)" }}>
            <Solid className="auth-field">
              <label htmlFor="lm-code">{useRecovery ? "کد بازیابی" : "کد شش‌رقمی"}</label>
              {/*
                `type="text"` نه `type="number"` — صفحه‌کلید فارسی «۴۸»
                می‌فرستد و ورودی عددی مرورگر آن را دور می‌اندازد.
                `normalizeDigits` رقم فارسی و عربی را می‌فهمد.
              */}
              <input
                id="lm-code"
                type="text"
                inputMode={useRecovery ? "text" : "numeric"}
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
                required
              />
            </Solid>

            <button type="submit" className="btn btn--primary" disabled={busy}>
              {busy ? "در حال بررسی…" : "ورود"}
            </button>
          </form>
          ) : null}

          {/*
            بن‌بست واقعی: کاربر فقط کلید دارد و این مرورگر کلید
            نمی‌فهمد. صفحه‌ای که در این حالت خالی بماند، کاربر را بدون
            هیچ توضیحی رها می‌کند.
          */}
          {!codeMethod && !showKey ? (
            <p className="auth-error" role="alert">
              <span className="dot dot--warn" aria-hidden="true">▲</span> این مرورگر کلید
              امنیتی را پشتیبانی نمی‌کند. از مرورگری روی اتصال امن (HTTPS) وارد شوید یا
              از کد بازیابی استفاده کنید.
            </p>
          ) : null}

          {/*
            خطا بیرون از فرم است، وگرنه در حالت «فقط کلید» — که فرمی
            ندارد — هیچ خطایی دیده نمی‌شد.
          */}
          {error ? (
            <p className="auth-error" role="alert">
              <span className="dot dot--crit" aria-hidden="true">●</span> {error}
            </p>
          ) : null}

          {second.methods.includes("recovery") ? (
            <button
              type="button"
              className="link"
              onClick={() => {
                setUseRecovery((v) => !v);
                setCode("");
                setError(null);
              }}
            >
              {useRecovery
                ? codeMethod
                  ? "برگشت به کد Authenticator"
                  : "برگشت"
                : "گوشی‌ام در دسترس نیست"}
            </button>
          ) : null}
        </Glass>
      </div>
    );
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
