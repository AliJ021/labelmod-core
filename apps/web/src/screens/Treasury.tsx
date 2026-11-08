import { AmountInput } from "../components/ui/AmountInput.tsx";
import { routeUrl } from "../lib/navigation.ts";
import { useUrlState, useUrlTab } from "../lib/use-url-state.ts";

const PURPOSES = ["supplier_payment", "customer_receipt", "expense", "capital", "transfer"] as const;
import { TabList, TabPanels, useTabsId } from "../components/Tabs.tsx";
import { Icon } from "../components/Icon.tsx";
import { Note } from "../components/ui/Note.tsx";
import { SectionHeader } from "../components/ui/PageHeader.tsx";
import { StatusBadge, type StatusState } from "../components/ui/Status.tsx";
import { DataTable } from "../components/ui/DataTable.tsx";
import { Kpi } from "../components/ui/Kpi.tsx";
import { Money } from "../components/ui/Money.tsx";
import { formatQty } from "../lib/format.ts";
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
import { TreasuryBalances } from "../components/TreasuryBalances.tsx";
import { TreasuryDesk, TreasuryTerminals } from "../components/TreasuryDesk.tsx";
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
  type ChequeDueTotals,
  type Purpose,
  type TreasuryAccount,
  type TreasuryTransaction,
} from "../lib/treasury.ts";

/** نگاشت وضعیت چک به زبان واحد وضعیت؛ برچسب کسب‌وکاری همان `CHEQUE_STATUS` است. */
const CHEQUE_TONE: Record<string, StatusState> = {
  draft: "draft", in_hand: "pending", deposited: "active", endorsed: "completed", issued: "pending",
  cleared: "completed", bounced: "attention", settled: "warning", cancelled: "cancelled",
};

const TABS = [
  { key: "cash", label: "حرکت پول" },
  { key: "cheques", label: "چک‌ها" },
  { key: "due", label: "سررسیدها" },
] as const;
/** آیکون تزئینی زبانه‌ها (طرح ۱۰). */
const TAB_ITEMS = TABS.map(t => ({ ...t, icon: <Icon name={t.key === "cash" ? "wallet" : t.key === "cheques" ? "doc" : "calendar"} size="sm" /> }));


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
    level === "overdue" ? "crit" : level === "today" || level === "soon" || level === "due_soon" ? "warn" : "good";
  // ⚠️ نمای سرور `due_soon` می‌فرستد؛ پیش‌تر فقط `soon` شناخته می‌شد و چک نزدیک سررسید «آینده» و سبز دیده می‌شد.
  const label =
    level === "overdue"
      ? "گذشته"
      : level === "today"
        ? "امروز"
        : level === "soon" || level === "due_soon"
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
  const [tab, setTab] = useUrlTab("treasury.tab", TABS, "cash");

  return (
    <div className="stack" style={{ gap: "var(--s-4)" }}>
      <TabList hrefFor={key => routeUrl("treasury", key)} id={tabsId} items={TAB_ITEMS} value={tab} onChange={setTab} label="بخش‌های خزانه" />
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
  /** پس از هر حرکت تازه، کشوها و حرکت‌های امروز دوباره از سرور خوانده می‌شوند. */
  const [deskVersion, setDeskVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // نوع حرکت در نشانی هم می‌نشیند تا «دریافت از مشتری» داشبورد مستقیم همین فرم را با همین نوع باز کند.
  // مقدار ناشناختهٔ نشانی «هزینه» خوانده می‌شود، نه یک نوع ساختگی.
  const [purposeParam, setPurposeParam] = useUrlState("treasury.purpose", "expense", true);
  const purpose: Purpose = (PURPOSES as readonly string[]).includes(purposeParam) ? purposeParam as Purpose : "expense";
  const setPurpose = (next: Purpose) => setPurposeParam(next);
  const [raw, setRaw] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [expenseCode, setExpenseCode] = useState("");
  const [partyId, setPartyId] = useState("");
  const [refNo, setRefNo] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [keys] = useState(() => new ActionKeys());
  // طرح ۱۰: فهرست اول است و فرم با «حرکت پول تازه» باز می‌شود؛ پیوندی که نوع را در نشانی دارد
  // (کار پرتکرار «دریافت از مشتری») فرم را باز می‌آورد.
  const [formOpen, setFormOpen] = useState(() => new URLSearchParams(window.location.search).has("treasury.purpose"));

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
      setDeskVersion(v => v + 1);
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
      <TreasuryBalances />
      <TreasuryDesk branchId={branch?.id ?? null} version={deskVersion} />
      {note !== null ? (
        <p className="solid pos-alert" role="status">
          <span className="dot dot--good" aria-hidden="true">●</span> {note}
        </p>
      ) : null}

      <Solid as="section" className="list-card" aria-labelledby="treasury-moves">
        <SectionHeader id="treasury-moves" title="آخرین حرکت‌های پول"
          description="هر حرکتی که از کشوی صندوق رد شود به شیفت باز همان شعبه می‌چسبد؛ وگرنه شمارش پایان شیفت مغایرت کاذب می‌دهد. شیفت را سرور پیدا می‌کند، نه این صفحه."
          actions={<button type="button" className="btn btn--primary" aria-expanded={formOpen} aria-controls="treasury-move-form" onClick={() => setFormOpen(v => !v)}>
            <Icon name={formOpen ? "close" : "plus"} size="sm" />{formOpen ? "بستن فرم" : "حرکت پول تازه"}</button>} />

        {formOpen ? <form id="treasury-move-form" onSubmit={submit} className="stack list-card-form" aria-label="ثبت حرکت پول">
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
              <AmountInput
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
        </form> : null}

        {rows === null ? (
          <p className="muted">در حال بارگذاری…</p>
        ) : rows.length === 0 ? (
          <p className="empty">هنوز حرکتی ثبت نشده.</p>
        ) : (
          <div className="scroll-x">
            <table className="grid">
              <thead>
                <tr>
                  <th>تاریخ</th>
                  <th>نوع</th>
                  <th>از / به</th>
                  <th>طرف</th>
                  <th className="num">مبلغ (تومان)</th>
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
      <TreasuryTerminals accounts={accounts} />
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
  // فیلتر جهت فقط نمایش است؛ همان فهرستی که سرور داده، نه درخواست تازه.
  const [direction, setDirection] = useState<"all" | "received" | "issued">("all");
  const shown = (rows ?? []).filter(c => direction === "all" || (direction === "received" ? c.direction === "received" : c.direction !== "received"));

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

      <Note>چک تا وصول نشود پول نیست: دریافتش فقط بدهی مشتری را به «اسناد دریافتنی» منتقل می‌کند. پول واقعی هنگام وصول و به حساب بانکی می‌آید، نه به کشو. وضعیت فقط با ثبت رویداد عوض می‌شود.</Note>
      <div className="filter-chips" role="group" aria-label="جهت چک">
        {(["all", "received", "issued"] as const).map(d => <button key={d} type="button" aria-pressed={direction === d} onClick={() => setDirection(d)}>
          {d === "all" ? "همه" : d === "received" ? "دریافتی" : "پرداختی"}</button>)}
      </div>

      <Solid as="section" className="list-card" aria-labelledby="treasury-cheques">
        <SectionHeader id="treasury-cheques" title="چک‌ها" description="سررسید و وضعیت از سرور می‌آیند؛ هر دکمه فقط یک رویداد می‌فرستد." />
        {rows === null ? (
          <p className="muted">در حال بارگذاری…</p>
        ) : shown.length === 0 ? (
          <p className="empty">{rows.length === 0 ? "هنوز چکی ثبت نشده." : "چکی با این جهت نیست."}</p>
        ) : (
          <div className="scroll-x"><table className="grid cheque-table">
            <caption className="sr-only">چک‌ها؛ مبلغ‌ها به تومان</caption>
            <thead><tr><th>شمارهٔ چک</th><th>جهت</th><th>طرف</th><th>سررسید</th><th className="num">مبلغ (تومان)</th><th>وضعیت</th><th>عملیات</th></tr></thead>
            <tbody>
            {shown.map((c) => {
              const actions = actionsFor(c);
              return (
                <tr key={c.id}>
                  <td><span className="num">{c.chequeNo}</span><small>{c.bankName}</small></td>
                  <td>{c.direction === "received" ? "دریافتی" : "پرداختی"}</td>
                  <td>{c.partyName ?? "—"}{c.depositAccountName !== null ? <small>{c.depositAccountName}</small> : null}</td>
                  {/* طرح ۱۰: «سررسیدگذشته» / «نزدیک سررسید» از `urgency` سرور، نه مقایسه با ساعت مرورگر. */}
                  <td>{when(c.dueOn)}{c.urgency === "overdue" ? <small className="cheque-urgency" data-urgency="overdue">سررسیدگذشته</small>
                    : c.urgency === "due_soon" ? <small className="cheque-urgency" data-urgency="due_soon">نزدیک سررسید</small> : null}</td>
                  <td className="num">{toman(BigInt(c.amount))}</td>
                  <td><StatusBadge state={CHEQUE_TONE[c.status] ?? "unknown"} label={CHEQUE_STATUS[c.status] ?? c.status} /></td>
                  <td>
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
                  </td>
                </tr>
              );
            })}
            </tbody>
          </table></div>
        )}
      </Solid>
    </div>
  );
}

// ── سررسیدها ─────────────────────────────────────────────────────────

function DueList() {
  const [rows, setRows] = useState<ChequeDue[] | null>(null);
  const [totals, setTotals] = useState<ChequeDueTotals | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await treasury.chequeDue();
        if (alive) { setRows(r.due); setTotals(r.totals ?? null); }
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
    <div className="stack" style={{ gap: "var(--s-4)" }}>
    <Note tone="warn">هشدار یعنی «برو بانک»، نه اینکه کاری انجام شده باشد. هیچ چیزی خودکار چک را وصول نمی‌کند؛ پس از وصول، از زبانه «چک‌ها» ثبتش کنید.</Note>
    {/* طرح ۱۰: سه کارت از جمع SQL همان چک‌های فهرست (و همان دامنهٔ شعبه)؛ پاسخ قدیمی‌تر بی جمع، کارتی نمی‌سازد. */}
    {totals ? <section className="kpis kpi-cards cheque-due-summary" aria-label="جمع سررسیدها">
      <Kpi variant="card" icon="wallet" label="دریافتی باز" value={<Money rial={totals.received} size="lg" />} note={`${formatQty(String(totals.receivedCount))} چک دریافتی`} />
      <Kpi variant="card" icon="external" label="پرداختی باز" value={<Money rial={totals.issued} size="lg" />} note={`${formatQty(String(totals.issuedCount))} چک پرداختی`} />
      <Kpi variant="card" icon="chart" label="خالص سررسیدها" value={<Money rial={totals.net} size="lg" />} note="دریافتی منهای پرداختی، شامل چک برگشتیِ در انتظار" />
    </section> : null}
    <Solid as="section" className="list-card" aria-labelledby="treasury-due">
      <SectionHeader id="treasury-due" title="تقویم سررسید" description="به ترتیب تاریخ؛ «امروز» و «گذشته» را سرور با تاریخ کاری فروشگاه تعیین می‌کند." />

      {error !== null ? (
        <p className="pos-alert" role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> {error}
        </p>
      ) : (
        <DataTable<ChequeDue> caption="تقویم سررسید چک‌ها؛ مبلغ‌ها به تومان" stack loading={rows === null} rows={rows ?? []} rowKey={(c) => c.id}
          empty={{ title: "چکی در راه نیست." }}
          columns={[
            { key: "date", header: "تاریخ", cell: (c) => <span className="cell-stack"><span>{when(c.dueOn)}</span>
              <small className="muted"><Urgency level={c.urgency} />{typeof c.daysLeft === "number" ? ` · ${c.daysLeft < 0 ? `${formatQty(String(-c.daysLeft))} روز گذشته` : c.daysLeft === 0 ? "امروز" : `${formatQty(String(c.daysLeft))} روز مانده`}` : ""}</small></span> },
            // جهت وضعیت نیست؛ پس متن ساده، نه نشان وضعیت.
            { key: "direction", header: "جهت", cell: (c) => c.direction === "received" ? "دریافتی" : "پرداختی" },
            { key: "party", header: "طرف", cell: (c) => c.partyName ?? "—" },
            { key: "cheque", header: "چک", cell: (c) => <span className="cell-stack"><span className="num">{c.chequeNo}</span><small className="muted">{c.bankName}</small></span> },
            { key: "amount", header: "مبلغ", numeric: true, cell: (c) => <Money rial={c.amount} unit={false} /> },
            { key: "status", header: "وضعیت", cell: (c) => CHEQUE_STATUS[c.status] ?? c.status },
          ]}
          {...(totals && rows && rows.length ? { foot: { label: "خالص (دریافتی منهای پرداختی)", cells: { amount: <Money rial={totals.net} unit={false} /> } } } : {})} />
      )}
    </Solid>
    </div>
  );
}
