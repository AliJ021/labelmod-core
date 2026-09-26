import { TabList, TabPanels, useTabsId } from "../components/Tabs.tsx";
/**
 * خزانه و چک.
 *
 * ناحیه «متوسط» ADR-002: کارت شیشه‌ای، ولی هر فرم و هر عددی مات.
 *
 * ── چهار چیزی که این صفحه عمداً نمی‌کند ─────────────────────────────
 *
 * **شیفت را حدس نمی‌زند.** `shiftId` فرستاده نمی‌شود؛ سرور خودش شیفت
 * باز شعبه را پیدا می‌کند. فقط اگر دو کشو هم‌زمان باز باشند سرور
 * `ambiguous_shift` می‌دهد و آن‌وقت صفحه می‌پرسد — نه پیش از آن.
 *
 * **وضعیت چک را عوض نمی‌کند.** فقط یک «عمل» می‌فرستد. اینکه مجاز است
 * یا نه، `treasury.post_cheque_event()` تصمیم می‌گیرد. دکمه‌هایی که
 * نشان داده می‌شوند از `actionsFor` می‌آیند تا کاربر دکمه‌ای نبیند که
 * سرور ردش می‌کند — ولی آن یک راحتی است، نه دروازه.
 *
 * **سررسید را حساب نمی‌کند.** `urgency` از دیتابیس می‌آید. «امروز» یک
 * تعریف دارد (`platform.business_date()` و منطقه زمانی تنظیمات)؛
 * حساب‌کردنش در مرورگر یعنی چکی که روی سرور سررسیدشده است اینجا
 * «فردا» دیده شود.
 *
 * **مجوز را حدس نمی‌زند.** بدون `treasury.manage` یا `cheque.manage`،
 * سرور ۴۰۳ با پیام فارسی می‌دهد و همان نشان داده می‌شود.
 */
import { useCallback, useEffect, useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { ApiError } from "../lib/api.ts";
import { ActionKeys, actionFor } from "../lib/action-key.ts";
import { rialFromTomanInput, toman } from "../lib/money.ts";
import { pos, type Branch } from "../lib/pos.ts";
import { purchasing, type ExpenseAccount, type Supplier } from "../lib/purchasing.ts";
import {
  ACCOUNT_KIND,
  ACTION_LABEL,
  CHEQUE_STATUS,
  PURPOSE_LABEL,
  actionsFor,
  needsAccount,
  treasury,
  type Cheque,
  type ChequeAction,
  type ChequeDue,
  type Purpose,
  type TreasuryAccount,
  type TreasuryTransaction,
} from "../lib/treasury.ts";

const TABS = [
  { key: "cash", label: "حرکت پول" },
  { key: "cheques", label: "چک‌ها" },
  { key: "due", label: "سررسیدها" },
] as const;

type Tab = (typeof TABS)[number]["key"];

function message(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "ارتباط با سرور برقرار نشد.";
}

function when(iso: string): string {
  try {
    return new Intl.DateTimeFormat("fa-IR", { dateStyle: "short" }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/** نقطه وضعیت — رنگ به‌تنهایی معنا حمل نمی‌کند (قاعده ۳ طراحی). */
function Urgency({ level }: { level: string }) {
  const tone =
    level === "overdue" ? "crit" : level === "today" ? "warn" : level === "soon" ? "warn" : "good";
  const label =
    level === "overdue"
      ? "گذشته"
      : level === "today"
        ? "امروز"
        : level === "soon"
          ? "نزدیک"
          : "آینده";
  return (
    <>
      <span className={`dot dot--${tone}`} aria-hidden="true">
        ●
      </span>{" "}
      {label}
    </>
  );
}

export function Treasury() {
  const tabsId = useTabsId();
  const [tab, setTab] = useState<Tab>("cash");

  return (
    <div className="stack" style={{ gap: "var(--s-4)" }}>
      <TabList id={tabsId} items={TABS} value={tab} onChange={setTab} label="بخش‌های خزانه" />
      <TabPanels id={tabsId} items={TABS} value={tab} className="stack section-stack">

      {tab === "cash" ? <CashMoves /> : tab === "cheques" ? <Cheques /> : <DueList />}
      </TabPanels>
    </div>
  );
}

// ── حرکت پول ─────────────────────────────────────────────────────────

function CashMoves() {
  const [accounts, setAccounts] = useState<TreasuryAccount[]>([]);
  const [expenses, setExpenses] = useState<ExpenseAccount[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [branch, setBranch] = useState<Branch | null>(null);
  const [rows, setRows] = useState<TreasuryTransaction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [purpose, setPurpose] = useState<Purpose>("expense");
  const [raw, setRaw] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [expenseCode, setExpenseCode] = useState("");
  const [partyId, setPartyId] = useState("");
  const [refNo, setRefNo] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [keys] = useState(() => new ActionKeys());

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([treasury.accounts(), pos.branches()]);
      setAccounts(a.accounts);
      setBranch(b.branches[0] ?? null);
      setRows((await treasury.transactions()).transactions);
      setError(null);
      // سرفصل هزینه و تأمین‌کننده مجوز دیگری دارند؛ نبودشان خطا نیست
      try {
        setExpenses(await purchasing.expenseAccounts());
      } catch {
        setExpenses([]);
      }
      try {
        setSuppliers(await purchasing.suppliers());
      } catch {
        setSuppliers([]);
      }
    } catch (err) {
      setError(message(err));
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rial = rialFromTomanInput(raw);
  const needsFrom = purpose === "expense" || purpose === "supplier_payment" || purpose === "transfer";
  const needsTo = purpose === "customer_receipt" || purpose === "capital" || purpose === "transfer";
  const needsParty = purpose === "supplier_payment" || purpose === "customer_receipt";
  const ready =
    branch !== null &&
    rial !== null &&
    rial > 0n &&
    (!needsFrom || from !== "") &&
    (!needsTo || to !== "") &&
    (purpose !== "expense" || expenseCode !== "") &&
    (!needsParty || partyId !== "");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy || rial === null || branch === null) return;
    setBusy(true);
    setError(null);
    const body: Parameters<typeof treasury.createTransaction>[0] = {
          branchId: branch.id,
          purpose,
          amount: rial.toString(),
          ...(needsFrom ? { fromAccountId: from } : {}),
          ...(needsTo ? { toAccountId: to } : {}),
          ...(purpose === "expense" ? { expenseAccountCode: expenseCode } : {}),
          ...(needsParty
            ? {
                partyType: purpose === "supplier_payment" ? "supplier" : "customer",
                partyId,
              }
            : {}),
          ...(refNo.trim() === "" ? {} : { refNo: refNo.trim() }),
          ...(memo.trim() === "" ? {} : { note: memo.trim() }),
    };
    const action = actionFor("treasury.tx", body);
    try {
      await treasury.createTransaction(
        body,
        { idempotencyKey: keys.keyFor(action) },
      );
      keys.clear(action);
      setNote("ثبت شد و سندش به دفتر رفت.");
      setRaw("");
      setMemo("");
      setRefNo("");
      await load();
    } catch (err) {
      setError(message(err));
      setNote(null);
    } finally {
      setBusy(false);
    }
  }

  const pick = (kind?: string) =>
    accounts.filter((a) => kind === undefined || a.kind === kind);

  return (
    <div className="stack" style={{ gap: "var(--s-4)" }}>
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

      <Solid as="section" className="pad stack">
        <h3 style={{ fontSize: ".95rem", margin: 0 }}>ثبت حرکت پول</h3>
        <p className="muted small" style={{ margin: 0 }}>
          هر حرکتی که از کشوی صندوق رد شود، به شیفت باز همان شعبه می‌چسبد —
          وگرنه شمارش پایان شیفت مغایرت کاذب می‌دهد. شیفت را سرور پیدا
          می‌کند، نه این صفحه.
        </p>

        <form onSubmit={submit} className="stack">
          <label>
            <span>نوع</span>
            <select
              value={purpose}
              onChange={(e) => {
                setPurpose(e.target.value as Purpose);
                setFrom("");
                setTo("");
                setPartyId("");
              }}
            >
              {(Object.keys(PURPOSE_LABEL) as Purpose[]).map((p) => (
                <option key={p} value={p}>
                  {PURPOSE_LABEL[p]}
                </option>
              ))}
            </select>
          </label>

          <div className="row" style={{ gap: "var(--s-2)", flexWrap: "wrap" }}>
            {needsFrom ? (
              <label style={{ flex: 1, minWidth: "12rem" }}>
                <span>از حساب</span>
                <select value={from} onChange={(e) => setFrom(e.target.value)}>
                  <option value="">انتخاب کنید…</option>
                  {pick().map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({ACCOUNT_KIND[a.kind] ?? a.kind})
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {needsTo ? (
              <label style={{ flex: 1, minWidth: "12rem" }}>
                <span>به حساب</span>
                <select value={to} onChange={(e) => setTo(e.target.value)}>
                  <option value="">انتخاب کنید…</option>
                  {pick()
                    .filter((a) => a.id !== from)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({ACCOUNT_KIND[a.kind] ?? a.kind})
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
          </div>

          {purpose === "expense" ? (
            <label>
              <span>سرفصل هزینه</span>
              <select value={expenseCode} onChange={(e) => setExpenseCode(e.target.value)}>
                <option value="">انتخاب کنید…</option>
                {expenses.map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.code} — {a.name}
                  </option>
                ))}
              </select>
              {expenses.length === 0 ? (
                <small className="muted">
                  سرفصل‌ها بارگذاری نشدند — احتمالاً دسترسی خرید ندارید.
                </small>
              ) : null}
            </label>
          ) : null}

          {purpose === "supplier_payment" ? (
            <label>
              <span>تأمین‌کننده</span>
              <select value={partyId} onChange={(e) => setPartyId(e.target.value)}>
                <option value="">انتخاب کنید…</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {purpose === "customer_receipt" ? (
            <label>
              <span>شناسه مشتری</span>
              <input
                type="text"
                value={partyId}
                onChange={(e) => setPartyId(e.target.value)}
                placeholder="شناسه مشتری"
              />
              <small className="muted">
                تا صفحه مشتریان ساخته شود، شناسه دستی وارد می‌شود.
              </small>
            </label>
          ) : null}

          <div className="row" style={{ gap: "var(--s-2)", flexWrap: "wrap" }}>
            <label style={{ flex: 1, minWidth: "10rem" }}>
              <span>مبلغ (تومان)</span>
              {/* type="text" و نه number — صفحه‌کلید فارسی «۴۸» می‌فرستد */}
              <input
                type="text"
                inputMode="numeric"
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                placeholder="۳۰۰٬۰۰۰"
              />
            </label>
            <label style={{ flex: 1, minWidth: "10rem" }}>
              <span>شماره پیگیری — اختیاری</span>
              <input type="text" value={refNo} onChange={(e) => setRefNo(e.target.value)} />
            </label>
          </div>

          <label>
            <span>شرح</span>
            <input
              type="text"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="کرایه پیک"
            />
          </label>

          {rial !== null && rial > 0n ? (
            <p className="muted small" style={{ margin: 0 }}>
              مبلغ: <span className="num">{toman(rial)}</span> تومان
            </p>
          ) : null}

          <button type="submit" className="btn btn--primary" disabled={!ready || busy}>
            {busy ? "در حال ثبت…" : "ثبت و ارسال به دفتر"}
          </button>
        </form>
      </Solid>

      <Solid as="section" className="pad">
        <h3 style={{ fontSize: ".95rem", marginTop: 0 }}>آخرین حرکت‌ها</h3>
        {rows === null ? (
          <p className="muted" style={{ margin: 0 }}>
            در حال بارگذاری…
          </p>
        ) : rows.length === 0 ? (
          <p className="empty">هنوز حرکتی ثبت نشده.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="grid">
              <thead>
                <tr>
                  <th>تاریخ</th>
                  <th>نوع</th>
                  <th>از / به</th>
                  <th>طرف</th>
                  <th>مبلغ (تومان)</th>
                  <th>شرح</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td>{when(t.occurredAt)}</td>
                    <td>{PURPOSE_LABEL[t.purpose] ?? t.purpose}</td>
                    <td>
                      {t.fromAccountName ?? "—"}
                      {t.toAccountName !== null ? ` ← ${t.toAccountName}` : ""}
                    </td>
                    <td>{t.partyName ?? t.expenseAccountName ?? "—"}</td>
                    <td className="num">{toman(BigInt(t.amount))}</td>
                    <td>{t.note ?? "—"}</td>
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

// ── چک‌ها ────────────────────────────────────────────────────────────

function Cheques() {
  const [rows, setRows] = useState<Cheque[] | null>(null);
  const [accounts, setAccounts] = useState<TreasuryAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [acting, setActing] = useState<{ id: string; action: ChequeAction } | null>(null);
  const [account, setAccount] = useState("");

  const load = useCallback(async () => {
    try {
      const [c, a] = await Promise.all([treasury.cheques(), treasury.accounts()]);
      setRows(c.cheques);
      setAccounts(a.accounts.filter((x) => x.kind === "bank"));
      setError(null);
    } catch (err) {
      setError(message(err));
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(cheque: Cheque, action: ChequeAction, accountId?: string) {
    if (busy !== null) return;
    setBusy(cheque.id);
    setError(null);
    try {
      await treasury.postChequeEvent(cheque.id, {
        action,
        ...(accountId === undefined ? {} : { accountId }),
      });
      setNote(`چک ${cheque.chequeNo}: ${ACTION_LABEL[action]}.`);
      setActing(null);
      setAccount("");
      await load();
    } catch (err) {
      setError(message(err));
      setNote(null);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack" style={{ gap: "var(--s-4)" }}>
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

      <Solid as="section" className="pad">
        <h3 style={{ fontSize: ".95rem", marginTop: 0 }}>چک‌ها</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          چک تا وصول نشود پول نیست: دریافتش فقط بدهی مشتری را به «اسناد
          دریافتنی» منتقل می‌کند. پول واقعی هنگام وصول و به حساب بانکی
          می‌آید، نه به کشو.
        </p>

        {rows === null ? (
          <p className="muted" style={{ margin: 0 }}>
            در حال بارگذاری…
          </p>
        ) : rows.length === 0 ? (
          <p className="empty">هنوز چکی ثبت نشده.</p>
        ) : (
          <ul className="lines">
            {rows.map((c) => {
              const actions = actionsFor(c);
              return (
                <li key={c.id}>
                  <div className="line-name">
                    <strong>
                      {c.direction === "received" ? "دریافتی" : "پرداختی"} ·{" "}
                      <span className="num">{c.chequeNo}</span> · {c.bankName}
                    </strong>
                    <span className="muted small">
                      {c.partyName ?? "—"} · سررسید {when(c.dueOn)} ·{" "}
                      {CHEQUE_STATUS[c.status] ?? c.status}
                      {c.depositAccountName !== null ? ` · ${c.depositAccountName}` : ""}
                    </span>
                  </div>

                  <span className="num line-total">{toman(BigInt(c.amount))}</span>

                  {acting !== null && acting.id === c.id ? (
                    <form
                      className="row"
                      style={{ gap: "var(--s-2)", flexWrap: "wrap" }}
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run(c, acting.action, account === "" ? undefined : account);
                      }}
                    >
                      <select
                        value={account}
                        onChange={(e) => setAccount(e.target.value)}
                        aria-label="حساب بانکی"
                        required
                      >
                        <option value="">حساب بانکی…</option>
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                      <button type="submit" className="btn btn--primary" disabled={busy !== null}>
                        {ACTION_LABEL[acting.action]}
                      </button>
                      <button
                        type="button"
                        className="btn btn--quiet"
                        onClick={() => {
                          setActing(null);
                          setAccount("");
                        }}
                      >
                        انصراف
                      </button>
                    </form>
                  ) : (
                    <div className="row" style={{ gap: "var(--s-2)", flexWrap: "wrap" }}>
                      {actions.length === 0 ? (
                        <span className="muted small">کار دیگری نمانده</span>
                      ) : (
                        actions.map((a) => (
                          <button
                            key={a}
                            type="button"
                            className="btn"
                            disabled={busy !== null}
                            onClick={() => {
                              if (needsAccount(a)) {
                                setActing({ id: c.id, action: a });
                                return;
                              }
                              if (
                                a === "cancel" &&
                                !globalThis.confirm(`چک ${c.chequeNo} باطل شود؟`)
                              ) {
                                return;
                              }
                              void run(c, a);
                            }}
                          >
                            {ACTION_LABEL[a]}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Solid>
    </div>
  );
}

// ── سررسیدها ─────────────────────────────────────────────────────────

function DueList() {
  const [rows, setRows] = useState<ChequeDue[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await treasury.chequeDue();
        if (alive) setRows(r.due);
      } catch (err) {
        if (alive) {
          setError(message(err));
          setRows([]);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Solid as="section" className="pad">
      <h3 style={{ fontSize: ".95rem", marginTop: 0 }}>سررسیدها</h3>
      <p className="muted small" style={{ marginTop: 0 }}>
        ⚠️ هشدار یعنی «برو بانک»، نه اینکه کاری انجام شده باشد. هیچ چیزی
        خودکار چک را وصول نمی‌کند؛ پس از وصول، از زبانه «چک‌ها» ثبتش کنید.
      </p>

      {error !== null ? (
        <p className="pos-alert" role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> {error}
        </p>
      ) : rows === null ? (
        <p className="muted" style={{ margin: 0 }}>
          در حال بارگذاری…
        </p>
      ) : rows.length === 0 ? (
        <p className="empty">چکی در راه نیست.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="grid">
            <thead>
              <tr>
                <th>وضعیت سررسید</th>
                <th>سررسید</th>
                <th>چک</th>
                <th>بانک</th>
                <th>طرف</th>
                <th>مبلغ (تومان)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Urgency level={c.urgency} />
                  </td>
                  <td>{when(c.dueOn)}</td>
                  <td className="num">{c.chequeNo}</td>
                  <td>{c.bankName}</td>
                  <td>{c.partyName ?? "—"}</td>
                  <td className="num">{toman(BigInt(c.amount))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Solid>
  );
}
