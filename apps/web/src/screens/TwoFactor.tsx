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
import { Solid } from "../components/Glass.tsx";
import { ApiError } from "../lib/api.ts";
import { normalizeDigits } from "../lib/settings-value.ts";
import { session, type TwoFactorStatus } from "../lib/session.ts";

function message(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "ارتباط با سرور برقرار نشد.";
}

export function TwoFactor() {
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  /** کدهای بازیابی — روی صفحه می‌مانند تا کاربر ببندشان. */
  const [codes, setCodes] = useState<string[] | null>(null);

  const reload = useCallback(async () => {
    setStatus(await session.twoFactor());
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await reload();
      } catch (err) {
        setError(message(err));
      }
    })();
  }, [reload]);

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
      await reload();
    });

  const regenerate = () =>
    guarded(async () => {
      setCodes((await session.regenerateRecovery()).recoveryCodes);
      await reload();
    });

  const disable = () =>
    guarded(async () => {
      await session.disableTwoFactor();
      setCodes(null);
      setSecret(null);
      await reload();
    });

  if (!status) {
    return <Solid className="pad">{error ?? "در حال بارگذاری…"}</Solid>;
  }

  return (
    <div className="stack" style={{ gap: "var(--s-3)" }}>
      {error ? (
        <p className="solid pos-alert" role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> {error}
        </p>
      ) : null}

      {/*
        هشدار، نه قفل.

        اگر نقش کاربر در فهرست الزام باشد ولی هنوز راه نینداخته باشد،
        ورودش بسته **نمی‌شود** — وگرنه اولین بار که مالک آن تنظیم را
        روشن کند، خودش هم بیرون می‌ماند. اجبار وقتی معنا دارد که
        راه‌اندازی ممکن باشد.
      */}
      {status.shouldHave && !status.enabled ? (
        <p className="solid pos-alert" role="alert">
          <span className="dot dot--warn" aria-hidden="true">▲</span> نقش شما احراز هویت
          دومرحله‌ای لازم دارد و هنوز راه نیفتاده است.
        </p>
      ) : null}

      <Solid className="pad stack" style={{ gap: "var(--s-2)" }}>
        <h2 style={{ margin: 0, fontSize: "1rem" }}>احراز هویت دومرحله‌ای</h2>
        <p className="muted small" style={{ margin: 0 }}>
          {status.enabled
            ? `فعال است · ${status.recoveryCodesLeft} کد بازیابی مانده`
            : "غیرفعال — با یک برنامه Authenticator راه می‌افتد."}
        </p>
      </Solid>

      {codes ? (
        <Solid className="pad stack" style={{ gap: "var(--s-2)" }}>
          <h3 style={{ margin: 0, fontSize: "1rem" }}>کدهای بازیابی</h3>
          <p className="small" role="alert" style={{ margin: 0 }}>
            <span className="dot dot--warn" aria-hidden="true">▲</span> این کدها فقط همین
            یک بار نشان داده می‌شوند. جایی امن نگهشان دارید — بدون آن‌ها و بدون گوشی،
            تنها راه، مدیر است.
          </p>
          <ul className="lines num" style={{ userSelect: "all" }}>
            {codes.map((c) => (
              <li key={c} dir="ltr">{c}</li>
            ))}
          </ul>
          <button type="button" className="btn btn--quiet" onClick={() => setCodes(null)}>
            نوشتمشان، ببند
          </button>
        </Solid>
      ) : null}

      {!status.enabled ? (
        secret === null ? (
          <Solid className="pad">
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy}
              onClick={() => void begin()}
            >
              راه‌اندازی
            </button>
          </Solid>
        ) : (
          <Solid className="pad stack" style={{ gap: "var(--s-3)" }}>
            <p style={{ margin: 0 }}>
              این کلید را در برنامه Authenticator وارد کنید (گزینه «ورود دستی»):
            </p>
            <p className="num" style={{ fontSize: "1.2rem", userSelect: "all" }} dir="ltr">
              {secret}
            </p>
            <label className="auth-field">
              <span>کد شش‌رقمی که برنامه نشان می‌دهد</span>
              <input
                type="text"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
              />
            </label>
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || code.trim() === ""}
              onClick={() => void confirm()}
            >
              تأیید و فعال‌سازی
            </button>
            <button
              type="button"
              className="btn btn--quiet"
              disabled={busy}
              onClick={() => setSecret(null)}
            >
              انصراف
            </button>
          </Solid>
        )
      ) : (
        <Solid className="pad stack" style={{ gap: "var(--s-2)" }}>
          <button
            type="button"
            className="btn btn--quiet"
            disabled={busy}
            onClick={() => void regenerate()}
          >
            ساخت فهرست تازه کدهای بازیابی
          </button>
          <p className="muted small" style={{ margin: 0 }}>
            کدهای قبلی از همان لحظه بی‌اعتبار می‌شوند.
          </p>
          <button
            type="button"
            className="btn btn--quiet"
            disabled={busy}
            onClick={() => void disable()}
          >
            برداشتن احراز هویت دومرحله‌ای
          </button>
        </Solid>
      )}
    </div>
  );
}
