/**
 * پرونده مشتری.
 *
 * ── سه چیزی که این صفحه نگه می‌دارد ────────────────────────────────
 *
 * **شماره کلید تطبیق است.** ثبت شماره‌ای که از قبل هست، مشتری دوم
 * نمی‌سازد — همان را باز می‌کند. صفحه هم همین را می‌گوید، وگرنه
 * کاربر فکر می‌کند کارش انجام نشده.
 *
 * **مانده از دفتر می‌آید، نه از یک ستون.** عددی که اینجا دیده می‌شود
 * همان است که در گزارش «دریافتنی و پرداختنی» است، چون هر دو از
 * `ledger.party_tafsili` می‌آیند.
 *
 * **رضایت پیامک و تبلیغات دو چیزند.** مشتری‌ای که فاکتورش را با
 * پیامک می‌خواهد، لزوماً تبلیغات نمی‌خواهد. یکی‌کردنشان یک تخلف
 * است، نه یک ساده‌سازی.
 */
import { useCallback, useEffect, useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { SearchField } from "../components/SearchField.tsx";
import { ApiError } from "../lib/api.ts";
import { parseRial, rialFromTomanInput, toman } from "../lib/money.ts";
import { normalizeDigits } from "../lib/settings-value.ts";
import {
  CUSTOMER_STATUS,
  MEASURE_GROUP,
  people,
  type Customer,
  type CustomerInvoice,
  type FittingVariation,
  type MeasureKey,
} from "../lib/people.ts";

function message(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "ارتباط با سرور برقرار نشد.";
}

function shortDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("fa-IR", { dateStyle: "short" }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

const CHANNEL: Record<string, string> = { pos: "صندوق", web: "سایت", phone: "تلفنی" };

export function Customers() {
  const [rows, setRows] = useState<Customer[]>([]);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<{ customer: Customer; invoices: CustomerInvoice[] } | null>(
    null,
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [mobile, setMobile] = useState("");
  const [fullName, setFullName] = useState("");

  const reload = useCallback(async (term: string) => {
    setRows((await people.customers(term)).customers);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await reload("");
      } catch (err) {
        setError(message(err));
      }
    })();
  }, [reload]);

  async function guarded(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  const search = () => guarded(async () => { await reload(q); });

  const create = () =>
    guarded(async () => {
      setNote(null);
      const out = await people.upsertCustomer({
        mobile: normalizeDigits(mobile),
        ...(fullName.trim() === "" ? {} : { fullName: fullName.trim() }),
      });
      // شماره تکراری مشتری دوم نمی‌سازد — و کاربر باید بداند کدام شد.
      setNote(
        out.created
          ? `مشتری تازه ثبت شد: ${out.mobile}`
          : `این شماره از قبل ثبت شده بود؛ پرونده‌اش باز شد.`,
      );
      setCreating(false);
      setMobile("");
      setFullName("");
      await reload(q);
      setOpen(await people.customer(out.id));
    });

  const openFile = (id: string) =>
    guarded(async () => {
      setNote(null);
      setOpen(await people.customer(id));
    });

  const patch = (id: string, input: Parameters<typeof people.updateCustomer>[1]) =>
    guarded(async () => {
      await people.updateCustomer(id, input);
      setOpen(await people.customer(id));
      await reload(q);
    });

  return (
    <div className="stack" style={{ gap: "var(--s-3)" }}>
      {error ? (
        <p className="solid pos-alert" role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> {error}
        </p>
      ) : null}
      {note ? (
        <p className="solid pos-alert" role="status">
          <span className="dot dot--good" aria-hidden="true">●</span> {note}
        </p>
      ) : null}

      <Solid className="pad">
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <div className="auth-field">
            <span>جست‌وجو — شماره یا نام</span>
            <SearchField label="جست‌وجوی شماره یا نام مشتری" value={q} onChange={setQ} />
          </div>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            جست‌وجو
          </button>
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => setCreating((v) => !v)}
          >
            {creating ? "انصراف" : "مشتری تازه"}
          </button>
        </form>
        <p className="muted small" style={{ margin: 0 }}>
          نام یا شمارهٔ مشتری را برای پیدا کردن پرونده‌اش وارد کنید.
        </p>
      </Solid>

      {creating ? (
        <Solid className="pad">
          <form
            className="filters"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label className="auth-field">
              <span>موبایل</span>
              <input
                type="text"
                inputMode="numeric"
                value={mobile}
                onChange={(e) => setMobile(e.target.value)}
                autoFocus
              />
            </label>
            <label className="auth-field">
              <span>نام (اختیاری)</span>
              <input value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </label>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={busy || mobile.trim().length < 8}
            >
              ثبت
            </button>
          </form>
          <p className="muted small" style={{ margin: 0 }}>
            اگر این شماره از قبل باشد، مشتری دومی ساخته نمی‌شود — همان پرونده باز می‌شود.
          </p>
        </Solid>
      ) : null}

      <Solid className="pad">
        {rows.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>مشتری‌ای پیدا نشد.</p>
        ) : (
          <div className="grid-wrap">
            <table className="grid">
              <caption className="sr-only">فهرست مشتریان</caption>
              <thead>
                <tr>
                  <th scope="col">موبایل</th>
                  <th scope="col">نام</th>
                  <th scope="col">فاکتور</th>
                  <th scope="col">جمع خرید</th>
                  <th scope="col">مانده</th>
                  <th scope="col">وضعیت</th>
                  <th scope="col"> </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td className="num" dir="ltr">{c.mobile}</td>
                    <td>{c.fullName ?? <span className="muted">بی‌نام</span>}</td>
                    <td className="num">{c.invoiceCount}</td>
                    <td className="num">{toman(parseRial(c.totalPurchased))}</td>
                    <td className="num">{toman(parseRial(c.balance))}</td>
                    <td>{CUSTOMER_STATUS[c.status] ?? c.status}</td>
                    <td>
                      <button
                        type="button"
                        className="link"
                        onClick={() => void openFile(c.id)}
                        disabled={busy}
                      >
                        پرونده
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Solid>

      {open ? (
        <CustomerFile
          data={open}
          busy={busy}
          onPatch={(input) => patch(open.customer.id, input)}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * اندازه‌های بدن مشتری.
 *
 * ── این کامپوننت هیچ اندازه‌ای را نمی‌شناسد ─────────────────────────
 *
 * برچسب، واحد، بازه مجاز و گروه همه از `GET /measure-keys` می‌آیند —
 * همان الگوی صفحه تنظیمات. «دور مچ» که فردا در Seed اضافه شود، بدون
 * یک خط تغییر اینجا دیده می‌شود. اگر لازم شد فهرست کلیدها را اینجا
 * بنویسیم، یعنی یک ستون در `sales.measure_key` کم است.
 *
 * ── بازه فقط برای بازخورد فوری است ────────────────────────────────
 *
 * سنجش واقعی در دیتابیس انجام می‌شود. اگر اینجا هم قاعده می‌داشتیم،
 * دو نسخه از یک قاعده داشتیم — و آن که در psql دور زده می‌شود همان
 * است که اهمیت دارد. همان تفکیکی که `lib/settings-value.ts` دارد.
 */
function Measures({ customerId }: { customerId: string }) {
  const [keys, setKeys] = useState<MeasureKey[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<
    { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string }
  >({ kind: "idle" });

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [k, m] = await Promise.all([
          people.measureKeys(),
          people.measures(customerId),
        ]);
        if (!alive) return;
        setKeys(k.keys);
        setValues(Object.fromEntries(m.measures.map((x) => [x.key, x.valueCm])));
      } catch (err) {
        if (alive) setStatus({ kind: "error", message: message(err) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [customerId]);

  async function save() {
    setStatus({ kind: "saving" });
    try {
      // خالی یعنی «نداریم» و از بدنه بیرون می‌ماند — چون ارسال کامل
      // است نه افزایشی، نبودنش یعنی پاک شود.
      const out: Record<string, number> = {};
      for (const [k, raw] of Object.entries(values)) {
        const t = normalizeDigits(raw).trim();
        if (t === "") continue;
        const n = Number(t);
        if (!Number.isFinite(n)) {
          setStatus({ kind: "error", message: `مقدار «${k}» عدد نیست` });
          return;
        }
        out[k] = n;
      }
      const r = await people.setMeasures(customerId, out);
      setValues(Object.fromEntries(r.measures.map((x) => [x.key, x.valueCm])));
      setStatus({ kind: "saved" });
    } catch (err) {
      // پیام نگهبان دیتابیس فارسی و برای کاربر است؛ همان را نشان
      // می‌دهیم، نه یک «خطا» عمومی.
      setStatus({ kind: "error", message: message(err) });
    }
  }

  if (keys === null) {
    return <p className="muted small" style={{ margin: 0 }}>در حال بارگذاری اندازه‌ها…</p>;
  }

  const groups = [...new Set(keys.map((k) => k.groupKey))];

  return (
    <div className="stack" style={{ gap: "var(--s-3)" }}>
      <div className="row between">
        <strong style={{ fontSize: ".95rem" }}>اندازه‌های بدن</strong>
        <span className="muted small">اختیاری — خالی گذاشتن یعنی پاک شدن</span>
      </div>

      {groups.map((g) => (
        <div key={g} className="stack" style={{ gap: "var(--s-2)" }}>
          <span className="muted small">{MEASURE_GROUP[g] ?? g}</span>
          <div className="filters">
            {keys
              .filter((k) => k.groupKey === g)
              .map((k) => (
                <label key={k.key} className="auth-field">
                  <span>
                    {k.label} <span className="muted small">({k.unit})</span>
                  </span>
                  <input
                    // عمداً `type="text"`: صفحه‌کلید فارسی «۱۷۸»
                    // می‌فرستد و ورودی عددی مرورگر آن را دور می‌اندازد.
                    type="text"
                    inputMode="decimal"
                    className="num"
                    value={values[k.key] ?? ""}
                    placeholder={`${k.minValue}–${k.maxValue}`}
                    onChange={(e) => {
                      setValues((v) => ({ ...v, [k.key]: e.target.value }));
                      setStatus({ kind: "idle" });
                    }}
                  />
                </label>
              ))}
          </div>
        </div>
      ))}

      <div className="row" style={{ gap: "var(--s-2)" }}>
        <button
          type="button"
          className="btn btn--primary"
          disabled={status.kind === "saving"}
          onClick={() => void save()}
        >
          {status.kind === "saving" ? "در حال ذخیره…" : "ذخیره اندازه‌ها"}
        </button>
        {status.kind === "error" ? (
          <span className="set-msg set-msg--crit" role="alert">
            <span aria-hidden="true">⚠</span> {status.message}
          </span>
        ) : null}
        {status.kind === "saved" ? (
          <span className="set-msg set-msg--good">
            <span aria-hidden="true">✓</span> ذخیره شد
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * کالاهای مناسب این مشتری.
 *
 * ── این «AI» نیست و ادعایش را هم نمی‌کند ──────────────────────────
 *
 * حساب فاصله است: هر اندازه بدن با اندازه همان کلید روی کالا مقایسه
 * می‌شود، تقسیم بر تحملِ همان کلید. صفحه هم همین را می‌نویسد، چون
 * فروشنده‌ای که فکر کند سیستم «می‌داند»، پیشنهاد را بی‌چون‌وچرا به
 * مشتری می‌گوید.
 *
 * ⚠️ کالای بدون اندازه «—» می‌گیرد، نه صفر. صفر یعنی «نمی‌خورد» و
 * آن یک ادعاست؛ «—» یعنی «اندازه‌اش ثبت نشده».
 */
function Fitting({ customerId }: { customerId: string }) {
  const [rows, setRows] = useState<FittingVariation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void (async () => {
      try {
        const r = await people.fitting(customerId, { limit: 30 });
        if (alive) setRows(r.variations);
      } catch (err) {
        if (alive) setError(message(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, customerId]);

  if (!open) {
    return (
      <button type="button" className="btn btn--quiet" onClick={() => setOpen(true)}>
        کالاهای مناسب این مشتری
      </button>
    );
  }

  return (
    <div className="stack" style={{ gap: "var(--s-2)" }}>
      <div className="row between">
        <strong style={{ fontSize: ".95rem" }}>کالاهای مناسب</strong>
        <button type="button" className="btn btn--quiet" onClick={() => setOpen(false)}>
          بستن
        </button>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        بر اساس فاصله اندازه‌ها حساب می‌شود، نه پیش‌بینی. «—» یعنی اندازه آن کالا
        هنوز ثبت نشده.
      </p>

      {error !== null ? (
        <p className="muted" style={{ margin: 0 }} role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> {error}
        </p>
      ) : rows === null ? (
        <p className="muted small" style={{ margin: 0 }}>در حال محاسبه…</p>
      ) : rows.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>
          هیچ کالای موجودی نیست.
        </p>
      ) : (
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>کالا</th>
                <th>رنگ</th>
                <th>سایز</th>
                <th className="num">موجودی</th>
                <th className="num">تناسب</th>
                <th className="num">بر پایه</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.variationId}>
                  <td>{r.productName}</td>
                  <td>{r.color}</td>
                  <td>{r.size}</td>
                  <td className="num">{r.onHand}</td>
                  <td className="num">
                    {r.matchScore === null
                      ? "—"
                      : `${Math.round(r.matchScore * 100).toLocaleString("fa-IR")}٪`}
                  </td>
                  <td className="num">
                    {r.matchScore === null
                      ? "—"
                      : `${r.matchedKeys.toLocaleString("fa-IR")} اندازه`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CustomerFile({
  data,
  busy,
  onPatch,
  onClose,
}: {
  data: { customer: Customer; invoices: CustomerInvoice[] };
  busy: boolean;
  onPatch: (input: Parameters<typeof people.updateCustomer>[1]) => void;
  onClose: () => void;
}) {
  const c = data.customer;
  const [limit, setLimit] = useState(
    c.creditLimit === "0" ? "" : toman(parseRial(c.creditLimit)).replace(/٬/g, ""),
  );
  const [name, setName] = useState(c.fullName ?? "");
  const [addr, setAddr] = useState(c.address ?? "");
  const [postal, setPostal] = useState(c.postalCode ?? "");
  const [city, setCity] = useState(c.city ?? "");
  const [province, setProvince] = useState(c.province ?? "");

  const rial = limit.trim() === "" ? 0n : rialFromTomanInput(limit);

  return (
    <div className="stack" style={{ gap: "var(--s-3)" }}>
      <Solid className="pad">
        <div className="row between">
          <div>
            <h2 style={{ margin: 0, fontSize: "1rem" }}>
              {c.fullName ?? "بی‌نام"} · <span className="num" dir="ltr">{c.mobile}</span>
            </h2>
            <p className="muted small" style={{ margin: 0 }}>
              {c.invoiceCount} فاکتور · جمع خرید {toman(parseRial(c.totalPurchased))} ·
              مانده {toman(parseRial(c.balance))}
            </p>
          </div>
          <button type="button" className="btn btn--quiet" onClick={onClose}>
            بستن
          </button>
        </div>
      </Solid>

      <Solid className="pad stack" style={{ gap: "var(--s-3)" }}>
        <div className="filters">
          <label className="auth-field">
            <span>نام</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="auth-field">
            <span>سقف اعتبار (تومان)</span>
            <input
              type="text"
              inputMode="numeric"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || rial === null}
            onClick={() =>
              rial !== null &&
              onPatch({
                fullName: name.trim() === "" ? null : name.trim(),
                creditLimit: rial.toString(),
              })
            }
          >
            ذخیره
          </button>
        </div>

        {/*
          نشانی و کد پستی — برای ارسال سفارش سایت.

          نشانی متن آزاد است و باید باشد: نشانی ایرانی قالب ثابتی
          ندارد و شکستنش به کوچه و پلاک، پیک را جایی می‌فرستد که
          نیست.

          ⚠️ کد پستی `type="text"` است نه `type="number"` — صفحه‌کلید
          فارسی «۱۲۳۴۵» می‌فرستد و ورودی عددی مرورگر دورش می‌اندازد.
          نرمال‌سازی و سنجش ده رقم در **دیتابیس** انجام می‌شود، پس
          اینجا رقم را دست نمی‌زنیم و پیام خطای سرور را نشان می‌دهیم.
        */}
        <div className="filters">
          <label className="auth-field" style={{ flex: "2 1 20rem" }}>
            <span>نشانی</span>
            <input value={addr} onChange={(e) => setAddr(e.target.value)} />
          </label>
          <label className="auth-field">
            <span>کد پستی</span>
            <input
              type="text"
              inputMode="numeric"
              className="num"
              value={postal}
              onChange={(e) => setPostal(e.target.value)}
              placeholder="۱۰ رقم"
            />
          </label>
          <label className="auth-field">
            <span>شهر</span>
            <input value={city} onChange={(e) => setCity(e.target.value)} />
          </label>
          <label className="auth-field">
            <span>استان</span>
            <input value={province} onChange={(e) => setProvince(e.target.value)} />
          </label>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={() =>
              onPatch({
                address: addr.trim() === "" ? null : addr.trim(),
                postalCode: postal.trim() === "" ? null : postal.trim(),
                city: city.trim() === "" ? null : city.trim(),
                province: province.trim() === "" ? null : province.trim(),
              })
            }
          >
            ذخیره نشانی
          </button>
        </div>

        <Measures customerId={c.id} />
        <Fitting customerId={c.id} />

        {/*
          دو رضایت، دو تیک.

          پیامک فاکتور با اولی می‌رود و تبلیغات با دومی. مشتری‌ای که
          فقط فاکتورش را می‌خواهد نباید تبلیغات بگیرد — یکی‌کردنشان
          یک تخلف است، نه یک ساده‌سازی.
        */}
        <div className="stack" style={{ gap: "var(--s-2)" }}>
          <label className="row" style={{ gap: "var(--s-2)" }}>
            <input
              type="checkbox"
              checked={c.consentSms}
              disabled={busy}
              onChange={(e) => onPatch({ consentSms: e.target.checked })}
            />
            <span>پیامک فاکتور و اطلاع‌رسانی خرید</span>
          </label>
          <label className="row" style={{ gap: "var(--s-2)" }}>
            <input
              type="checkbox"
              checked={c.consentMarketing}
              disabled={busy}
              onChange={(e) => onPatch({ consentMarketing: e.target.checked })}
            />
            <span>پیامک تبلیغاتی و کمپین</span>
          </label>
          <label className="row" style={{ gap: "var(--s-2)" }}>
            <input
              type="checkbox"
              checked={c.status === "blocked"}
              disabled={busy}
              onChange={(e) => onPatch({ status: e.target.checked ? "blocked" : "active" })}
            />
            <span>مسدود — فروش نسیه به این مشتری ثبت نشود</span>
          </label>
        </div>
      </Solid>

      <Solid className="pad">
        <h3 style={{ marginTop: 0, fontSize: "0.95rem" }}>خریدها</h3>
        {data.invoices.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>هنوز خریدی ثبت نشده است.</p>
        ) : (
          <div className="grid-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th scope="col">شماره</th>
                  <th scope="col">تاریخ</th>
                  <th scope="col">کانال</th>
                  <th scope="col">مبلغ</th>
                  <th scope="col">پرداختی</th>
                  <th scope="col">وضعیت</th>
                </tr>
              </thead>
              <tbody>
                {data.invoices.map((i) => (
                  <tr key={i.id}>
                    <td className="num">{i.number ?? "—"}</td>
                    <td className="num">{shortDate(i.occurredAt)}</td>
                    <td>{CHANNEL[i.channel] ?? i.channel}</td>
                    <td className="num">{toman(parseRial(i.netAmount))}</td>
                    <td className="num">{toman(parseRial(i.paidAmount))}</td>
                    <td>{i.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Solid>
    </div>
  );
}
