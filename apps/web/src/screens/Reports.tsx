/**
 * گزارش‌ها — ناحیه متوسط.
 *
 * ADR-002 برای «گزارش‌های مالی» نوشته: **متوسط — فقط نوار و کارت.
 * جدول عدد باید مات و پرتضاد باشد.** پس نوار زیربخش‌ها شیشه‌ای است و
 * هر جدولی که عدد دارد `solid`.
 *
 * ── چهار چیزی که این صفحه عمداً نمی‌کند ─────────────────────────────
 *
 * **هیچ عددی حساب نمی‌کند.** جمع، سود، حاشیه و مانده تجمعی همه از SQL
 * می‌آیند. تنها جمعی که اینجا زده می‌شود، جمع ستون‌های جدولِ جلوی چشم
 * است — و آن هم با `bigint`، نه `number`.
 *
 * **«امروز» را از ساعت مرورگر نمی‌گیرد.** بازه پیش‌فرض از
 * `GET /reports/daily` می‌آید که `platform.business_date()` را
 * برمی‌گرداند. تبلتی که ساعتش عقب باشد، بازه‌ای می‌ساخت که فروش امروز
 * را نداشت.
 *
 * **شعبه را تحمیل نمی‌کند.** `branchId` فرستاده نمی‌شود مگر کاربر
 * انتخاب کند؛ سرور خودش دامنه را می‌گذارد. حذف پارامتر هیچ دری باز
 * نمی‌کند.
 *
 * **بهای `null` را صفر نشان نمی‌دهد.** کاربر بدون `cost.view` در
 * ستون بها و سود «—» می‌بیند. صفر یعنی «سود نداشتی»؛ «—» یعنی
 * «اجازه دیدنش را نداری». یکی‌کردنشان یعنی سرپرست فکر کند فروشگاه
 * ضرر کرده.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Glass, Solid } from "../components/Glass.tsx";
import { ApiError } from "../lib/api.ts";
import { parseRial, toman } from "../lib/money.ts";
import { normalizeDigits } from "../lib/settings-value.ts";
import { pos, type Branch, type Warehouse } from "../lib/pos.ts";
import {
  CHANNEL_LABEL,
  MOVEMENT_KIND,
  PARTY_LABEL,
  defaultPeriod,
  reports,
  type LedgerRow,
  type PartyRow,
  type Period,
  type ProfitRow,
  type SalesRow,
  type ShiftRow,
  type TrialRow,
  type ValuationRow,
} from "../lib/reports.ts";

const TABS = [
  { key: "sales", label: "فروش" },
  { key: "profit", label: "سود کالا" },
  { key: "stock", label: "موجودی" },
  { key: "ledger", label: "دفتر حساب" },
  { key: "trial", label: "تراز آزمایشی" },
  { key: "parties", label: "دریافتنی و پرداختنی" },
  { key: "cash", label: "مغایرت نقد" },
] as const;

type Tab = (typeof TABS)[number]["key"];

function message(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "ارتباط با سرور برقرار نشد.";
}

/** مبلغی که ممکن است «اجازه‌اش را نداری» باشد. */
function Money({ value }: { value: string | null }) {
  if (value === null) return <span className="muted">—</span>;
  return <span className="num">{toman(parseRial(value))}</span>;
}

function when(iso: string): string {
  try {
    return new Intl.DateTimeFormat("fa-IR", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 16).replace("T", " ");
  }
}

export function Reports() {
  const [tab, setTab] = useState<Tab>("sales");
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("");
  const [period, setPeriod] = useState<{ from: string; to: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { branches: list } = await pos.branches();
        setBranches(list);
        const first = list[0];
        if (!first) {
          setError("به هیچ شعبه‌ای دسترسی ندارید.");
          return;
        }
        // بازه پیش‌فرض از **تاریخ کاری سرور** ساخته می‌شود.
        const daily = await pos.dailyReport(first.id);
        setPeriod(defaultPeriod(daily.businessDate));
      } catch (err) {
        setError(message(err));
      }
    })();
  }, []);

  if (error) {
    return (
      <Solid className="pad">
        <p style={{ margin: 0 }}>
          <span className="dot dot--crit" aria-hidden="true">●</span> {error}
        </p>
      </Solid>
    );
  }
  if (!period) return <Solid className="pad">در حال بارگذاری…</Solid>;

  const p: Period = {
    ...period,
    ...(branchId === "" ? {} : { branchId }),
  };

  return (
    <div className="stack" style={{ gap: "var(--s-4)" }}>
      <div className="subtabs" role="tablist" aria-label="گزارش‌ها">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={tab === t.key ? "on" : ""}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* فیلترها روی سطح شیشه‌ای — لایه کنترلی، نه محتوا. */}
      <Glass radius="md" className="pad">
        <div className="filters">
          <label className="auth-field">
            <span>از تاریخ</span>
            <input
              type="text"
              inputMode="numeric"
              value={period.from}
              onChange={(e) => setPeriod({ ...period, from: normalizeDigits(e.target.value) })}
              placeholder="۱۴۰۵-۰۶-۰۱"
            />
          </label>
          <label className="auth-field">
            <span>تا تاریخ</span>
            <input
              type="text"
              inputMode="numeric"
              value={period.to}
              onChange={(e) => setPeriod({ ...period, to: normalizeDigits(e.target.value) })}
            />
          </label>
          {branches.length > 1 ? (
            <label className="auth-field">
              <span>شعبه</span>
              <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                <option value="">همه شعبه‌ها</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          تاریخ‌ها میلادی‌اند و بازه شامل هر دو سر است. «امروز» را سرور تعیین می‌کند، نه
          ساعت این دستگاه.
        </p>
      </Glass>

      {tab === "sales" ? (
        <SalesReport period={p} />
      ) : tab === "profit" ? (
        <ProfitReport period={p} />
      ) : tab === "stock" ? (
        <StockReport period={p} branches={branches} />
      ) : tab === "ledger" ? (
        <LedgerReport period={p} />
      ) : tab === "trial" ? (
        <TrialReport period={p} />
      ) : tab === "parties" ? (
        <PartyReport />
      ) : (
        <CashReport period={p} />
      )}
    </div>
  );
}

/**
 * پوسته مشترک هر گزارش: بارگذاری، خطا، خالی.
 *
 * سه حالت که اگر یکی‌شان جا بیفتد، جدول خالی «داده نیست» و «خطا خورد»
 * را یکی نشان می‌دهد — و کاربر گزارش غلط را باور می‌کند.
 */
function useReport<T>(load: () => Promise<T[]>, deps: unknown[]) {
  const [rows, setRows] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps صریح داده می‌شود
  const run = useCallback(load, deps);

  useEffect(() => {
    let alive = true;
    setRows(null);
    setError(null);
    void (async () => {
      try {
        const out = await run();
        if (alive) setRows(out);
      } catch (err) {
        if (alive) setError(message(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [run]);

  return { rows, error };
}

function Frame({
  rows,
  error,
  empty,
  children,
}: {
  rows: unknown[] | null;
  error: string | null;
  empty: string;
  children: ReactNode;
}) {
  if (error !== null) {
    return (
      <Solid className="pad">
        <p style={{ margin: 0 }} role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> {error}
        </p>
      </Solid>
    );
  }
  if (rows === null) return <Solid className="pad">در حال بارگذاری…</Solid>;
  if (rows.length === 0) return <Solid className="pad muted">{empty}</Solid>;
  return <>{children}</>;
}

// ── فروش دوره‌ای ─────────────────────────────────────────────────────

function SalesReport({ period }: { period: Period }) {
  const { rows, error } = useReport<SalesRow>(
    async () => (await reports.sales(period)).rows,
    [period.from, period.to, period.branchId],
  );

  // جمع ستون‌ها با `bigint` — همان قاعده‌ای که `lib/cart.ts` دارد.
  const total = (rows ?? []).reduce(
    (a, r) => ({
      net: a.net + parseRial(r.netAmount),
      ret: a.ret + parseRial(r.returnAmount),
      profit: r.profitAmount === null ? null : (a.profit ?? 0n) + parseRial(r.profitAmount),
    }),
    { net: 0n, ret: 0n, profit: 0n as bigint | null },
  );

  return (
    <Frame rows={rows} error={error} empty="در این بازه فروشی ثبت نشده است.">
      <Solid className="pad">
        <div className="grid-wrap">
          <table className="grid">
            <caption className="sr-only">فروش به تفکیک روز و کانال</caption>
            <thead>
              <tr>
                <th scope="col">تاریخ</th>
                <th scope="col">کانال</th>
                <th scope="col">فاکتور</th>
                <th scope="col">ناخالص</th>
                <th scope="col">تخفیف</th>
                <th scope="col">خالص</th>
                <th scope="col">مرجوعی</th>
                <th scope="col">بهای تمام‌شده</th>
                <th scope="col">سود</th>
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((r) => (
                <tr key={`${r.businessDate}-${r.channel}`}>
                  <td className="num">{r.businessDate}</td>
                  <td>{CHANNEL_LABEL[r.channel] ?? r.channel}</td>
                  <td className="num">{r.invoiceCount}</td>
                  <td><Money value={r.grossAmount} /></td>
                  <td><Money value={r.discountAmount} /></td>
                  <td><Money value={r.netAmount} /></td>
                  <td>
                    {r.returnCount === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      <>
                        <Money value={r.returnAmount} />{" "}
                        <span className="muted small">({r.returnCount})</span>
                      </>
                    )}
                  </td>
                  <td><Money value={r.cogsAmount} /></td>
                  <td><Money value={r.profitAmount} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={5}>جمع بازه</th>
                <td><Money value={total.net.toString()} /></td>
                <td><Money value={total.ret.toString()} /></td>
                <td />
                <td><Money value={total.profit === null ? null : total.profit.toString()} /></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Solid>
    </Frame>
  );
}

// ── سود کالا ─────────────────────────────────────────────────────────

function ProfitReport({ period }: { period: Period }) {
  const { rows, error } = useReport<ProfitRow>(
    async () => (await reports.profitByProduct(period)).rows,
    [period.from, period.to, period.branchId],
  );

  return (
    <Frame
      rows={rows}
      error={error}
      empty="در این بازه کالایی فروخته نشده — یا دسترسی بهای تمام‌شده ندارید."
    >
      <Solid className="pad">
        <div className="grid-wrap">
          <table className="grid">
            <caption className="sr-only">سود به تفکیک کالا</caption>
            <thead>
              <tr>
                <th scope="col">کالا</th>
                <th scope="col">SKU</th>
                <th scope="col">فروخته</th>
                <th scope="col">برگشتی</th>
                <th scope="col">فروش خالص</th>
                <th scope="col">بها</th>
                <th scope="col">سود</th>
                <th scope="col">حاشیه</th>
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((r) => (
                <tr key={r.variationId}>
                  <td>
                    {r.productName}
                    <span className="muted small"> · {r.color} {r.size}</span>
                  </td>
                  <td className="num">{r.sku}</td>
                  <td className="num">{Number(r.qtySold)}</td>
                  <td className="num">
                    {Number(r.qtyReturned) === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      Number(r.qtyReturned)
                    )}
                  </td>
                  <td><Money value={r.netAmount} /></td>
                  <td><Money value={r.cogsAmount} /></td>
                  <td><Money value={r.profitAmount} /></td>
                  <td className="num">
                    {r.marginPercent === null ? (
                      <span className="muted">—</span>
                    ) : (
                      `${r.marginPercent}٪`
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Solid>
    </Frame>
  );
}

// ── موجودی و کاردکس ──────────────────────────────────────────────────

function StockReport({ period, branches }: { period: Period; branches: Branch[] }) {
  const warehouses: Warehouse[] = branches.flatMap((b) => b.warehouses);
  const [warehouseId, setWarehouseId] = useState("");
  const [picked, setPicked] = useState<ValuationRow | null>(null);

  const { rows, error } = useReport<ValuationRow>(
    async () => (await reports.valuation(warehouseId === "" ? undefined : warehouseId)).rows,
    [warehouseId],
  );

  const totalValue = (rows ?? []).reduce((a, r) => a + parseRial(r.totalValue), 0n);

  return (
    <div className="stack" style={{ gap: "var(--s-3)" }}>
      {warehouses.length > 1 ? (
        <Solid className="pad">
          <label className="auth-field">
            <span>انبار</span>
            <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">همه انبارها</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        </Solid>
      ) : null}

      <Frame
        rows={rows}
        error={error}
        empty="موجودی‌ای برای نمایش نیست — یا دسترسی بهای تمام‌شده ندارید."
      >
        <Solid className="pad">
          <div className="grid-wrap">
            <table className="grid">
              <caption className="sr-only">موجودی و ارزش دفتری</caption>
              <thead>
                <tr>
                  <th scope="col">انبار</th>
                  <th scope="col">کالا</th>
                  <th scope="col">SKU</th>
                  <th scope="col">موجودی</th>
                  <th scope="col">بهای واحد</th>
                  <th scope="col">ارزش</th>
                  <th scope="col">گردش</th>
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).map((r) => (
                  <tr key={`${r.warehouseId}-${r.variationId}`}>
                    <td>{r.warehouseName}</td>
                    <td>
                      {r.productName}
                      <span className="muted small"> · {r.color} {r.size}</span>
                    </td>
                    <td className="num">{r.sku}</td>
                    <td className="num">{Number(r.onHand)}</td>
                    <td><Money value={r.unitCost} /></td>
                    <td><Money value={r.totalValue} /></td>
                    <td>
                      <button
                        type="button"
                        className="link"
                        onClick={() => setPicked(picked?.variationId === r.variationId ? null : r)}
                      >
                        {picked?.variationId === r.variationId ? "بستن" : "کاردکس"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={5}>جمع ارزش</th>
                  <td><Money value={totalValue.toString()} /></td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </Solid>
      </Frame>

      {picked ? (
        <Kardex
          period={period}
          variationId={picked.variationId}
          title={`${picked.productName} · ${picked.color} ${picked.size}`}
          {...(warehouseId === "" ? {} : { warehouseId })}
        />
      ) : null}
    </div>
  );
}

function Kardex({
  period,
  variationId,
  warehouseId,
  title,
}: {
  period: Period;
  variationId: string;
  warehouseId?: string | undefined;
  title: string;
}) {
  const { rows, error } = useReport(
    async () => (await reports.movements(period, variationId, warehouseId)).rows,
    [period.from, period.to, variationId, warehouseId],
  );

  return (
    <Frame rows={rows} error={error} empty="در این بازه حرکتی برای این کالا ثبت نشده است.">
      <Solid className="pad">
        <h3 style={{ fontSize: "0.95rem", marginTop: 0 }}>کاردکس — {title}</h3>
        <div className="grid-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th scope="col">زمان</th>
                <th scope="col">انبار</th>
                <th scope="col">نوع</th>
                <th scope="col">تعداد</th>
                <th scope="col">مانده</th>
                <th scope="col">بهای واحد</th>
                <th scope="col">تغییر ارزش</th>
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((r, i) => (
                <tr key={`${r.occurredAt}-${i}`}>
                  <td className="num">{when(r.occurredAt)}</td>
                  <td>{r.warehouseName}</td>
                  <td>{MOVEMENT_KIND[r.kind] ?? r.kind}</td>
                  <td className="num">{Number(r.qty)}</td>
                  <td className="num">{Number(r.runningQty)}</td>
                  <td><Money value={r.unitCost} /></td>
                  <td><Money value={r.valueDelta} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Solid>
    </Frame>
  );
}

// ── دفتر حساب ────────────────────────────────────────────────────────

function LedgerReport({ period }: { period: Period }) {
  const [code, setCode] = useState("");
  const [applied, setApplied] = useState("");

  const { rows, error } = useReport<LedgerRow>(
    async () => (applied === "" ? [] : (await reports.accountLedger(period, applied)).rows),
    [period.from, period.to, period.branchId, applied],
  );

  return (
    <div className="stack" style={{ gap: "var(--s-3)" }}>
      <Solid className="pad">
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(code.trim());
          }}
        >
          <label className="auth-field">
            <span>کد حساب</span>
            <input
              type="text"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(normalizeDigits(e.target.value))}
              placeholder="۱۳۰۱"
            />
          </label>
          <button type="submit" className="btn btn--primary" disabled={code.trim() === ""}>
            نمایش
          </button>
        </form>
        <p className="muted small" style={{ margin: 0 }}>
          کد حساب را از صفحه «تنظیمات ← کدینگ حساب» بردارید. فقط سند تأییدشده و نهایی
          می‌آید.
        </p>
      </Solid>

      {applied === "" ? null : (
        <Frame rows={rows} error={error} empty="این حساب در این بازه گردشی نداشته است.">
          <Solid className="pad">
            <div className="grid-wrap">
              <table className="grid">
                <thead>
                  <tr>
                    <th scope="col">تاریخ</th>
                    <th scope="col">سند</th>
                    <th scope="col">شرح</th>
                    <th scope="col">طرف حساب</th>
                    <th scope="col">بدهکار</th>
                    <th scope="col">بستانکار</th>
                    <th scope="col">مانده</th>
                  </tr>
                </thead>
                <tbody>
                  {(rows ?? []).map((r, i) => (
                    <tr key={`${r.entryNumber}-${i}`}>
                      <td className="num">{r.entryDate}</td>
                      <td className="num">{r.entryNumber}</td>
                      <td>{r.description ?? <span className="muted">—</span>}</td>
                      <td>{r.partyName ?? <span className="muted">—</span>}</td>
                      <td><Money value={r.debit} /></td>
                      <td><Money value={r.credit} /></td>
                      <td><Money value={r.running} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Solid>
        </Frame>
      )}
    </div>
  );
}

// ── تراز آزمایشی ─────────────────────────────────────────────────────

function TrialReport({ period }: { period: Period }) {
  const { rows, error } = useReport<TrialRow>(
    async () => (await reports.trialBalance(period)).rows,
    [period.from, period.to, period.branchId],
  );

  const dr = (rows ?? []).reduce((a, r) => a + parseRial(r.debit), 0n);
  const cr = (rows ?? []).reduce((a, r) => a + parseRial(r.credit), 0n);

  return (
    <Frame rows={rows} error={error} empty="در این بازه سندی ثبت نشده است.">
      <Solid className="pad">
        <div className="grid-wrap">
          <table className="grid">
            <caption className="sr-only">تراز آزمایشی بازه</caption>
            <thead>
              <tr>
                <th scope="col">کد</th>
                <th scope="col">نام حساب</th>
                <th scope="col">مانده اول دوره</th>
                <th scope="col">بدهکار</th>
                <th scope="col">بستانکار</th>
                <th scope="col">مانده پایان</th>
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((r) => (
                <tr key={r.code}>
                  <td className="num">{r.code}</td>
                  <td>{r.name}</td>
                  <td><Money value={r.openingBalance} /></td>
                  <td><Money value={r.debit} /></td>
                  <td><Money value={r.credit} /></td>
                  <td><Money value={r.closingBalance} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              {/*
                جمع دو ستون باید برابر باشد. اگر روزی نبود، یعنی سندی
                نامتوازن به دفتر رفته — و آن یک خطای مالی است، نه یک
                خطای نمایش. پس صریح نوشته می‌شود، نه پنهان.
              */}
              <tr>
                <th scope="row" colSpan={3}>جمع</th>
                <td><Money value={dr.toString()} /></td>
                <td><Money value={cr.toString()} /></td>
                <td>
                  {dr === cr ? (
                    <span className="muted small">
                      <span className="dot dot--good" aria-hidden="true">●</span> متوازن
                    </span>
                  ) : (
                    <span className="small" role="alert">
                      <span className="dot dot--crit" aria-hidden="true">●</span> نامتوازن
                    </span>
                  )}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Solid>
    </Frame>
  );
}

// ── دریافتنی و پرداختنی ──────────────────────────────────────────────

function PartyReport() {
  const [kind, setKind] = useState("");
  const { rows, error } = useReport<PartyRow>(
    async () => (await reports.partyBalances(kind === "" ? undefined : kind)).rows,
    [kind],
  );

  return (
    <div className="stack" style={{ gap: "var(--s-3)" }}>
      <Solid className="pad">
        <label className="auth-field">
          <span>نوع شخص</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">همه</option>
            <option value="customer">مشتری</option>
            <option value="supplier">تأمین‌کننده</option>
          </select>
        </label>
        <p className="muted small" style={{ margin: 0 }}>
          مانده از تفصیلی سند ساخته می‌شود، نه از یک جدول موازی. مانده صفر نمی‌آید.
        </p>
      </Solid>

      <Frame rows={rows} error={error} empty="مانده‌ای برای نمایش نیست.">
        <Solid className="pad">
          <div className="grid-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th scope="col">کد تفصیلی</th>
                  <th scope="col">نام</th>
                  <th scope="col">نوع</th>
                  <th scope="col">سرفصل</th>
                  <th scope="col">بدهکار</th>
                  <th scope="col">بستانکار</th>
                  <th scope="col">مانده</th>
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).map((r) => (
                  <tr key={`${r.partyType}-${r.partyId}`}>
                    <td className="num">{r.code}</td>
                    <td>{r.partyName ?? <span className="muted">بی‌نام</span>}</td>
                    <td>{PARTY_LABEL[r.partyType] ?? r.partyType}</td>
                    <td>{r.parentName}</td>
                    <td><Money value={r.debit} /></td>
                    <td><Money value={r.credit} /></td>
                    <td><Money value={r.balance} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Solid>
      </Frame>
    </div>
  );
}

// ── مغایرت‌گیری نقد ──────────────────────────────────────────────────

function CashReport({ period }: { period: Period }) {
  const { rows, error } = useReport<ShiftRow>(
    async () => (await reports.cashReconciliation(period)).rows,
    [period.from, period.to, period.branchId],
  );

  return (
    <Frame rows={rows} error={error} empty="در این بازه شیفتی باز نشده است.">
      <Solid className="pad">
        <div className="grid-wrap">
          <table className="grid">
            <caption className="sr-only">شمارش کشو در برابر انتظار</caption>
            <thead>
              <tr>
                <th scope="col">شیفت</th>
                <th scope="col">صندوق‌دار</th>
                <th scope="col">اول</th>
                <th scope="col">فروش نقدی</th>
                <th scope="col">بازپرداخت</th>
                <th scope="col">ورودی</th>
                <th scope="col">خروجی</th>
                <th scope="col">انتظار</th>
                <th scope="col">شمرده</th>
                <th scope="col">مغایرت</th>
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((r) => {
                const v = r.variance === null ? null : parseRial(r.variance);
                return (
                  <tr key={r.shiftId}>
                    <td className="num">{when(r.openedAt)}</td>
                    <td>{r.userName}</td>
                    <td><Money value={r.openingCash} /></td>
                    <td><Money value={r.cashSales} /></td>
                    <td><Money value={r.cashRefunds} /></td>
                    <td><Money value={r.cashIn} /></td>
                    <td><Money value={r.cashOut} /></td>
                    <td><Money value={r.expectedCash} /></td>
                    <td><Money value={r.countedCash} /></td>
                    <td>
                      {/*
                        مغایرت صفر یک خبر خوب است و باید دیده شود؛
                        مغایرت ناصفر یک هشدار. رنگ به‌تنهایی حامل معنا
                        نیست، پس شکل و برچسب هم هست.
                      */}
                      {v === null ? (
                        <span className="muted">شیفت باز</span>
                      ) : v === 0n ? (
                        <span className="muted small">
                          <span className="dot dot--good" aria-hidden="true">●</span> بدون مغایرت
                        </span>
                      ) : (
                        <span className="small">
                          <span className="dot dot--crit" aria-hidden="true">■</span>{" "}
                          <span className="num">{toman(v)}</span>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Solid>
    </Frame>
  );
}
