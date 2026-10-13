import { useRef, useState } from "react";
import { api, ApiError } from "../lib/api.ts";
import { Ltr } from "./ui/Bidi.tsx";
import { StatusBadge } from "./ui/Status.tsx";
import { normalizeDigits } from "../lib/settings-value.ts";
import {
  DEFAULT_PRESET, LABEL_PRESETS, MAX_PER_VARIANT, MAX_TOTAL, groupByProduct, labelCalibrationBody, labelContentWarning, labelRequestBody,
  labelRequestProblem, labelSizeIssues, labelSizeProblem, queueTotal, rowSlots, type LabelLayout, type LabelSize,
} from "../lib/label-print.ts";
import { labelQueue, useLabelQueue } from "../lib/label-queue.ts";
import { labelSize, useLabelSizeChoice } from "../lib/label-size.ts";

const fa = (n: number) => n.toLocaleString("fa-IR");

/**
 * انتخاب اندازهٔ لیبل: اندازه‌های آماده، یا دلخواه، یا برگهٔ A4 — **مشترک**
 * میان صفحهٔ کالا و فهرست چاپ گروهی و ماندگار روی همین دستگاه
 * (`lib/label-size.ts`)؛ دو انتخاب جدا یعنی نوبت گروهی با اندازهٔ غلط.
 */
/** عدد میلی‌متری از ورودی؛ خالی یعنی «وارد نشده» (`NaN`)، نه صفر. «−» فارسی/یونیکد هم منفی است. */
const mm = (v: string) => (v.trim() === "" ? Number.NaN : Number(normalizeDigits(v).replace(/[−–]/g, "-")));

export function useLabelSize() {
  const { layout, preset, width, height, columns, gap, media, offset } = useLabelSizeChoice();
  // خانهٔ شروع فقط برای همین نوبت است و ماندگار نمی‌شود: رول نیمه‌مصرف استثناست، نه قاعده.
  const [startSlot, setStartSlot] = useState(1);
  const chosen = LABEL_PRESETS.find((p) => p.id === preset);
  const twoAcross = layout === "roll" && columns === "2";
  const size: LabelSize = {
    layout,
    width: chosen ? chosen.width : Number(normalizeDigits(width)),
    height: chosen ? chosen.height : Number(normalizeDigits(height)),
    ...(twoAcross ? { row: { columns: 2, gapMm: mm(gap), mediaWidthMm: mm(media), offsetXMm: mm(offset), startSlot: Math.min(startSlot, 2) } } : {}),
  };
  return {
    size, layout, preset, width, height, columns, gap, media, offset, startSlot,
    setLayout: (v: LabelLayout) => labelSize.set({ layout: v }),
    setPreset: (v: string) => labelSize.set({ preset: v }),
    setWidth: (v: string) => labelSize.set({ width: v }),
    setHeight: (v: string) => labelSize.set({ height: v }),
    /** رول دو‌ستونه BIXOLON: اندازهٔ هر لیبل ۵۰×۳۰؛ فاصله و لاینر را کاربر می‌سنجد. */
    setColumns: (v: "1" | "2") => labelSize.set(v === "2" ? { columns: "2", preset: "50x30" } : { columns: "1" }),
    setGap: (v: string) => labelSize.set({ gap: v }),
    setMedia: (v: string) => labelSize.set({ media: v }),
    setOffset: (v: string) => labelSize.set({ offset: v }),
    setStartSlot,
  };
}
export type LabelSizeState = ReturnType<typeof useLabelSize>;

export function LabelSizeFields({ state, onChange, idPrefix }: { state: LabelSizeState; onChange: () => void; idPrefix: string }) {
  const { layout, preset, width, height } = state;
  // خطای اندازه کنار خودِ میدان‌ها، نه زیر دکمه‌ها؛ و پیش از انتخاب هر تنوعی هم دیده می‌شود.
  // هر بُعد خطای خودش را دارد: فقط میدانِ نامعتبر aria-invalid و توضیح خودش را می‌گیرد.
  const issues = labelSizeIssues(state.size);
  const widthId = `${idPrefix}-width-error`, heightId = `${idPrefix}-height-error`, rowId = `${idPrefix}-row-error`;
  const row = state.size.row;
  const invalidFor = (msg: string | null, id: string) => msg !== null ? { "aria-invalid": true as const, "aria-describedby": id } : {};
  return <div className="stack" style={{ gap: "var(--s-2)" }}>
    <div className="row" style={{ flexWrap: "wrap", gap: "var(--s-3)" }}>
      <label className="auth-field">نوع برچسب<select value={layout} onChange={(e) => { state.setLayout(e.target.value as LabelLayout); onChange(); }}>
        <option value="roll">رول لیبل‌زن</option><option value="a4">برگه A4 (۳×۸)</option></select></label>
      {layout === "roll" ? <label className="auth-field" htmlFor={`${idPrefix}-preset`}>اندازهٔ لیبل
        <select id={`${idPrefix}-preset`} value={preset} onChange={(e) => { state.setPreset(e.target.value); onChange(); }}>
          {LABEL_PRESETS.map((p) => <option key={p.id} value={p.id}>{fa(p.width)} × {fa(p.height)} میلی‌متر{p.id === DEFAULT_PRESET ? " (پیش‌فرض)" : ""}</option>)}
          <option value="custom">اندازهٔ دلخواه…</option>
        </select></label> : null}
    </div>
    {layout === "roll" ? <label className="auth-field">چیدمان رول<select value={state.columns} onChange={(e) => { state.setColumns(e.target.value === "2" ? "2" : "1"); onChange(); }}>
      <option value="1">تک‌ستونی (یک لیبل در عرض رول)</option>
      <option value="2">دو ستون کنار هم — BIXOLON XD3-40t</option></select></label> : null}
    {row ? <fieldset className="stack" style={{ gap: "var(--s-2)", border: 0, padding: 0, margin: 0 }}>
      <legend className="small muted">هر صفحهٔ چاپ یک ردیف کامل است؛ این دو اندازه را با خط‌کش از روی خودِ رول بخوانید (پیش‌فرض نداریم).</legend>
      <div className="row" style={{ flexWrap: "wrap", gap: "var(--s-3)" }}>
        <label className="auth-field">فاصلهٔ افقی میان دو لیبل (میلی‌متر)<input inputMode="decimal" value={state.gap} {...invalidFor(issues.row, rowId)} onChange={(e) => { state.setGap(e.target.value); onChange(); }} /></label>
        <label className="auth-field">پهنای کل کاغذ/لاینر (میلی‌متر)<input inputMode="decimal" value={state.media} {...invalidFor(issues.row, rowId)} onChange={(e) => { state.setMedia(e.target.value); onChange(); }} /></label>
        <label className="auth-field">جابه‌جایی افقی (میلی‌متر، + راست)<input inputMode="decimal" value={state.offset} onChange={(e) => { state.setOffset(e.target.value); onChange(); }} /></label>
        <label className="auth-field">شروع از<select value={state.startSlot} onChange={(e) => { state.setStartSlot(Number(e.target.value)); onChange(); }}>
          <option value={1}>ستون ۱ (چپ)</option><option value={2}>ستون ۲ (راست) — رول نیمه‌مصرف</option></select></label>
      </div>
      {issues.row === null ? <p className="small muted" style={{ margin: 0 }}>اندازهٔ کاغذ در پنجرهٔ چاپ: <Ltr>{`${row.mediaWidthMm}×${state.size.height} mm`}</Ltr> (کل ردیف)، مقیاس ۱۰۰٪، بدون Fit، سربرگ و پابرگ خاموش. لیبل‌ها از لبهٔ چپ کاغذ: <Ltr>{rowSlots(state.size.width, row).leftMm.map((l) => `${l} mm`).join(" · ")}</Ltr></p> : null}
      <CalibrationRow size={state.size} disabled={issues.row !== null || issues.width !== null || issues.height !== null} />
    </fieldset> : null}
    {layout === "roll" && preset === "custom" ? <div className="row" style={{ flexWrap: "wrap", gap: "var(--s-3)" }}>
      <label className="auth-field">عرض لیبل (میلی‌متر)<input inputMode="decimal" value={width} {...invalidFor(issues.width, widthId)} onChange={(e) => { state.setWidth(e.target.value); onChange(); }} /></label>
      <label className="auth-field">ارتفاع لیبل (میلی‌متر)<input inputMode="decimal" value={height} {...invalidFor(issues.height, heightId)} onChange={(e) => { state.setHeight(e.target.value); onChange(); }} /></label>
    </div> : null}
    {([[issues.width, widthId], [issues.height, heightId], [issues.row, rowId]] as const).map(([msg, id]) => msg === null ? null
      : <p key={id} id={id} className="small" role="status" style={{ margin: 0 }}><StatusBadge state="warning" label="اندازه نامعتبر" /> {msg}</p>)}
  </div>;
}

/**
 * یک ردیف کالیبراسیون (قاب خط‌چین و شمارهٔ ستون در هر خانه، بی کالا) — کم‌مصرف.
 * اگر قاب‌ها وسط لیبل‌های واقعی نیفتند، جابه‌جایی افقی یا اندازه‌ها را اصلاح کنید.
 * با هر تغییر هندسه پیش‌نمایش کهنه نمایش داده نمی‌شود.
 */
function CalibrationRow({ size, disabled }: { size: LabelSize; disabled: boolean }) {
  const pv = useLabelPreview();
  const body = labelCalibrationBody(size);
  const key = JSON.stringify(body);
  if (!body) return null;
  return <div className="stack" style={{ gap: "var(--s-2)" }}>
    <div><button className="btn" type="button" disabled={disabled || pv.busy} onClick={() => void pv.preview(body, key, "/labels/calibration")}>{pv.busy ? "…" : "پیش‌نمایش ردیف کالیبراسیون"}</button></div>
    {pv.error ? <p role="alert">{pv.error}</p> : null}
    {pv.html && pv.key === key ? <LabelPreviewFrame html={pv.html} /> : null}
  </div>;
}

/** «بدون قیمت»/«بدون بارکد» کنار تنوع — همان نشانهٔ وضعیت نظام طراحی (آیکون + برچسب). */
export function LabelContentBadges({ priced, hasBarcode }: { priced?: boolean | undefined; hasBarcode?: boolean | undefined }) {
  return <>
    {priced === false ? <StatusBadge state="warning" quiet label="بدون قیمت" /> : null}
    {hasBarcode === false ? <StatusBadge state="warning" quiet label="بدون بارکد" /> : null}
  </>;
}

/** پیش‌نمایش در iframe و چاپ — نسخهٔ قدیمی پیش‌نمایش با تغییر انتخاب باطل می‌شود. */
export function useLabelPreview() {
  const [html, setHtml] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function preview(body: object, forKey: string, path: "/labels" | "/labels/calibration" = "/labels") {
    if (busy) return;
    setBusy(true); setError(""); setHtml("");
    try { setHtml(await api.postHtml(path, body)); setKey(forKey); }
    catch (e) { setError(e instanceof ApiError ? e.message : "آماده‌سازی چاپ ممکن نشد."); }
    finally { setBusy(false); }
  }
  return { html, key, busy, error, preview, reset: () => setHtml("") };
}

export function LabelPreviewFrame({ html }: { html: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [readyHtml, setReadyHtml] = useState("");
  const [error, setError] = useState(false);
  function load() {
    try {
      const doc = frame.current?.contentDocument;
      if (!doc || doc.location.pathname !== "/api/labels/frame" || !doc.documentElement.hasAttribute("data-label-frame")) throw new Error("label_frame");
      // سند شبکه‌ای CSP چاپ را دارد. تعویض DOM سیاست آن را حفظ می‌کند؛
      // بدون srcdoc یا بازکردن دوبارهٔ سند با document.write.
      const parsed = new DOMParser().parseFromString(html, "text/html");
      doc.replaceChild(doc.importNode(parsed.documentElement, true), doc.documentElement);
      setError(false); setReadyHtml(html);
    } catch { setError(true); }
  }
  return <>
    <iframe key={html} ref={frame} title="پیش‌نمایش چاپ بارکد" src="/api/labels/frame" onLoad={load} onError={() => setError(true)} sandbox="allow-same-origin allow-modals" style={{ width: "100%", minHeight: 300, background: "white" }} />
    {error ? <p role="alert">بارگذاری پیش‌نمایش چاپ ممکن نشد. دوباره پیش‌نمایش بگیرید.</p> : null}
    <button className="btn btn--primary" type="button" disabled={readyHtml !== html || error} onClick={() => { frame.current?.contentWindow?.focus(); frame.current?.contentWindow?.print(); }}>چاپ لیبل بارکد</button>
  </>;
}

/** فهرست چاپ گروهی — چند کالا با تنوع‌ها و تعداد هر تنوع، در یک نوبت چاپ. */
export function LabelPrintQueue() {
  const items = useLabelQueue();
  const sizeState = useLabelSize();
  const pv = useLabelPreview();
  const total = queueTotal(items);
  const problem = labelRequestProblem(items, sizeState.size);
  const warning = labelContentWarning(items);
  const body = labelRequestBody(items, sizeState.size);
  const currentKey = JSON.stringify(body);
  if (items.length === 0) {
    return <section className="solid pad stack" aria-label="فهرست چاپ گروهی">
      <h3 style={{ margin: 0 }}>فهرست چاپ گروهی</h3>
      <p className="muted small" style={{ margin: 0 }}>خالی است. کالا را باز کنید، تعداد لیبل هر تنوع را بنویسید و «افزودن به فهرست چاپ گروهی» را بزنید؛ فهرست میان کالاها می‌ماند.</p>
    </section>;
  }
  return <section className="solid pad stack" aria-label="فهرست چاپ گروهی">
    <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
      <h3 style={{ margin: 0 }}>فهرست چاپ گروهی</h3>
      <span className="muted small">{fa(groupByProduct(items).length)} کالا، {fa(items.length)} تنوع، <strong>{fa(total)}</strong> لیبل از سقف {fa(MAX_TOTAL)}</span>
    </div>
    {/* فهرست، نه جدول: نام کالای بلند و شمارنده باید در ۳۲۰px هم بی‌اسکرول افقی بمانند. */}
    {groupByProduct(items).map((g) => <div key={g.productId} className="stack" style={{ gap: "var(--s-1)" }}>
      <strong style={{ overflowWrap: "anywhere" }}>{g.productName}</strong>
      <ul className="stack" style={{ gap: "var(--s-1)", listStyle: "none", margin: 0, padding: 0 }}>
        {g.items.map((i) => <li key={i.variationId} className="row" style={{ flexWrap: "wrap", alignItems: "center", gap: "var(--s-2)", minWidth: 0 }}>
          <span style={{ flex: "1 1 8rem", minWidth: 0, overflowWrap: "anywhere" }}>{[i.color ?? "بدون رنگ", i.size ?? "آزاد"].join(" / ")} · <Ltr>{i.sku}</Ltr> <LabelContentBadges priced={i.priced} hasBarcode={i.hasBarcode} /></span>
          <input aria-label={`تعداد لیبل ${i.sku}`} inputMode="numeric" style={{ width: "5em" }} value={String(i.count)}
            onChange={(e) => { labelQueue.setCount(i.variationId, Number(normalizeDigits(e.target.value)) || 0); pv.reset(); }} />
          <button type="button" className="btn btn--quiet" onClick={() => { labelQueue.setCount(i.variationId, 0); pv.reset(); }} aria-label={`حذف ${i.sku} از فهرست`}>حذف</button>
        </li>)}
      </ul>
    </div>)}
    <LabelSizeFields state={sizeState} onChange={pv.reset} idPrefix="queue" />
    <p className="muted small" style={{ margin: 0 }}>حداکثر {fa(MAX_PER_VARIANT)} لیبل از هر تنوع و {fa(MAX_TOTAL)} لیبل در هر نوبت. در پنجرهٔ چاپ مقیاس ۱۰۰٪ و اندازهٔ کاغذ برابر {sizeState.size.row ? "کل ردیف" : "لیبل"}؛ سربرگ و پابرگ خاموش.</p>
    {problem && problem !== labelSizeProblem(sizeState.size) ? <p className="small" role="status">{problem}</p> : null}
    {warning ? <p className="small" role="status"><StatusBadge state="warning" label="پیش از چاپ" /> {warning}</p> : null}
    <div className="row" style={{ gap: "var(--s-2)", flexWrap: "wrap" }}>
      <button className="btn btn--primary" type="button" disabled={problem !== null || pv.busy} onClick={() => void pv.preview(body, currentKey)}>{pv.busy ? "…" : `پیش‌نمایش ${fa(total)} لیبل`}</button>
      <button className="btn" type="button" disabled={pv.busy} onClick={() => { labelQueue.clear(); pv.reset(); }}>پاک‌کردن فهرست</button>
    </div>
    {pv.error ? <p role="alert">{pv.error}</p> : null}
    {pv.html && pv.key === currentKey ? <LabelPreviewFrame html={pv.html} /> : null}
  </section>;
}
