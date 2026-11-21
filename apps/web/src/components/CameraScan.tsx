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
  const onCodeRef = useRef(onCode);
  useEffect(() => { onCodeRef.current = onCode; }, [onCode]);
  const [error, setError] = useState<string | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const [lenses,setLenses] = useState<MediaDeviceInfo[]>([]);
  const [lens,setLens] = useState("");
  const [activeLens,setActiveLens] = useState("");
  const [hasTorch,setHasTorch] = useState(false);
  const [torch,setTorch] = useState(false);
  const [starting, setStarting] = useState(true);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // بسته‌شدن کامپوننت وسط یک `await` نباید حلقه را زنده نگه دارد.
    let alive = true;

    void (async () => {
      try {
        setStarting(true); setError(null); setTorch(false); setHasTorch(false);
        const detector = await resolveDetector();
        if (!alive) return;
        const media = await navigator.mediaDevices.getUserMedia(lens ? {audio:false,video:{deviceId:{exact:lens},width:{ideal:1920},height:{ideal:1080}}} : CAMERA_CONSTRAINTS);
        stream = media;
        if (!alive) {
          for (const t of media.getTracks()) t.stop();
          return;
        }
        const track = media.getVideoTracks?.()[0];
        if (track) {
          trackRef.current = track;
          const capabilities = track.getCapabilities?.() as (MediaTrackCapabilities & {focusMode?:string[]; torch?:boolean}) | undefined;
          if (capabilities?.focusMode?.includes("continuous")) {
            await track.applyConstraints({advanced:[{focusMode:"continuous"} as MediaTrackConstraintSet]}).catch(() => {});
          }
          if (!alive) return;
          setHasTorch(capabilities?.torch === true);
          setActiveLens(track.getSettings?.().deviceId ?? "");
          void navigator.mediaDevices.enumerateDevices?.().then(devices => {
            if (alive) setLenses(devices.filter(d => d.kind === "videoinput" && d.deviceId));
          }).catch(() => {});
        }
        const el = video.current;
        if (el) {
          el.srcObject = media;
          await el.play();
        }
        if (!alive) return;
        setStarting(false);

        const tick = async () => {
          if (!alive) return;
          const v = video.current;
          if (v && v.readyState >= 2) {
            try {
              const start = performance.now();
              const results = await detector.detect(v);
              if (!alive) return;
              if (!results.length) throttle.current.absentFrame();
              else {
                performance.clearMeasures("pos-camera-decode");
                performance.measure("pos-camera-decode", {start, end:performance.now()});
              }
              for (const found of results.slice(0, 1)) {
                if (!alive) return;
                const code = found.rawValue.trim();
                // مهار تکرار: دوربین همان بارکد را ده‌ها بار می‌بیند.
                if (code !== "" && throttle.current.accept(code)) {
                  onCodeRef.current(code);
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
        if (stream) for (const track of stream.getTracks()) track.stop();
        stream = null;
        if (alive) {
          setError(cameraError(err));
          setStarting(false);
        }
      }
    })();

    return () => {
      trackRef.current = null;
      alive = false;
      if (timer) clearTimeout(timer);
      // دوربین **حتماً** خاموش می‌شود. رها کردن Track یعنی چراغ گوشی
      // روشن می‌ماند حتی بعد از بستن پنل.
      if (stream) for (const t of stream.getTracks()) t.stop();
    };
  }, [lens]);

  return (
    <Solid className="cam stack" style={{ gap: "var(--s-2)" }}>
      <div className="cam-frame">
        <video ref={video} playsInline muted aria-label="نمای دوربین" />
        {/* کادر هدف: بدون آن کاربر نمی‌داند بارکد را کجا بگیرد. */}
        <span className="cam-target" aria-hidden="true" />
      </div>
      {lenses.length > 1 && <label>دوربین<select value={activeLens} onChange={e => setLens(e.target.value)}>
        {lenses.map((d,i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `دوربین ${i+1}`}</option>)}
      </select></label>}
      {hasTorch && <button type="button" className="tool" aria-pressed={torch} onClick={async () => {
        try { await trackRef.current?.applyConstraints({advanced:[{torch: !torch} as MediaTrackConstraintSet]}); setTorch(!torch); }
        catch { setError("تغییر نور دوربین ممکن نشد."); }
      }}>چراغ دوربین</button>}
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
