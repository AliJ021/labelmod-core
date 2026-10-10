/**
 * راه‌اندازی احراز هویت دومرحله‌ای — روی حساب **خودِ کاربر**.
 *
 * ── چرا مدیر نمی‌تواند برای دیگری راه بیندازد ─────────────────────
 *
 * راز TOTP باید فقط به گوشی همان آدم برسد. اگر مدیر می‌توانست
 * راهش بیندازد، رازی که باید فقط دست یک نفر باشد از دو دستگاه رد
 * می‌شد — و آن‌وقت «عامل دوم» دیگر عامل دوم نیست.
 *
 * برداشتنش اما کار مدیر هم هست (`user.manage`، در صفحه پرسنل): کسی
 * که گوشی‌اش را گم کرده و کد بازیابی هم ندارد، باید راهی داشته باشد.
 *
 * ── QR اینجا کشیده نمی‌شود ────────────────────────────────────────
 *
 * کشیدن QR یک کتابخانه تازه می‌خواهد و `docs/SECURITY.md` بند ۵
 * می‌گوید «هیچ وابستگی‌ای بدون دلیل مشخص». راز به‌شکل متن نشان داده
 * می‌شود و هر اپ Authenticator ورود دستی دارد — یک بار، سی ثانیه.
 * اگر روزی QR واقعاً لازم شد، یک ADR می‌خواهد نه یک `pnpm add`.
 */
import { useCallback, useEffect, useState } from "react";
import { ResultState } from "../components/ResultState.tsx";
import { Ltr } from "../components/ui/Bidi.tsx";
import { Button, Field } from "../components/ui/Controls.tsx";
import { PageHeader, SectionHeader } from "../components/ui/PageHeader.tsx";
import { StatusBadge } from "../components/ui/Status.tsx";
import { Skeleton } from "../components/ui/Skeleton.tsx";
import { Solid } from "../components/Glass.tsx";
import { ApiError } from "../lib/api.ts";
import { formatCount, formatJalaliMoment } from "../lib/format.ts";
import { normalizeDigits } from "../lib/settings-value.ts";
import { session, type TwoFactorStatus, type WebauthnKey } from "../lib/session.ts";
import { createCredential, webauthnAvailable } from "../lib/webauthn.ts";
import { SmsTwoFactor } from "./SmsTwoFactor.tsx";

function message(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "ارتباط با سرور برقرار نشد.";
}

export function TwoFactor({ onEnrolled }: { onEnrolled?: () => void } = {}) {
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** خطای خواندن وضعیت، جدا از خطای عملیات؛ فقط این یکی «تلاش دوباره» دارد. */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  /** کدهای بازیابی — روی صفحه می‌مانند تا کاربر ببندشان. */
  const [codes, setCodes] = useState<string[] | null>(null);

  /** کلیدهای امنیتی — فهرست جدا از وضعیت، چون جدا هم عوض می‌شود. */
  const [keys, setKeys] = useState<WebauthnKey[]>([]);
  const [keyName, setKeyName] = useState("");

  /**
   * وضعیت و کلیدها با هم خوانده و با هم نشانده می‌شوند. پیش‌تر وضعیت اول نشسته بود و
   * شکست خواندن کلیدها، صفحه را با `keys = []` («کلیدی ثبت نشده») نشان می‌داد.
   */
  const reload = useCallback(async () => {
    const [nextStatus, nextKeys] = await Promise.all([session.twoFactor(), session.webauthnKeys()]);
    setStatus(nextStatus);
    setKeys(nextKeys.credentials);
  }, []);
  /**
   * خواندن دوباره پس از یک تغییر موفق: شکستش شکست آن تغییر نیست. وضعیت روی صفحه
   * کهنه علامت می‌خورد و کنش‌ها تا خواندن موفق بسته‌اند؛ «به‌روزرسانی» فقط می‌خواند.
   */
  const [stale, setStale] = useState(false);
  const refresh = useCallback(async () => {
    try { await reload(); setStale(false); } catch { setStale(true); }
  }, [reload]);
  const blocked = busy || stale;

  useEffect(() => {
    setLoadError(null);
    void (async () => {
      try {
        await reload();
      } catch (err) {
        setLoadError(message(err));
      }
    })();
  }, [reload, attempt]);

  async function guarded(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  const begin = () =>
    guarded(async () => {
      setCodes(null);
      setSecret((await session.beginTotp()).secret);
    });

  const confirm = () =>
    guarded(async () => {
      const out = await session.confirmTotp(normalizeDigits(code));
      setCodes(out.recoveryCodes);
      setSecret(null);
      setCode("");
      await refresh();
    });

  const regenerate = () =>
    guarded(async () => {
      setCodes((await session.regenerateRecovery()).recoveryCodes);
      await refresh();
    });

  /**
   * ثبت یک کلید — مراسم در مرورگر، تأیید در سرور.
   *
   * `NotAllowedError` یعنی کاربر انصراف داد یا مهلت تمام شد؛ آن یک
   * خطا نیست و پیام قرمز نمی‌خواهد. `InvalidStateError` یعنی همین
   * کلید قبلاً ثبت شده — که `excludeCredentials` عمداً می‌سازدش.
   */
  const addKey = () =>
    guarded(async () => {
      const options = await session.beginWebauthnRegistration();
      let response: Record<string, unknown>;
      try {
        response = await createCredential(options);
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name === "NotAllowedError") return;
        if (name === "InvalidStateError") {
          throw new Error("این کلید از قبل روی همین حساب ثبت شده است.", {
            cause: err,
          });
        }
        throw new Error("مرورگر نتوانست کلید را بسازد. دوباره تلاش کنید.", {
          cause: err,
        });
      }
      await session.finishWebauthnRegistration(response, keyName);
      setKeyName("");
      await refresh();
      onEnrolled?.();
    });

  const removeKey = (id: string) =>
    guarded(async () => {
      await session.removeWebauthnKey(id);
      await refresh();
    });

  const disable = () =>
    guarded(async () => {
      await session.disableTwoFactor();
      setCodes(null);
      setSecret(null);
      await refresh();
    });

  // در حالت ثبت اجباری، سرعنوان صفحه را خودِ کارت ورود دارد؛ در تنظیمات، این بخش سرعنوان خودش را می‌گیرد.
  const header = onEnrolled === undefined
    ? <PageHeader title="ورود دومرحله‌ای"
      context="پیامک، برنامهٔ Authenticator و کلید امنیتی. هر کدام جدا روشن یا خاموش می‌شود و هیچ‌کدام جای رمز ورود را نمی‌گیرد." />
    : null;

  if (!status) {
    return <div className="settings-page">
      {header}
      <Solid as="section" className="settings-section">
        {loadError !== null
          ? <ResultState kind="error" title={loadError} actionLabel="تلاش دوباره" onAction={() => setAttempt((v) => v + 1)} />
          : <Skeleton variant="row" lines={3} label="در حال دریافت وضعیت ورود دومرحله‌ای…" />}
      </Solid>
    </div>;
  }

  return (
    <div className="stack" style={{ gap: "var(--s-3)" }}>
      {header}
      <SmsTwoFactor onEnrolled={() => { void refresh(); onEnrolled?.(); }} />
      {error ? (
        <p className="solid pos-alert" role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> {error}
        </p>
      ) : null}
      {stale ? <ResultState kind="error" title="تغییر ثبت شد، ولی وضعیت به‌روز نشد."
        description="وضعیت روی صفحه ممکن است قدیمی باشد؛ کنش‌ها تا به‌روزرسانی بسته‌اند."
        actionLabel="به‌روزرسانی وضعیت" onAction={() => void refresh()} /> : null}

      {/*
        هشدار، نه قفل.

        اگر نقش کاربر در فهرست الزام باشد ولی هنوز راه نینداخته باشد،
        ورودش بسته **نمی‌شود** — وگرنه اولین بار که مالک آن تنظیم را
        روشن کند، خودش هم بیرون می‌ماند. اجبار وقتی معنا دارد که
        راه‌اندازی ممکن باشد.
      */}
      {status.shouldHave && !status.enabled && !status.smsEnabled && status.webauthnKeys === 0 ? (
        <p className="solid pos-alert" role="alert">
          <span className="dot dot--warn" aria-hidden="true">▲</span> نقش شما احراز هویت
          دومرحله‌ای لازم دارد و هنوز راه نیفتاده است.
        </p>
      ) : null}

      {/*
        کلید امنیتی — بند ۱ SECURITY.md آن را **اولویت اول** گذاشته،
        نه پشتیبان: کلید به دامنه گره خورده، پس صفحه جعلی نمی‌تواند
        از آن استفاده کند. TOTP این را ندارد.

        بخش مستقل از TOTP است چون کاربر می‌تواند فقط کلید داشته باشد:
        یک کلید ثبت‌شده خودش عامل دوم را الزامی می‌کند.
      */}
      <Solid as="section" className="settings-section" aria-labelledby="mfa-passkey">
        <SectionHeader id="mfa-passkey" title="کلید امنیتی (Passkey)" level={2}
          description="در برابر فیشینگ مقاوم است: کلید به دامنه گره خورده و صفحه جعلی نمی‌تواند از آن استفاده کند."
          actions={<StatusBadge state={keys.length > 0 ? "completed" : "draft"} label={keys.length > 0 ? `${formatCount(keys.length)} کلید` : "کلیدی ثبت نشده"} />} />

        {keys.length === 0 ? (
          <p className="empty">کلیدی ثبت نشده است.</p>
        ) : (
          <ul className="lines">
            {keys.map((k) => (
              <li key={k.id} className="row" style={{ justifyContent: "space-between", gap: "var(--s-2)", flexWrap: "wrap" }}>
                <span>
                  <strong>{k.name ?? "کلید بی‌نام"}</strong>
                  <span className="muted small">
                    {" · "}
                    {k.lastUsedAt === null ? "هنوز استفاده نشده" : `آخرین بار ${formatJalaliMoment(k.lastUsedAt)}`}
                  </span>
                </span>
                <Button variant="quiet" disabled={blocked} onClick={() => void removeKey(k.id)}
                  aria-label={`حذف ${k.name ?? "کلید بی‌نام"}`}>
                  حذف
                </Button>
              </li>
            ))}
          </ul>
        )}

        {webauthnAvailable() ? (
          <div className="settings-form">
            <Field label="نامی برای این کلید" optional>
              <input type="text" value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="مثلاً: یوبی‌کی جیبی" />
            </Field>
            <div className="settings-actions">
              <Button variant="primary" busy={busy} busyLabel="در حال ثبت کلید…" disabled={blocked} onClick={() => void addKey()}>افزودن کلید امنیتی</Button>
            </div>
          </div>
        ) : (
          /*
            دکمه‌ای که با کلیک خطای مبهم مرورگر بدهد، بدتر از نبودنش
            است. `PublicKeyCredential` روی هر چیزی که HTTPS نیست
            وجود ندارد.
          */
          <p className="settings-note" style={{ margin: 0 }}>
            این مرورگر کلید امنیتی را پشتیبانی نمی‌کند. کلید امنیتی به اتصال امن
            (HTTPS) نیاز دارد.
          </p>
        )}
      </Solid>

      <Solid as="section" className="settings-section" aria-labelledby="mfa-totp">
        <SectionHeader id="mfa-totp" title="برنامه Authenticator (TOTP)" level={2}
          description={status.enabled
            ? `${formatCount(status.recoveryCodesLeft)} کد بازیابی مانده است.`
            : "با یک برنامه Authenticator راه می‌افتد."}
          actions={<StatusBadge state={status.enabled ? "completed" : "draft"} label={status.enabled ? "فعال" : "غیرفعال"} />} />

        {codes ? (
          <div className="stack" style={{ gap: "var(--s-2)" }}>
            <SectionHeader title="کدهای بازیابی" level={3} />
            <p className="small" role="alert" style={{ margin: 0 }}>
              <span className="dot dot--warn" aria-hidden="true">▲</span> این کدها فقط همین
              یک بار نشان داده می‌شوند. جایی امن نگهشان دارید — بدون آن‌ها و بدون گوشی،
              تنها راه، مدیر است.
            </p>
            <ul className="lines" style={{ userSelect: "all" }}>
              {codes.map((c) => (
                <li key={c}><Ltr>{c}</Ltr></li>
              ))}
            </ul>
            <div><Button onClick={() => { setCodes(null); onEnrolled?.(); }}>نوشتمشان، ببند</Button></div>
          </div>
        ) : null}

        {!status.enabled ? (
          secret === null ? (
            <div className="settings-actions">
              <Button variant="primary" busy={busy} busyLabel="در حال آماده‌سازی…" disabled={blocked} onClick={() => void begin()}>راه‌اندازی</Button>
            </div>
          ) : (
            <div className="settings-form">
              <p style={{ margin: 0 }}>این کلید را در برنامه Authenticator وارد کنید (گزینه «ورود دستی»):</p>
              <p style={{ fontSize: "1.2rem", userSelect: "all", margin: 0, overflowWrap: "anywhere" }}><Ltr>{secret}</Ltr></p>
              <Field label="کد شش‌رقمی که برنامه نشان می‌دهد">
                <input type="text" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
              </Field>
              <div className="settings-actions">
                <Button variant="primary" busy={busy} busyLabel="در حال تأیید…" disabled={blocked || code.trim() === ""} onClick={() => void confirm()}>تأیید و فعال‌سازی</Button>
                <Button disabled={busy} onClick={() => setSecret(null)}>انصراف</Button>
              </div>
            </div>
          )
        ) : (
          <div className="settings-form">
            <p className="settings-note" style={{ margin: 0 }}>ساخت فهرست تازه، کدهای قبلی را از همان لحظه بی‌اعتبار می‌کند.</p>
            <div className="settings-actions">
              <Button disabled={blocked} onClick={() => void regenerate()}>ساخت فهرست تازه کدهای بازیابی</Button>
              <Button variant="danger" disabled={blocked} onClick={() => void disable()}>برداشتن احراز هویت دومرحله‌ای</Button>
            </div>
          </div>
        )}
      </Solid>
    </div>
  );
}
