import { useRef, useState } from "react";
import { api, ApiError } from "../lib/api.ts";
import { Ltr } from "./ui/Bidi.tsx";
import { normalizeDigits } from "../lib/settings-value.ts";
import {
  DEFAULT_PRESET, LABEL_PRESETS, MAX_PER_VARIANT, MAX_TOTAL, groupByProduct, labelRequestBody,
  labelRequestProblem, queueTotal, type LabelLayout, type LabelSize,
} from "../lib/label-print.ts";
import { labelQueue, useLabelQueue } from "../lib/label-queue.ts";

const fa = (n: number) => n.toLocaleString("fa-IR");

/** انتخاب اندازهٔ لیبل: اندازه‌های آماده، یا دلخواه، یا برگهٔ A4. */
export function useLabelSize() {
  const [layout, setLayout] = useState<LabelLayout>("roll");
  const [preset, setPreset] = useState(DEFAULT_PRESET);
  const [width, setWidth] = useState("50");
  const [height, setHeight] = useState("30");
  const chosen = LABEL_PRESETS.find((p) => p.id === preset);
  const size: LabelSize = {
    layout,
    width: chosen ? chosen.width : Number(normalizeDigits(width)),
    height: chosen ? chosen.height : Number(normalizeDigits(height)),
  };
  return { size, layout, setLayout, preset, setPreset, width, setWidth, height, setHeight };
}
export type LabelSizeState = ReturnType<typeof useLabelSize>;

export function LabelSizeFields({ state, onChange, idPrefix }: { state: LabelSizeState; onChange: () => void; idPrefix: string }) {
  const { layout, preset, width, height } = state;
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
    {layout === "roll" && preset === "custom" ? <div className="row" style={{ flexWrap: "wrap", gap: "var(--s-3)" }}>
      <label className="auth-field">عرض لیبل (میلی‌متر)<input inputMode="decimal" value={width} onChange={(e) => { state.setWidth(e.target.value); onChange(); }} /></label>
      <label className="auth-field">ارتفاع لیبل (میلی‌متر)<input inputMode="decimal" value={height} onChange={(e) => { state.setHeight(e.target.value); onChange(); }} /></label>
    </div> : null}
  </div>;
}

/** پیش‌نمایش در iframe و چاپ — نسخهٔ قدیمی پیش‌نمایش با تغییر انتخاب باطل می‌شود. */
export function useLabelPreview() {
  const [html, setHtml] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function preview(body: ReturnType<typeof labelRequestBody>, forKey: string) {
    if (busy) return;
    setBusy(true); setError(""); setHtml("");
    try { setHtml(await api.postHtml("/labels", body)); setKey(forKey); }
    catch (e) { setError(e instanceof ApiError ? e.message : "آماده‌سازی چاپ ممکن نشد."); }
    finally { setBusy(false); }
  }
  return { html, key, busy, error, preview, reset: () => setHtml("") };
}

export function LabelPreviewFrame({ html }: { html: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  return <>
    <iframe ref={frame} title="پیش‌نمایش چاپ بارکد" srcDoc={html} sandbox="allow-same-origin allow-modals" style={{ width: "100%", minHeight: 300, background: "white" }} />
    <button className="btn btn--primary" type="button" onClick={() => { frame.current?.contentWindow?.focus(); frame.current?.contentWindow?.print(); }}>چاپ لیبل بارکد</button>
  </>;
}

/** فهرست چاپ گروهی — چند کالا با تنوع‌ها و تعداد هر تنوع، در یک نوبت چاپ. */
export function LabelPrintQueue() {
  const items = useLabelQueue();
  const sizeState = useLabelSize();
  const pv = useLabelPreview();
  const total = queueTotal(items);
  const problem = labelRequestProblem(items, sizeState.size);
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
          <span style={{ flex: "1 1 8rem", minWidth: 0, overflowWrap: "anywhere" }}>{[i.color ?? "بدون رنگ", i.size ?? "آزاد"].join(" / ")} · <Ltr>{i.sku}</Ltr></span>
          <input aria-label={`تعداد لیبل ${i.sku}`} inputMode="numeric" style={{ width: "5em" }} value={String(i.count)}
            onChange={(e) => { labelQueue.setCount(i.variationId, Number(normalizeDigits(e.target.value)) || 0); pv.reset(); }} />
          <button type="button" className="btn btn--quiet" onClick={() => { labelQueue.setCount(i.variationId, 0); pv.reset(); }} aria-label={`حذف ${i.sku} از فهرست`}>حذف</button>
        </li>)}
      </ul>
    </div>)}
    <LabelSizeFields state={sizeState} onChange={pv.reset} idPrefix="queue" />
    <p className="muted small" style={{ margin: 0 }}>حداکثر {fa(MAX_PER_VARIANT)} لیبل از هر تنوع و {fa(MAX_TOTAL)} لیبل در هر نوبت. در پنجرهٔ چاپ مقیاس ۱۰۰٪ و اندازهٔ کاغذ برابر لیبل؛ سربرگ و پابرگ خاموش.</p>
    {problem ? <p className="small" role="status">{problem}</p> : null}
    <div className="row" style={{ gap: "var(--s-2)", flexWrap: "wrap" }}>
      <button className="btn btn--primary" type="button" disabled={problem !== null || pv.busy} onClick={() => void pv.preview(body, currentKey)}>{pv.busy ? "…" : `پیش‌نمایش ${fa(total)} لیبل`}</button>
      <button className="btn" type="button" disabled={pv.busy} onClick={() => { labelQueue.clear(); pv.reset(); }}>پاک‌کردن فهرست</button>
    </div>
    {pv.error ? <p role="alert">{pv.error}</p> : null}
    {pv.html && pv.key === currentKey ? <LabelPreviewFrame html={pv.html} /> : null}
  </section>;
}
