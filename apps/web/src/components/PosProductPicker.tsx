import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api.ts";
import { toman } from "../lib/money.ts";
import { normalizeSearch } from "../lib/navigation.ts";

interface Product { id: string; name: string; code: string; variationCount: number }
interface Variation { id: string; sku: string; barcode: string | null; color: string | null; size: string | null; price: string | null; available: string; status: string }

export function PosProductPicker({ warehouseId, busy, onPick }: {
  warehouseId: string; busy: boolean; onPick: (variationId: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [selected, setSelected] = useState<Product | null>(null);
  const [variations, setVariations] = useState<Variation[]>([]);
  const [color, setColor] = useState<string | null | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const selecting = useRef(false);
  const revision = useRef(0);
  useEffect(() => () => { revision.current++; }, [warehouseId]);
  async function submit() {
    const term = normalizeSearch(query);
    if (busy || selecting.current || term.length < 2) return;
    selecting.current = true;
    const requestRevision = revision.current;
    setError("");
    try {
      const result = await api.get<{ products: Product[]; exactVariationId: string | null }>(`/pos/products?q=${encodeURIComponent(term)}&warehouseId=${warehouseId}`);
      if (requestRevision !== revision.current) return;
      if (result.exactVariationId) { await onPick(result.exactVariationId); setQuery(""); setSelected(null); }
      else { setSelected(null); setProducts(result.products); }
    } catch (e) { if (requestRevision === revision.current) setError(e instanceof ApiError ? e.message : "ارتباط با سرور برقرار نشد."); }
    finally { selecting.current = false; }
  }
  useEffect(() => {
    const controller = new AbortController();
    setError(""); setProducts([]); setVariations([]); setColor(undefined);
    if (!selected && query.trim().length < 2) { setLoading(false); return () => controller.abort(); }
    setLoading(true);
    const timer = setTimeout(() => {
      const path = selected ? `/pos/products/${selected.id}/variations?warehouseId=${warehouseId}`
        : `/pos/products?q=${encodeURIComponent(normalizeSearch(query))}&warehouseId=${warehouseId}`;
      void api.get<{ products?: Product[]; variations?: Variation[] }>(path, { signal: controller.signal })
        .then((r) => { if (!controller.signal.aborted) { setProducts(r.products ?? []); setVariations(r.variations ?? []); } })
        .catch((e: unknown) => { if (!controller.signal.aborted) setError(e instanceof ApiError ? e.message : "ارتباط با سرور برقرار نشد."); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, selected ? 0 : 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, selected, warehouseId]);
  const colors = [...new Set(variations.map((v) => v.color))];
  const chosenColor = color === undefined && colors.length === 1 ? colors[0] : color;
  return <section className="solid pad stack product-entry" aria-label="افزودن کالا">
    <form className="row" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <label className="auth-field">نام، کد یا بارکد محصول
        <input type="search" value={query} maxLength={80} placeholder="بارکد را اسکن کنید یا نام محصول را بنویسید" disabled={busy} autoComplete="off"
          onChange={(e) => { revision.current++; setQuery(e.target.value); setSelected(null); }}
          onKeyDown={e => { if (e.nativeEvent.isComposing && e.key === "Enter") e.preventDefault(); }} />
      </label>
      <button type="submit" className="btn" disabled={busy || query.trim().length < 2}>جست‌وجو / افزودن</button>
    </form>
    {error ? <p role="alert">{error}</p> : null}
    {loading ? <p role="status">در حال جست‌وجو…</p> : null}
    {!selected && !loading && query.trim().length >= 2 && products.length === 0 && !error ? <p>محصولی پیدا نشد.</p> : null}
    {!selected && products.length === 50 ? <p>۵۰ نتیجهٔ نخست؛ برای محدودکردن نتایج، نام کامل‌تری وارد کنید.</p> : null}
    {!selected ? <div className="row" style={{ flexWrap: "wrap" }}>{products.map((p) => <button className="btn" type="button" key={p.id} disabled={busy}
      onClick={() => { revision.current++; setSelected(p); }}>{p.name} · {p.code} · {p.variationCount} تنوع</button>)}</div> : <>
      <div className="row"><strong>{selected.name}</strong><button type="button" className="btn" onClick={() => setSelected(null)}>بازگشت به محصولات</button></div>
      <div role="group" aria-label="انتخاب رنگ" className="row" style={{ flexWrap: "wrap" }}>{colors.map((c) => <button type="button" className="btn" key={c ?? ""}
        aria-pressed={chosenColor === c} disabled={busy} onClick={() => setColor(c)}>{c ?? "بدون رنگ"}</button>)}</div>
      {chosenColor === undefined && !loading ? <p>کدام رنگ؟</p> : null}
      <div role="group" aria-label="انتخاب سایز" className="row" style={{ flexWrap: "wrap" }}>{variations.filter((v) => v.color === chosenColor).map((v) => <button
        type="button" className="btn" key={v.id} disabled={busy || v.price === null || Number(v.available) <= 0}
        onClick={() => { if (selecting.current) return; selecting.current = true; void onPick(v.id).finally(() => { selecting.current = false; }); }}>
        سایز {v.size ?? "آزاد"} · موجودی {v.available} · {v.price === null ? "بدون قیمت" : `${toman(BigInt(v.price))} تومان`}
      </button>)}</div>
      <p className="muted small">با انتخاب سایز، یک عدد به سبد اضافه می‌شود. موجودی و قیمت هنگام ثبت دوباره کنترل می‌شوند.</p>
    </>}
  </section>;
}
