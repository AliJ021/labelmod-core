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
import { useCallback, useEffect, useState } from "react";
import { Glass, Solid } from "../components/Glass.tsx";
import { ApiError } from "../lib/api.ts";
import { ActionKeys, actionFor } from "../lib/action-key.ts";
import { rialFromTomanInput, toman } from "../lib/money.ts";
import { pos } from "../lib/pos.ts";
import {
  catalog,
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
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    try {
      const r = await catalog.products({
        search,
        status: showArchived ? "all" : "active",
      });
      setProducts(r.products);
      setError(null);
    } catch (err) {
      setError(message(err));
    } finally {
      setLoading(false);
    }
  }, [search, showArchived]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (selected !== null) {
    return (
      <ProductDetail
        productId={selected}
        onBack={() => {
          setSelected(null);
          void reload();
        }}
      />
    );
  }

  return (
    <div className="stack">
      <Glass as="section" className="pad">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ fontSize: "1rem", margin: 0 }}>کالا و قیمت</h2>
          <button type="button" className="btn" onClick={() => setCreating((v) => !v)}>
            {creating ? "انصراف" : "کالای تازه"}
          </button>
        </div>

        <div className="row" style={{ gap: ".5rem", marginTop: ".75rem" }}>
          <input
            type="text"
            inputMode="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="جست‌وجوی کد یا نام کالا"
            style={{ flex: 1 }}
          />
          <label className="row" style={{ gap: ".35rem", alignItems: "center" }}>
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            <span>بایگانی‌شده‌ها هم</span>
          </label>
        </div>
      </Glass>

      {creating ? (
        <ProductForm
          onDone={(id) => {
            setCreating(false);
            setNote("کالا ساخته شد. حالا تنوع‌هایش را بسازید.");
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

      <Solid className="pad">
        {loading ? (
          <p className="muted" style={{ margin: 0 }}>
            در حال بارگذاری کالاها…
          </p>
        ) : products.length === 0 ? (
          <p className="empty">کالایی یافت نشد.</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>کد</th>
                <th>نام</th>
                <th>برند</th>
                <th>تنوع</th>
                <th>قیمت‌دار</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id}>
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
                    {/*
                      تنوع بدون قیمت فروختنی نیست — `addLine` خطا می‌دهد.
                      پس این ستون هشدار است، نه آمار.
                    */}
                    {p.pricedCount < p.variationCount ? (
                      <span>
                        <span className="dot dot--warn" aria-hidden="true">●</span>{" "}
                        <span className="num">{p.pricedCount}</span> از{" "}
                        <span className="num">{p.variationCount}</span>
                      </span>
                    ) : (
                      <span className="num">{p.pricedCount}</span>
                    )}
                  </td>
                  <td>
                    <button type="button" className="btn" onClick={() => setSelected(p.id)}>
                      باز کردن
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Solid>
    </div>
  );
}

// ── فرم ساخت کالا ────────────────────────────────────────────────────

function ProductForm({
  onDone,
  onError,
}: {
  onDone: (id: string) => void;
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
          code: code.trim(),
          nameInternal: name.trim(),
          ...(nameWeb.trim() === "" ? {} : { nameWeb: nameWeb.trim() }),
          ...(fit.trim() === "" ? {} : { fit: fit.trim() }),
          ...(season.trim() === "" ? {} : { season: season.trim() }),
        },
        { idempotencyKey: keys.keyFor(action) },
      );
      keys.clear(action);
      onDone(r.id);
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
          <span>کد کالا — حروف لاتین، رقم و خط تیره</span>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="TR-1405-01"
            required
          />
          <small className="muted">
            روی SKU و بارکد چاپ‌شده می‌نشیند و پس از ساخت عوض نمی‌شود.
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
  productId,
  onBack,
}: {
  productId: string;
  onBack: () => void;
}) {
  const [product, setProduct] = useState<Product | null>(null);
  const [variations, setVariations] = useState<Variation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
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
    <div className="stack">
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
          onClick={async () => {
            const next = product.status === "archived" ? "active" : "archived";
            try {
              await catalog.setProductStatus(productId, next);
              setNote(next === "archived" ? "کالا بایگانی شد." : "کالا فعال شد.");
              await load();
            } catch (err) {
              setError(message(err));
            }
          }}
        >
          {product.status === "archived" ? "فعال‌کردن کالا" : "بایگانی‌کردن کالا"}
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
            <input
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
