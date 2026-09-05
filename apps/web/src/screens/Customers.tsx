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
import { ApiError } from "../lib/api.ts";
import { parseRial, rialFromTomanInput, toman } from "../lib/money.ts";
import { normalizeDigits } from "../lib/settings-value.ts";
import {
  CUSTOMER_STATUS,
  people,
  type Customer,
  type CustomerInvoice,
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
          <label className="auth-field">
            <span>جست‌وجو — شماره یا نام</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
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
          جست‌وجو سمت سرور است — مشتری دو سال پیش هم پیدا می‌شود.
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
