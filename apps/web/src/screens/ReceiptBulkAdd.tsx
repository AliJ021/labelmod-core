/**
 * افزودن گروهی به رسید خرید: جست‌وجوی نام / کد / بارکد → انتخاب کالا → همه یا
 * بخشی از رنگ/سایزها با تعداد قابل ویرایش → یک درخواست «همه یا هیچ».
 *
 * اسکن تکی بارکد سر جایش می‌ماند (سریع‌ترین راه برای یک قلم)؛ این برای وقتی است
 * که محمولهٔ یک مدل در چند رنگ و سایز رسیده. قیمت خرید از فاکتور تأمین‌کننده
 * است و یک نرخ برای همهٔ قلم‌های انتخاب‌شده؛ نرخ دیگر یعنی یک افزودن دیگر.
 * هویت تنوع از سرور است و مرورگر شناسه‌ای نمی‌سازد.
 */
import { useState } from "react";
import { ApiError } from "../lib/api.ts";
import { ActionKeys, actionFor } from "../lib/action-key.ts";
import { rialFromTomanInput } from "../lib/money.ts";
import { purchasing, type Receipt, type ReceiptProductHit, type ReceiptVariation } from "../lib/purchasing.ts";
import { bulkLines, byColor, parseQty } from "../lib/receipt-bulk.ts";
import { formatCount } from "../lib/format.ts";
import { Ltr } from "../components/ui/Bidi.tsx";

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : "ارتباط با سرور برقرار نشد.";
}

export function ReceiptBulkAdd({ receiptId, disabled, runBulk }: {
  receiptId: string;
  disabled: boolean;
  /**
   * ارسال از راه والد: قفل مشترک (رسید تا پاسخ عوض یا ثبت نمی‌شود) و کنار گذاشتن
   * پاسخ کهنه. `false` یعنی پاسخ روی رسید جاری ننشست.
   */
  runBulk: (send: () => Promise<Receipt>, count: number) => Promise<boolean>;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ReceiptProductHit[] | null>(null);
  const [product, setProduct] = useState<ReceiptProductHit | null>(null);
  const [variations, setVariations] = useState<ReceiptVariation[]>([]);
  /** شناسهٔ تنوع → متن تعداد. Map یعنی هر تنوع حداکثر یک بار. */
  const [selection, setSelection] = useState<Map<string, string>>(new Map());
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keys] = useState(() => new ActionKeys());

  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await fn(); } catch (err) { setError(message(err)); } finally { setBusy(false); }
  }

  const search = () => run(async () => {
    const term = q.trim();
    if (term.length < 2) { setError("دست‌کم دو نویسه از نام، کد یا بارکد بنویسید."); return; }
    setProduct(null);
    setSelection(new Map());
    const r = await purchasing.searchProducts(receiptId, term);
    setHits(r.products);
    // بارکد یا SKU دقیق: همان کالا (با شناسهٔ صریح سرور، نه «اولین سطر») باز و
    // همان تنوع انتخاب می‌شود.
    const exact = r.exactProductId === null ? undefined : r.products.find(p => p.id === r.exactProductId);
    const only = exact ?? (r.products.length === 1 ? r.products[0] : undefined);
    if (only) await choose(only, r.exactVariationId);
  });

  async function choose(p: ReceiptProductHit, preselect: string | null = null) {
    const r = await purchasing.productVariations(receiptId, p.id);
    setProduct(p);
    setVariations(r.variations);
    setSelection(preselect && r.variations.some(v => v.id === preselect) ? new Map([[preselect, "1"]]) : new Map());
  }

  const toggle = (ids: readonly string[], on: boolean) => setSelection(prev => {
    const next = new Map(prev);
    for (const id of ids) { if (on) { if (!next.has(id)) next.set(id, "1"); } else next.delete(id); }
    return next;
  });

  const add = () => run(async () => {
    const built = bulkLines(selection, rialFromTomanInput(price));
    if (!built.ok) {
      setError(built.reason === "empty" ? "دست‌کم یک رنگ/سایز را انتخاب کنید."
        : built.reason === "price" ? "قیمت خرید معتبر نیست."
        : `تعداد ${formatCount(built.invalid.length)} قلم معتبر نیست (عدد بزرگ‌تر از صفر، حداکثر سه رقم اعشار).`);
      return;
    }
    const action = actionFor(`bulk:${receiptId}`, built.lines);
    const applied = await runBulk(
      () => keys.run(action, key => purchasing.addLines(receiptId, built.lines, { idempotencyKey: key })),
      built.lines.length);
    if (applied) setSelection(new Map());
  });

  const all = variations.map(v => v.id);
  const count = selection.size;
  return <section className="rcpt-bulk stack" aria-labelledby={`${receiptId}-bulk`}>
    <h4 id={`${receiptId}-bulk`} className="rcpt-bulk-title">افزودن چند رنگ و سایز</h4>
    <form className="rcpt-add" role="search" onSubmit={e => { e.preventDefault(); void search(); }}>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="نام، کد یا بارکد کالا" aria-label="جست‌وجوی کالا با نام، کد یا بارکد" autoComplete="off" />
      <button type="submit" className="btn" disabled={busy || disabled}>جست‌وجو</button>
    </form>
    {error ? <p className="field-error" role="alert">{error}</p> : null}
    {hits !== null && hits.length === 0 ? <p className="muted small" role="status">کالای فعالی با این نام، کد یا بارکد پیدا نشد.</p> : null}
    {hits !== null && hits.length > 1 && !product ? <ul className="rcpt-bulk-hits" aria-label="کالاهای پیدا‌شده">
      {hits.map(h => <li key={h.id}><button type="button" className="btn btn--quiet" disabled={busy} onClick={() => void run(() => choose(h))}>
        {h.name} · <Ltr>{h.code}</Ltr> · {formatCount(h.variationCount)} تنوع
      </button></li>)}
    </ul> : null}
    {product ? <fieldset className="rcpt-bulk-pick" disabled={busy || disabled}>
      <legend>{product.name} · <Ltr>{product.code}</Ltr></legend>
      <div className="rcpt-bulk-tools">
        <button type="button" className="btn btn--quiet" onClick={() => toggle(all, true)}>انتخاب همه</button>
        <button type="button" className="btn btn--quiet" onClick={() => toggle(all, false)}>هیچ‌کدام</button>
        {hits && hits.length > 1 ? <button type="button" className="btn btn--quiet" onClick={() => { setProduct(null); setSelection(new Map()); }}>کالای دیگر</button> : null}
      </div>
      {byColor(variations).map(g => {
        const ids = g.items.map(v => v.id);
        const allOn = ids.every(id => selection.has(id));
        return <div key={g.color} className="rcpt-bulk-color">
          <label className="rcpt-bulk-colorname">
            <input type="checkbox" checked={allOn} onChange={e => toggle(ids, e.target.checked)} />
            <span>{g.color} — همهٔ سایزها</span>
          </label>
          <ul className="rcpt-bulk-sizes">
            {g.items.map(v => {
              const on = selection.has(v.id);
              const raw = selection.get(v.id) ?? "";
              const bad = on && parseQty(raw) === null;
              return <li key={v.id} className={on ? "is-on" : undefined}>
                <label>
                  <input type="checkbox" checked={on} onChange={e => toggle([v.id], e.target.checked)} />
                  <span>{v.size ?? "تک‌سایز"}</span>
                </label>
                <input className="rcpt-bulk-qty" inputMode="decimal" value={on ? raw : ""} disabled={!on}
                  aria-label={`تعداد ${g.color} ${v.size ?? "تک‌سایز"}`} aria-invalid={bad || undefined}
                  onChange={e => { const val = e.target.value; setSelection(prev => new Map(prev).set(v.id, val)); }} />
              </li>;
            })}
          </ul>
        </div>;
      })}
      <div className="rcpt-add">
        <input value={price} onChange={e => setPrice(e.target.value)} inputMode="numeric" placeholder="قیمت خرید (تومان)" aria-label="قیمت خرید هر عدد به تومان، برای همهٔ انتخاب‌شده‌ها" />
        <button type="button" className="btn btn--primary" onClick={() => void add()} disabled={count === 0}>
          {count === 0 ? "افزودن" : `افزودن ${formatCount(count)} قلم`}
        </button>
      </div>
      <p className="muted small">یک نرخ برای همهٔ قلم‌های انتخاب‌شده؛ اگر همان کالا با همان قیمت در رسید باشد، تعداد به همان سطر اضافه می‌شود. همه با هم ثبت می‌شوند یا هیچ‌کدام.</p>
    </fieldset> : null}
  </section>;
}
