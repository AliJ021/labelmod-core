import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api.ts";
import type { Variation } from "../lib/catalog.ts";
import { normalizeDigits } from "../lib/settings-value.ts";

interface Cell { variationId: string; onHand: string; reserved: string }
interface Matrix { totalOnHand: string; cells: Record<string, Record<string, Cell>> }
export function ProductStockLabels({ productId, variations, selected }: {
  productId: string; variations: Variation[]; selected: string[];
}) {
  const [stock, setStock] = useState<Matrix | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [layout, setLayout] = useState("roll");
  const [count, setCount] = useState("1");
  const [width, setWidth] = useState("50");
  const [height, setHeight] = useState("30");
  const [html, setHtml] = useState("");
  const [busy, setBusy] = useState(false);
  const [previewKey, setPreviewKey] = useState("");
  const selectionKey = JSON.stringify([productId, selected, layout, count, width, height]);
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const c = new AbortController(); setStock(null);
    void api.get<Matrix>(`/products/${productId}/stock-matrix`, { signal: c.signal })
      .then((r) => { if (!c.signal.aborted) setStock(r); })
      .catch((e: unknown) => { if (!c.signal.aborted) setError(e instanceof ApiError ? e.message : "خواندن موجودی ممکن نشد."); });
    return () => c.abort();
  }, [productId, revision]);
  const cells = new Map(Object.values(stock?.cells ?? {}).flatMap(Object.values).map((c) => [c.variationId, c]));
  const normalizedNumber = (s: string) => Number(normalizeDigits(s));
  const n = normalizedNumber(count), w = normalizedNumber(width), h = normalizedNumber(height);
  const valid = selected.length > 0 && Number.isInteger(n) && n >= 1 && n <= 100 && n * selected.length <= 500 &&
    (layout === "a4" || (w >= 20 && w <= 120 && h >= 10 && h <= 120));
  async function preview() {
    if (busy || !valid) return; setBusy(true); setError(""); setHtml("");
    try { setHtml(await api.postHtml("/labels", { items: selected.map((variationId) => ({ variationId, count: n })), layout,
      ...(layout === "roll" ? { rollWidthMm: w, rollHeightMm: h } : {}) })); setPreviewKey(selectionKey); }
    catch (e) { setError(e instanceof ApiError ? e.message : "آماده‌سازی چاپ ممکن نشد."); }
    finally { setBusy(false); }
  }
  return <section className="solid pad stack" aria-label="موجودی و چاپ بارکد">
    <h3>موجودی محصول</h3>
    <p>جمع موجودی در انبارهای شعبه‌های مجاز: <strong>{stock?.totalOnHand ?? "در حال دریافت…"}</strong></p>
    <button className="btn" type="button" onClick={() => { setError(""); setRevision((v) => v + 1); }}>تازه‌سازی موجودی</button>
    <div className="grid-wrap"><table className="grid"><thead><tr><th>رنگ / سایز</th><th>موجودی</th><th>رزرو</th></tr></thead>
      <tbody>{variations.map((v) => <tr key={v.id}><td>{v.color ?? "بدون رنگ"} / {v.size ?? "آزاد"}</td>
        <td>{stock ? cells.get(v.id)?.onHand ?? "—" : "…"}</td><td>{stock ? cells.get(v.id)?.reserved ?? "—" : "…"}</td></tr>)}</tbody></table></div>
    <h3>چاپ لیبل بارکد</h3>
    <p>تنوع‌های موردنظر را در جدول تنوع‌ها انتخاب کنید. {selected.length} تنوع انتخاب شده است.</p>
    <label className="auth-field">نوع برچسب<select value={layout} onChange={(e) => { setLayout(e.target.value); setHtml(""); }}>
      <option value="roll">رول لیبل‌زن</option><option value="a4">برگه A4</option></select></label>
    <label className="auth-field">تعداد از هر تنوع<input inputMode="numeric" value={count} onChange={(e) => { setCount(e.target.value); setHtml(""); }} /></label>
    {layout === "roll" ? <div className="row"><label className="auth-field">عرض لیبل (میلی‌متر)<input inputMode="decimal" value={width} onChange={(e) => { setWidth(e.target.value); setHtml(""); }} /></label>
      <label className="auth-field">ارتفاع لیبل (میلی‌متر)<input inputMode="decimal" value={height} onChange={(e) => { setHeight(e.target.value); setHtml(""); }} /></label></div> : null}
    <p className="muted small">حداکثر ۵۰۰ لیبل در هر نوبت. در تنظیمات چاپ، مقیاس ۱۰۰٪ و اندازه کاغذ برابر لیبل انتخاب شود؛ سربرگ و پابرگ خاموش باشند.</p>
    <button className="btn btn--primary" type="button" disabled={!valid || busy} onClick={() => void preview()}>پیش‌نمایش لیبل‌های انتخاب‌شده</button>
    {error ? <p role="alert">{error}</p> : null}
    {html && previewKey === selectionKey ? <><iframe ref={frame} title="پیش‌نمایش چاپ بارکد" srcDoc={html} sandbox="allow-same-origin allow-modals" style={{ width: "100%", minHeight: 300, background: "white" }} />
      <button className="btn" type="button" onClick={() => { frame.current?.contentWindow?.focus(); frame.current?.contentWindow?.print(); }}>چاپ لیبل بارکد</button></> : null}
  </section>;
}
