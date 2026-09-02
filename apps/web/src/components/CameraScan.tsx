/**
 * دوربین به‌جای بارکدخوان.
 *
 * فقط وقتی باز می‌شود که کاربر بخواهد: دوربینِ همیشه‌روشن باتری گوشی
 * را می‌خورد و چراغ دوربین در دست صندوق‌دار، جلوی مشتری، سؤال‌برانگیز
 * است.
 *
 * ── چرا حلقه دستی و نه `requestVideoFrameCallback` ───────────────
 *
 * آن API روی هر فریم اجرا می‌شود — تا ۶۰ بار در ثانیه — و هر بار یک
 * تشخیص بارکد یعنی باتری گوشی نیم‌ساعته تمام می‌شود. ۱۰ بار در ثانیه
 * برای گرفتن گوشی جلوی یک برچسب کاملاً کافی است و کاربر تفاوتش را
 * حس نمی‌کند.
 */
import { useEffect, useRef, useState } from "react";
import { Solid } from "./Glass.tsx";
import {
  CAMERA_CONSTRAINTS,
  cameraError,
  resolveDetector,
  ScanThrottle,
} from "../lib/camera-scan.ts";

/** فاصله میان دو تلاش تشخیص. */
const TICK_MS = 100;

export function CameraScan({
  onCode,
  onClose,
}: {
  onCode: (barcode: string) => void;
  onClose: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const throttle = useRef(new ScanThrottle());
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // بسته‌شدن کامپوننت وسط یک `await` نباید حلقه را زنده نگه دارد.
    let alive = true;

    void (async () => {
      try {
        const [media, detector] = await Promise.all([
          navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS),
          resolveDetector(),
        ]);
        if (!alive) {
          for (const t of media.getTracks()) t.stop();
          return;
        }
        stream = media;
        const el = video.current;
        if (el) {
          el.srcObject = media;
          await el.play().catch(() => undefined);
        }
        setStarting(false);

        const tick = async () => {
          if (!alive) return;
          const v = video.current;
          if (v && v.readyState >= 2) {
            try {
              for (const found of await detector.detect(v)) {
                const code = found.rawValue.trim();
                // مهار تکرار: دوربین همان بارکد را ده‌ها بار می‌بیند.
                if (code !== "" && throttle.current.accept(code, Date.now())) {
                  onCode(code);
                }
              }
            } catch {
              // یک فریم ناخوانا خطا نیست — فریم بعدی می‌آید.
            }
          }
          if (alive) timer = setTimeout(() => void tick(), TICK_MS);
        };
        void tick();
      } catch (err) {
        if (alive) {
          setError(cameraError(err));
          setStarting(false);
        }
      }
    })();

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      // دوربین **حتماً** خاموش می‌شود. رها کردن Track یعنی چراغ گوشی
      // روشن می‌ماند حتی بعد از بستن پنل.
      if (stream) for (const t of stream.getTracks()) t.stop();
    };
  }, [onCode]);

  return (
    <Solid className="cam stack" style={{ gap: "var(--s-2)" }}>
      <div className="cam-frame">
        <video ref={video} playsInline muted aria-label="نمای دوربین" />
        {/* کادر هدف: بدون آن کاربر نمی‌داند بارکد را کجا بگیرد. */}
        <span className="cam-target" aria-hidden="true" />
      </div>
      {starting ? <p className="muted small" style={{ margin: 0 }}>در حال باز کردن دوربین…</p> : null}
      {error ? (
        <p className="auth-error" role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> {error}
        </p>
      ) : null}
      <button type="button" className="btn btn--quiet" onClick={onClose}>
        بستن دوربین
      </button>
    </Solid>
  );
}
