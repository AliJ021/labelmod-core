import { AmountInput } from "../components/ui/AmountInput.tsx";
import { useUrlState, useUrlFlag } from "../lib/use-url-state.ts";
/**
 * کالا و قیمت — تعریف مدل، ساخت تنوع‌ها، و تغییر قیمت.
 *
 * ناحیه «متوسط» ADR-002: کارت گروه شیشه‌ای، ولی هر فرم و هر عددی که
 * خوانده یا تایپ می‌شود مات. مثل انبار — کار طولانی است، ولی زیر فشار
 * صف نیست.
 *
 * ── سه چیزی که این صفحه عمداً انجام نمی‌دهد ─────────────────────────
 *
 * **قیمت را حساب نمی‌کند.** هیچ درصدی، هیچ «۲۰٪ تخفیف روی همه». مبلغ
 * دقیق تایپ می‌شود و همان به سرور می‌رود. یک ماشین‌حساب در مرورگر
 * یعنی رقمی که کاربر می‌بیند با رقمی که ثبت می‌شود گرد کردنِ متفاوت
 * داشته باشد.
 *
 * **مجوز را حدس نمی‌زند.** دکمه تغییر قیمت برای همه دیده می‌شود و اگر
 * کاربر `price.change` نداشته باشد، سرور ۴۰۳ با پیام فارسی می‌دهد و
 * همان نشان داده می‌شود. یک `if` روی نام نقش اینجا، همان چیزی است که
 * `.claude/rules/api.md` ممنوع کرده.
 *
 * **قیمت قبلی را پاک نمی‌کند.** تاریخچه از سرور می‌آید و فقط نمایش
 * داده می‌شود. دیتابیس هم اجازه پاک‌کردنش را نمی‌دهد (مهاجرت ۰۳۲).
 *
 * ── ورودی عددی ──────────────────────────────────────────────────────
 *
 * `type="text"` است نه `type="number"` — صفحه‌کلید فارسی «۴۸» می‌فرستد
 * و ورودی عددی مرورگر آن را دور می‌اندازد. `rialFromTomanInput` رقم
 * فارسی و عربی و جداکننده هزارگان را می‌فهمد.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Glass, Solid } from "../components/Glass.tsx";
import { SearchField } from "../components/SearchField.tsx";
import { ProductStockLabels } from "../components/ProductStockLabels.tsx";
import { LabelPrintQueue } from "../components/LabelPrint.tsx";
import { labelQueue } from "../lib/label-queue.ts";
import { clampCount, queueAddMessage, queueItemsForProduct, type QueueItem } from "../lib/label-print.ts";
import { normalizeDigits } from "../lib/settings-value.ts";
import { ResultState } from "../components/ResultState.tsx";
import { useLatestQuery } from "../lib/use-latest-query.ts";
import { ApiError } from "../lib/api.ts";
import { ActionKeys, actionFor } from "../lib/action-key.ts";
import { rialFromTomanInput, toman } from "../lib/money.ts";
import { pos } from "../lib/pos.ts";
import { Money } from "../components/ui/Money.tsx";
import { StatusBadge } from "../components/ui/Status.tsx";
import { formatCount } from "../lib/format.ts";
import {
  catalog,
  priceSummary,
  splitList,
  type PriceHistoryEntry,
  type PriceKind,
  type Product,
  type Variation,
} from "../lib/catalog.ts";

const PRICE_KIND: Record<string, string> = {
  regular: "عادی",
  markdown: "حراج",
  promo: "کمپین",
};

const VARIATION_STATUS: Record<string, string> = {
  active: "فعال",
  paused: "متوقف",
  preorder: "پیش‌سفارش",
  archived: "بایگانی",
};

function message(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "ارتباط با سرور برقرار نشد.";
}

function shortDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("fa-IR", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

export function Catalog() {
  const [search, setSearch] = useUrlState("catalog.search", "", true);
  const [showArchived, setShowArchived] = useUrlFlag("catalog.archived");
  const [selectedId, setSelectedId] = useUrlState("catalog.product");
  const selected = selectedId || null;
  const setSelected = (id: string | null) => setSelectedId(id ?? "");
  const [labels, setLabels] = useUrlState("catalog.labels");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revision, setRevision] = useState(0);
  const [delay, setDelay] = useState(0);
  const load = useCallback(async (signal: AbortSignal) => (await catalog.products({ search, status: showArchived ? "all" : "active" }, { signal })).products, [search, showArchived]);
  const query = useLatestQuery({ key: JSON.stringify([search, showArchived]), version: revision, load, delay, enabled: selected === null });
  const products = query.data ?? [];
  function reload() { setDelay(0); setRevision(v => v + 1); }
  // چاپ گروهی از همین فهرست: چند کالا را تیک بزنید، «از هر تنوع N لیبل»، و همه یک‌جا به
  // همان فهرست چاپ گروهی می‌روند — بی باز کردن صفحهٔ تک‌تک کالاها.
  // انتخاب با جست‌وجو پاک نمی‌شود (شناسه → نام): A را تیک بزنید، B را جست‌وجو و تیک بزنید، هر دو می‌روند.
  const [picked, setPicked] = useState<ReadonlyMap<string, string>>(new Map());
  const [perVariant, setPerVariant] = useState("1");
  const [adding, setAdding] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  function togglePicked(list: readonly Product[], on: boolean) {
    setPicked((prev) => {
      const next = new Map(prev);
      for (const p of list) { if (on) next.set(p.id, p.nameInternal); else next.delete(p.id); }
      return next;
    });
  }
  /**
   * همه یا هیچ: تنوع‌های همهٔ کالاهای انتخاب‌شده اول خوانده می‌شوند و فهرست فقط یک بار
   * عوض می‌شود. خطای یک کالا فهرست را دست‌نخورده و انتخاب را سر جایش می‌گذارد، پس تلاش
   * دوباره کالایی را دوبار نمی‌افزاید.
   */
  async function addPickedToQueue() {
    const ids = [...picked].map(([id, name]) => ({ id, name }));
    const count = clampCount(Number(normalizeDigits(perVariant)));
    if (ids.length === 0 || count === 0 || adding) return;
    setAdding(true); setError(null); setNote(null);
    try {
      const items: QueueItem[] = [];
      for (const p of ids) items.push(...queueItemsForProduct(p, (await catalog.product(p.id)).variations, count));
      if (!alive.current) return;
      const r = labelQueue.add(items);
      // فقط همان‌هایی که فرستاده شدند؛ تیکی که در حین خواندن زده شد می‌ماند.
      setPicked((prev) => { const next = new Map(prev); for (const p of ids) next.delete(p.id); return next; });
      setNote(queueAddMessage(r.added, r.requested, `${ids.length.toLocaleString("fa-IR")} کالا`));
    } catch (e) {
      if (!alive.current) return;
      setError(`${e instanceof ApiError ? e.message : "خواندن تنوع‌ها ممکن نشد."} چیزی به فهرست چاپ افزوده نشد و انتخاب‌ها سر جایشان هستند؛ دوباره تلاش کنید.`);
    } finally { if (alive.current) setAdding(false); }
  }
  function changeSearch(value: string) { setSearch(value); setDelay(value === "" ? 0 : 250); }

  if (selected !== null) {
    return (
      <ProductDetail
        productId={selected}
        labelMode={labels === "1"}
        initialNote={note}
        onBack={() => {
          setNote(null);
          setSelected(null);
          reload();
        }}
      />
    );
  }

  return (
    <div className="stack catalog-page">
      <Glass as="section" className="pad">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ fontSize: "1rem", margin: 0 }}>{labels === "1" ? "چاپ لیبل بارکد" : "کالا و قیمت"}</h2>
          <button className="btn" type="button" onClick={() => setLabels(labels === "1" ? "" : "1")}>{labels === "1" ? "فهرست کالا و قیمت" : "چاپ لیبل بارکد"}</button>
          <button type="button" className="btn" onClick={() => setCreating((v) => !v)}>
            {creating ? "انصراف" : "کالای تازه"}
          </button>
        </div>

        <div className="catalog-toolbar">
          <SearchField label="جست‌وجوی کد یا نام کالا" value={search} onChange={changeSearch} onSearch={reload} onClear={reload} />
          <label className="filter-check">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => { setShowArchived(e.target.checked); setDelay(0); }}
            />
            <span>بایگانی‌شده‌ها هم</span>
          </label>
        </div>
      </Glass>
      {labels === "1" ? <LabelPrintQueue /> : null}

      {creating ? (
        <ProductForm
          onDone={(id, code) => {
            setCreating(false);
            setNote(`کالا با کد ${code} ساخته شد. حالا تنوع‌هایش را بسازید.`);
            setSelected(id);
          }}
          onError={setError}
        />
      ) : null}

      {error !== null ? (
        <p className="solid pos-alert" role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> {error}
        </p>
      ) : null}
      {note !== null ? (
        <p className="solid pos-alert" role="status">
          <span className="dot dot--good" aria-hidden="true">●</span> {note}
        </p>
      ) : null}

      <div aria-busy={query.loading}>
      <Solid className="pad">
        {query.loading ? (
          <ResultState kind="loading" title="در حال جست‌وجوی کالاها…" />
        ) : query.error ? (
          <ResultState kind="error" title={message(query.error)} actionLabel="تلاش دوباره" onAction={reload} />
        ) : products.length === 0 ? (
          <ResultState title={search ? "برای این جست‌وجو کالایی پیدا نشد." : "کالایی برای نمایش در این فهرست نیست."} description={search ? "کد یا نام دیگری را امتحان کنید." : "با افزودن کالا، تعریف تنوع‌ها و قیمت‌گذاری را شروع کنید."} actionLabel={search ? "پاک‌کردن جست‌وجو" : "افزودن کالا"} onAction={() => { if (search) { changeSearch(""); reload(); } else setCreating(true); }} />
        ) : (
          <>
          {labels === "1" ? <div className="row" style={{ gap: "var(--s-2)", flexWrap: "wrap", alignItems: "end", marginBottom: "var(--s-3)" }}>
            <label className="auth-field">از هر تنوع (لیبل)<input inputMode="numeric" style={{ width: "5em" }} value={perVariant} onChange={(e) => setPerVariant(e.target.value)} /></label>
            <button type="button" className="btn btn--primary" disabled={picked.size === 0 || adding || clampCount(Number(normalizeDigits(perVariant))) === 0}
              onClick={() => void addPickedToQueue()}>{adding ? "در حال افزودن به فهرست چاپ…" : `افزودن ${picked.size.toLocaleString("fa-IR")} کالای انتخاب‌شده به فهرست چاپ`}</button>
            {picked.size > 0 ? <button type="button" className="btn" disabled={adding} onClick={() => setPicked(new Map())}>پاک‌کردن انتخاب</button> : null}
          </div> : null}
          <table className="grid">
            <thead>
              <tr>
                {labels === "1" ? <th><input type="checkbox" aria-label="انتخاب همهٔ کالاهای این فهرست" checked={products.length > 0 && products.every((p) => picked.has(p.id))}
                  onChange={(e) => togglePicked(products, e.target.checked)} /></th> : null}
                <th>کد</th>
                <th>نام</th>
                <th>برند</th>
                <th>تنوع</th>
                <th>قیمت فروش</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id}>
                  {labels === "1" ? <td><input type="checkbox" aria-label={`انتخاب ${p.nameInternal} برای چاپ گروهی`} checked={picked.has(p.id)}
                    onChange={(e) => togglePicked([p], e.target.checked)} /></td> : null}
                  <td>{p.code}</td>
                  <td>
                    {p.nameInternal}
                    {p.status === "archived" ? (
                      <span className="muted"> — بایگانی</span>
                    ) : null}
                  </td>
                  <td>{p.brandName ?? "—"}</td>
                  <td className="num">{p.variationCount}</td>
                  <td>
                    <ProductPrice product={p} />
                  </td>
                  <td>
                    {/* تا پایان افزودن گروهی، صفحهٔ کالا باز نمی‌شود؛ وگرنه نتیجه بی‌پیام در پس‌زمینه ثبت می‌شد. */}
                    <button type="button" className="btn" disabled={adding} onClick={() => setSelected(p.id)}>
                      {labels === "1" ? "انتخاب تنوع و چاپ لیبل" : "باز کردن"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </>
        )}
      </Solid>
      </div>
    </div>
  );
}

// ── قیمت فروش در فهرست ───────────────────────────────────────────────

/**
 * قیمت جاری کالا — همان قیمتی که صندوق برای تنوع فعال می‌خواند.
 *
 * برابر ← یک مبلغ؛ متفاوت ← بازه؛ بی‌قیمت ← «بدون قیمت» با هشدار، هرگز
 * صفر. تنوع فروختنیِ بی‌قیمت زیر مبلغ جدا گفته می‌شود: بی‌آن، مبلغ
 * کامل به نظر می‌رسید و سایزی که صندوق رد می‌کند پنهان می‌ماند.
 */
function ProductPrice({ product }: { product: Product }) {
  const summary = priceSummary(product);
  if (summary.kind === "none") {
    return <span className="muted">تنوع فعال ندارد</span>;
  }
  if (summary.kind === "unpriced") {
    return <StatusBadge state="warning" label="بدون قیمت" />;
  }
  return (
    <span className="catalog-price">
      {summary.kind === "single" ? (
        <Money rial={summary.rial} exact />
      ) : (
        <span className="catalog-price-range">
          <Money rial={summary.min} unit={false} exact /> <span className="muted">تا</span>{" "}
          <Money rial={summary.max} exact />
        </span>
      )}
      {summary.missing > 0 ? (
        <StatusBadge state="warning" quiet label={`${formatCount(summary.missing)} تنوع بی‌قیمت`} />
      ) : null}
    </span>
  );
}

// ── فرم ساخت کالا ────────────────────────────────────────────────────

function ProductForm({
  onDone,
  onError,
}: {
  onDone: (id: string, code: string) => void;
  onError: (msg: string) => void;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [nameWeb, setNameWeb] = useState("");
  const [fit, setFit] = useState("");
  const [season, setSeason] = useState("");
  /** فهرست فصل‌ها از سرور — این کامپوننت هیچ فصلی را نمی‌شناسد. */
  const [seasons, setSeasons] = useState<
    Array<{ code: string; label: string; climate: string }>
  >([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await pos.seasons();
        if (alive) setSeasons(r.seasons);
      } catch {
        // فهرست فصل نیامد؟ انتخاب‌گر خالی می‌ماند و «بدون فصل»
        // انتخاب می‌شود. ساخت کالا نباید به‌خاطر یک میدان اختیاری
        // متوقف شود.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  /**
   * کلید Idempotency داخل کامپوننت، نه در سطح ماژول — مثل بقیه
   * صفحات. کلیدی که در سطح ماژول بنشیند، پس از خروج و ورودِ کاربرِ
   * دیگر هم زنده می‌ماند و «کالای تکراری» را به‌جای ساخت، Replay
   * می‌کند.
   */
  const [keys] = useState(() => new ActionKeys());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return; // دو بار زدن دکمه، دو کالا نمی‌سازد
    setBusy(true);
    const action = actionFor("product.create", { code, name });
    try {
      const r = await catalog.createProduct(
        {
          // خالی = کد خودکار یکتا از سرور؛ مرورگر هیچ کدی حدس نمی‌زند.
          ...(code.trim() === "" ? {} : { code: code.trim() }),
          nameInternal: name.trim(),
          ...(nameWeb.trim() === "" ? {} : { nameWeb: nameWeb.trim() }),
          ...(fit.trim() === "" ? {} : { fit: fit.trim() }),
          ...(season.trim() === "" ? {} : { season: season.trim() }),
        },
        { idempotencyKey: keys.keyFor(action) },
      );
      keys.clear(action);
      onDone(r.id, r.code);
    } catch (err) {
      onError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Solid className="pad" as="section">
      <form onSubmit={submit} className="stack">
        <label>
          <span>کد کالا — اختیاری</span>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="خالی = خودکار، مثل LM00042"
            autoComplete="off"
          />
          <small className="muted">
            خالی بگذارید تا سیستم یک کد یکتا بسازد؛ یا کد خودتان را با حروف لاتین، رقم و خط تیره بنویسید.
            روی SKU می‌نشیند و پس از ساخت عوض نمی‌شود؛ بارکد کالاهای قبلی تغییر نمی‌کند.
          </small>
        </label>
        <label>
          <span>نام کالا</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="شلوار پارچه‌ای رگولار کمر ایتالیایی"
            required
          />
        </label>
        <label>
          <span>عنوان سایت — اختیاری</span>
          <input
            type="text"
            value={nameWeb}
            onChange={(e) => setNameWeb(e.target.value)}
          />
        </label>
        <div className="row" style={{ gap: ".5rem" }}>
          <label style={{ flex: 1 }}>
            <span>فرم — اختیاری</span>
            <input
              type="text"
              value={fit}
              onChange={(e) => setFit(e.target.value)}
              placeholder="رگولار"
            />
          </label>
          {/*
            فصل یک **انتخاب** است، نه متن آزاد.

            تا پیش از این، «پاییز»، «پاييز» (با ی عربی) و «Autumn» سه
            فصل متفاوت می‌شدند و فیلتر انبار هیچ‌کدام را کامل
            نمی‌گرفت. حالا فهرست از `GET /seasons` می‌آید — افزودن
            فصل تازه یک `INSERT` در Seed است، نه یک خط اینجا.
          */}
          <label style={{ flex: 1 }}>
            <span>فصل — اختیاری</span>
            <select
              className="set-input"
              value={season}
              onChange={(e) => setSeason(e.target.value)}
            >
              <option value="">بدون فصل</option>
              {seasons.map((x) => (
                <option key={x.code} value={x.code}>
                  {x.label} ({x.climate === "warm" ? "گرم" : x.climate === "cold" ? "سرد" : "چهارفصل"})
                </option>
              ))}
            </select>
          </label>
        </div>
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? "در حال ثبت…" : "ساخت کالا"}
        </button>
      </form>
    </Solid>
  );
}

// ── جزئیات کالا ──────────────────────────────────────────────────────

function ProductDetail({
  labelMode,
  productId,
  onBack,
  initialNote = null,
}: {
  productId: string;
  labelMode: boolean;
  onBack: () => void;
  /** پیام ساخت کالا (با کد نهایی سرور) — پیش از این تنظیم می‌شد ولی صفحهٔ جزئیات آن را نشان نمی‌داد. */
  initialNote?: string | null;
}) {
  const [statusBusy, setStatusBusy] = useState(false);
  const [product, setProduct] = useState<Product | null>(null);
  useEffect(() => {
    if (labelMode && product) document.getElementById("product-labels")?.scrollIntoView({block:"start",behavior:"instant"});
  }, [labelMode, product]);
  const [variations, setVariations] = useState<Variation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(initialNote);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [historyOf, setHistoryOf] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await catalog.product(productId);
      setProduct(r.product);
      setVariations(r.variations);
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (product === null) {
    return (
      <Solid className="pad">
        {error !== null ? (
          <p className="pos-alert" role="alert">
            <span className="dot dot--crit" aria-hidden="true">●</span> {error}
          </p>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            در حال بارگذاری…
          </p>
        )}
        <button type="button" className="btn" onClick={onBack} style={{ marginTop: ".75rem" }}>
          بازگشت
        </button>
      </Solid>
    );
  }

  return (
    <div className="stack catalog-detail">
      <Glass as="section" className="pad">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h2 style={{ fontSize: "1rem", margin: 0 }}>{product.nameInternal}</h2>
            <p className="muted" style={{ margin: ".25rem 0 0" }}>
              {product.code}
              {product.status === "archived" ? " — بایگانی‌شده" : ""}
            </p>
          </div>
          <button type="button" className="btn" onClick={onBack}>
            بازگشت به فهرست
          </button>
        </div>
      </Glass>

      {error !== null ? (
        <p className="solid pos-alert" role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> {error}
        </p>
      ) : null}
      {note !== null ? (
        <p className="solid pos-alert" role="status">
          <span className="dot dot--good" aria-hidden="true">●</span> {note}
        </p>
      ) : null}

      <VariationBuilder
        productId={productId}
        onDone={(msg) => {
          setNote(msg);
          void load();
        }}
        onError={setError}
      />

      <Solid className="pad" as="section">
        <h3 style={{ fontSize: ".95rem", marginTop: 0 }}>تنوع‌ها</h3>
        {variations.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            هنوز تنوعی ساخته نشده. تا تنوع نباشد، نه بارکدی هست نه قیمتی.
          </p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th />
                <th>SKU</th>
                <th>رنگ</th>
                <th>سایز</th>
                <th>بارکد</th>
                <th>قیمت (تومان)</th>
                <th>وضعیت</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {variations.map((v) => (
                <tr key={v.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={picked.has(v.id)}
                      onChange={() => toggle(v.id)}
                      aria-label={`انتخاب ${v.sku}`}
                    />
                  </td>
                  <td>{v.sku}</td>
                  <td>{v.color ?? "—"}</td>
                  <td>{v.size ?? "—"}</td>
                  <td className="num">{v.barcode ?? "—"}</td>
                  <td>
                    {v.price === null ? (
                      <span>
                        <span className="dot dot--warn" aria-hidden="true">●</span>{" "}
                        بدون قیمت
                      </span>
                    ) : (
                      <>
                        <span className="num">{toman(BigInt(v.price))}</span>
                        {v.priceKind !== null && v.priceKind !== "regular" ? (
                          <span className="muted"> ({PRICE_KIND[v.priceKind]})</span>
                        ) : null}
                      </>
                    )}
                  </td>
                  <td>{VARIATION_STATUS[v.status] ?? v.status}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn--quiet"
                      onClick={() => setHistoryOf(historyOf === v.id ? null : v.id)}
                    >
                      {historyOf === v.id ? "بستن تاریخچه" : "تاریخچه قیمت"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Solid>

      <div id="product-labels"><ProductStockLabels key={productId} productId={productId} productName={product?.nameInternal ?? ""} variations={variations} selected={[...picked]} />{labelMode ? <LabelPrintQueue /> : null}</div>
      {historyOf !== null ? <PriceHistory variationId={historyOf} /> : null}

      <PricePanel
        picked={[...picked]}
        variations={variations}
        onDone={(msg) => {
          setNote(msg);
          setPicked(new Set());
          void load();
        }}
        onError={setError}
      />

      <Solid className="pad" as="section">
        <h3 style={{ fontSize: ".95rem", marginTop: 0 }}>وضعیت کالا</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          بایگانی، تنوع‌های فعال را هم می‌بندد تا از راه اسکن بارکد وارد سبد
          نشوند. کالا حذف نمی‌شود — فاکتورهای قبلی به همین سطر ارجاع می‌دهند.
        </p>
        <button
          type="button"
          className="btn"
          disabled={statusBusy}
          aria-busy={statusBusy}
          onClick={async () => {
            if (statusBusy) return;
            setStatusBusy(true);
            const next = product.status === "archived" ? "active" : "archived";
            try {
              await catalog.setProductStatus(productId, next);
              setNote(next === "archived" ? "کالا بایگانی شد." : "کالا فعال شد.");
              await load();
            } catch (err) {
              setError(message(err));
            } finally { setStatusBusy(false); }
          }}
        >
          {statusBusy ? "در حال ثبت…" : product.status === "archived" ? "فعال‌کردن کالا" : "بایگانی‌کردن کالا"}
        </button>
      </Solid>
    </div>
  );
}

// ── ساخت تنوع ────────────────────────────────────────────────────────

function VariationBuilder({
  productId,
  onDone,
  onError,
}: {
  productId: string;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [colors, setColors] = useState("");
  const [sizes, setSizes] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const r = await catalog.generateVariations(productId, {
        colors: splitList(colors),
        sizes: splitList(sizes),
      });
      onDone(
        `${r.createdCount} تنوع ساخته شد` +
          (r.skippedCount > 0 ? `، ${r.skippedCount} از قبل بود` : "") +
          ". قیمت هنوز ثبت نشده.",
      );
      setColors("");
      setSizes("");
    } catch (err) {
      onError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Solid className="pad" as="section">
      <h3 style={{ fontSize: ".95rem", marginTop: 0 }}>ساخت تنوع</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        رنگ‌ها و سایزها را با ویرگول جدا کنید. هر ترکیب یک کالای مستقل با
        بارکد خودش می‌شود. ترکیبی که از قبل باشد رد می‌شود، نه بازنویسی —
        پس دوباره‌زدن این دکمه بارکد چاپ‌شده را خراب نمی‌کند.
      </p>
      <form onSubmit={submit} className="stack">
        <label>
          <span>رنگ‌ها</span>
          <input
            type="text"
            value={colors}
            onChange={(e) => setColors(e.target.value)}
            placeholder="سبز لجنی، مشکی، سرمه‌ای"
          />
        </label>
        <label>
          <span>سایزها</span>
          <input
            type="text"
            value={sizes}
            onChange={(e) => setSizes(e.target.value)}
            placeholder="30، 32، 34"
          />
        </label>
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? "در حال ساخت…" : "ساخت ترکیب‌ها"}
        </button>
      </form>
    </Solid>
  );
}

// ── قیمت‌گذاری ───────────────────────────────────────────────────────

function PricePanel({
  picked,
  variations,
  onDone,
  onError,
}: {
  picked: string[];
  variations: Variation[];
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [raw, setRaw] = useState("");
  const [kind, setKind] = useState<PriceKind>("regular");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const rial = rialFromTomanInput(raw);
  const ready = picked.length > 0 && rial !== null && rial > 0n;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy || rial === null) return;
    setBusy(true);
    try {
      const r = await catalog.setPriceBulk({
        variationIds: picked,
        amount: rial.toString(),
        kind,
        ...(reason.trim() === "" ? {} : { reason: reason.trim() }),
      });
      onDone(`قیمت ${r.updated} تنوع ثبت شد. قیمت قبلی در تاریخچه ماند.`);
      setRaw("");
      setReason("");
    } catch (err) {
      onError(message(err));
    } finally {
      setBusy(false);
    }
  }

  const unpriced = variations.filter((v) => v.price === null).length;

  return (
    <Solid className="pad" as="section">
      <h3 style={{ fontSize: ".95rem", marginTop: 0 }}>تعیین قیمت</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        تنوع‌ها را از جدول بالا انتخاب کنید، مبلغ را به تومان بزنید. قیمت
        قبلی پاک نمی‌شود؛ بسته می‌شود و قیمت تازه از همین لحظه معتبر است.
        فاکتورهای قبلی تکان نمی‌خورند.
        {unpriced > 0 ? (
          <>
            {" "}
            <span>
              <span className="dot dot--warn" aria-hidden="true">●</span>{" "}
              {unpriced} تنوع هنوز قیمت ندارد و فروختنی نیست.
            </span>
          </>
        ) : null}
      </p>

      <form onSubmit={submit} className="stack">
        <div className="row" style={{ gap: ".5rem" }}>
          <label style={{ flex: 1 }}>
            <span>مبلغ (تومان)</span>
            {/*
              type="text" و نه number — صفحه‌کلید فارسی «۴۸» می‌فرستد و
              ورودی عددی مرورگر آن را دور می‌اندازد.
            */}
            <AmountInput
              type="text"
              inputMode="numeric"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder="۴۳۸٬۰۰۰"
            />
          </label>
          <label style={{ flex: 1 }}>
            <span>نوع</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as PriceKind)}>
              <option value="regular">عادی</option>
              <option value="markdown">حراج</option>
              <option value="promo">کمپین</option>
            </select>
          </label>
        </div>

        <label>
          <span>دلیل — اختیاری، ولی در تاریخچه می‌ماند</span>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="حراج پایان فصل"
          />
        </label>

        {rial !== null && rial > 0n ? (
          <p className="muted" style={{ margin: 0 }}>
            {picked.length} تنوع × {toman(rial)} تومان
          </p>
        ) : null}

        <button type="submit" className="btn btn--primary" disabled={!ready || busy}>
          {busy
            ? "در حال ثبت…"
            : picked.length === 0
              ? "اول تنوع را انتخاب کنید"
              : `ثبت قیمت برای ${picked.length} تنوع`}
        </button>
      </form>
    </Solid>
  );
}

// ── تاریخچه قیمت ─────────────────────────────────────────────────────

function PriceHistory({ variationId }: { variationId: string }) {
  const [rows, setRows] = useState<PriceHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await catalog.priceHistory(variationId);
        if (alive) setRows(r.history);
      } catch (err) {
        if (alive) setError(message(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [variationId]);

  return (
    <Solid className="pad" as="section">
      <h3 style={{ fontSize: ".95rem", marginTop: 0 }}>تاریخچه قیمت</h3>
      {error !== null ? (
        <p className="pos-alert" role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> {error}
        </p>
      ) : rows === null ? (
        <p className="muted" style={{ margin: 0 }}>
          در حال بارگذاری…
        </p>
      ) : rows.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          هنوز قیمتی ثبت نشده.
        </p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>مبلغ (تومان)</th>
              <th>نوع</th>
              <th>از</th>
              <th>تا</th>
              <th>دلیل</th>
              <th>توسط</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.validFrom}-${r.amount}`}>
                <td className="num">{toman(BigInt(r.amount))}</td>
                <td>{PRICE_KIND[r.kind] ?? r.kind}</td>
                <td>{shortDate(r.validFrom)}</td>
                <td>{r.validTo === null ? "جاری" : shortDate(r.validTo)}</td>
                <td>{r.reason ?? "—"}</td>
                <td>{r.byUser ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Solid>
  );
}
