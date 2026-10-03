import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api.ts";
import type { Variation } from "../lib/catalog.ts";
import { normalizeDigits } from "../lib/settings-value.ts";
import { clampCount, labelRequestBody, labelRequestProblem, queueTotal } from "../lib/label-print.ts";
import { labelQueue } from "../lib/label-queue.ts";
import { LabelPreviewFrame, LabelSizeFields, useLabelPreview, useLabelSize } from "./LabelPrint.tsx";

interface Cell { variationId: string; onHand: string; reserved: string }
interface Matrix { totalOnHand: string; cells: Record<string, Record<string, Cell>> }

/**
 * موجودی محصول و تعداد لیبل هر تنوع.
 *
 * تیک جدول تنوع‌ها تعداد را ۱ می‌کند (و برداشتنش صفر)؛ تعداد هر تنوع را
 * می‌شود جدا نوشت یا «به‌اندازهٔ موجودی» پر کرد. چاپ همین کالا مستقیم
 * است؛ برای چند کالا با هم، تنوع‌ها به فهرست چاپ گروهی افزوده می‌شوند.
 * مقدار بارکد و قیمت را سرور از دیتابیس می‌خواند، نه از این صفحه.
 */
export function ProductStockLabels({ productId, productName, variations, selected }: {
  productId: string; productName: string; variations: Variation[]; selected: string[];
}) {
  const [stock, setStock] = useState<Matrix | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [added, setAdded] = useState("");
  const sizeState = useLabelSize();
  const pv = useLabelPreview();

  useEffect(() => {
    const c = new AbortController(); setStock(null);
    void api.get<Matrix>(`/products/${productId}/stock-matrix`, { signal: c.signal })
      .then((r) => { if (!c.signal.aborted) setStock(r); })
      .catch((e: unknown) => { if (!c.signal.aborted) setError(e instanceof ApiError ? e.message : "خواندن موجودی ممکن نشد."); });
    return () => c.abort();
  }, [productId, revision]);

  // تیک جدول تنوع‌ها: تازه‌انتخاب‌شده دست‌کم ۱، برداشته‌شده صفر — هنگام
  // رندر (الگوی «تنظیم state از تغییر prop»)، نه با Effect پس از نقاشی.
  const [lastSelected, setLastSelected] = useState<string[]>([]);
  if (lastSelected.join(",") !== selected.join(",")) {
    const next = { ...counts };
    for (const id of selected) if (!lastSelected.includes(id)) next[id] = Math.max(next[id] ?? 0, 1);
    for (const id of lastSelected) if (!selected.includes(id)) next[id] = 0;
    setCounts(next);
    setLastSelected(selected);
  }

  const cells = new Map(Object.values(stock?.cells ?? {}).flatMap(Object.values).map((c) => [c.variationId, c]));
  const chosen = variations.filter((v) => (counts[v.id] ?? 0) > 0).map((v) => ({ variationId: v.id, count: counts[v.id] ?? 0 }));
  const total = queueTotal(chosen);
  const problem = labelRequestProblem(chosen, sizeState.size);
  const body = labelRequestBody(chosen, sizeState.size);
  const currentKey = JSON.stringify([productId, body]);

  function setCount(id: string, raw: string) {
    setCounts((prev) => ({ ...prev, [id]: clampCount(Number(normalizeDigits(raw))) }));
    setAdded("");
  }
  function fill(fn: (v: Variation) => number) {
    setCounts(Object.fromEntries(variations.map((v) => [v.id, clampCount(fn(v))])));
    setAdded("");
  }
  function addToQueue() {
    labelQueue.add(variations.filter((v) => (counts[v.id] ?? 0) > 0).map((v) => ({
      variationId: v.id, productId, productName, sku: v.sku, color: v.color, size: v.size, count: counts[v.id] ?? 0,
    })));
    setAdded(`${total.toLocaleString("fa-IR")} لیبل از «${productName}» به فهرست چاپ گروهی افزوده شد.`);
  }

  return <section className="solid pad stack" aria-label="موجودی و چاپ بارکد">
    <h3>موجودی محصول</h3>
    <p>جمع موجودی در انبارهای شعبه‌های مجاز: <strong>{stock?.totalOnHand ?? "در حال دریافت…"}</strong></p>
    <button className="btn" type="button" onClick={() => { setError(""); setRevision((v) => v + 1); }}>تازه‌سازی موجودی</button>
    <h3>چاپ لیبل بارکد</h3>
    <p className="muted small" style={{ margin: 0 }}>تعداد لیبل هر تنوع را بنویسید یا تنوع را در جدول تنوع‌ها تیک بزنید. {chosen.length.toLocaleString("fa-IR")} تنوع و {total.toLocaleString("fa-IR")} لیبل انتخاب شده است.</p>
    <div className="row" style={{ gap: "var(--s-2)", flexWrap: "wrap" }}>
      <button className="btn" type="button" onClick={() => fill(() => 1)}>یکی از هر تنوع</button>
      <button className="btn" type="button" disabled={!stock} onClick={() => fill((v) => Number(cells.get(v.id)?.onHand ?? 0))}>به‌اندازهٔ موجودی</button>
      <button className="btn" type="button" onClick={() => fill(() => 0)}>صفر کردن همه</button>
    </div>
    <div className="grid-wrap"><table className="grid"><thead><tr><th>رنگ / سایز</th><th>موجودی</th><th>رزرو</th><th>تعداد لیبل</th></tr></thead>
      <tbody>{variations.map((v) => <tr key={v.id}><td>{v.color ?? "بدون رنگ"} / {v.size ?? "آزاد"}</td>
        <td>{stock ? cells.get(v.id)?.onHand ?? "—" : "…"}</td><td>{stock ? cells.get(v.id)?.reserved ?? "—" : "…"}</td>
        <td><input aria-label={`تعداد لیبل ${v.sku}`} inputMode="numeric" style={{ width: "5.5em" }} value={String(counts[v.id] ?? 0)} onChange={(e) => setCount(v.id, e.target.value)} /></td></tr>)}</tbody></table></div>
    <LabelSizeFields state={sizeState} onChange={pv.reset} idPrefix={`product-${productId}`} />
    <p className="muted small">حداکثر ۱۰۰ لیبل از هر تنوع و ۵۰۰ لیبل در هر نوبت. در تنظیمات چاپ، مقیاس ۱۰۰٪ و اندازه کاغذ برابر لیبل انتخاب شود؛ سربرگ و پابرگ خاموش باشند.</p>
    <div className="row" style={{ gap: "var(--s-2)", flexWrap: "wrap" }}>
      <button className="btn btn--primary" type="button" disabled={problem !== null || pv.busy} onClick={() => void pv.preview(body, currentKey)}>پیش‌نمایش لیبل‌های انتخاب‌شده</button>
      <button className="btn" type="button" disabled={chosen.length === 0} onClick={addToQueue}>افزودن به فهرست چاپ گروهی</button>
    </div>
    {added ? <p className="small" role="status">{added}</p> : null}
    {error || pv.error ? <p role="alert">{error || pv.error}</p> : null}
    {pv.html && pv.key === currentKey ? <LabelPreviewFrame html={pv.html} /> : null}
  </section>;
}
