/**
 * برگشت از خرید — کالایی که به تأمین‌کننده پس فرستاده می‌شود.
 *
 * ── جریان ─────────────────────────────────────────────────────────
 *
 *   شماره رسید → اقلام باقی‌مانده → انتخاب تعداد → علت → ثبت
 *
 * ── دو عددی که این صفحه کنار هم نشان می‌دهد و اکثر سیستم‌ها نه ──────
 *
 * **بهای فاکتور** آنچه تأمین‌کننده گرفته؛ بدهی‌اش به همین اندازه کم
 * می‌شود.
 *
 * **بهای دفتری** آنچه کالا در انبار ما ارزیده — بهای فاکتور به‌علاوه
 * سهمش از هزینه حمل.
 *
 * تفاوتشان حملی است که برای کالای پس‌فرستاده پرداختیم و باربری
 * برنمی‌گرداند. یک زیان واقعی، و انباردار باید **پیش از ثبت** ببیندش:
 * گاهی همین عدد تصمیم را عوض می‌کند.
 *
 * ── آنچه این صفحه حساب نمی‌کند ────────────────────────────────────
 *
 * `remainingQty` و بهای دفتری هر دو از سرور می‌آیند. تفریق در مرورگر
 * یعنی دو تعریف از یک عدد — و آنکه در مرورگر است، کهنه می‌شود.
 */
import { useEffect, useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { SectionHeader } from "../components/ui/PageHeader.tsx";
import { DataTable, type Column } from "../components/ui/DataTable.tsx";
import { Money } from "../components/ui/Money.tsx";
import { Note } from "../components/ui/Note.tsx";
import { StatusBadge } from "../components/ui/Status.tsx";
import { Icon } from "../components/Icon.tsx";
import { formatJalaliMoment, formatQty } from "../lib/format.ts";
import { ApiError } from "../lib/api.ts";
import { ActionKeys, actionFor } from "../lib/action-key.ts";
import { parseRial, toman } from "../lib/money.ts";
import { pos, type Branch, type ReturnReason } from "../lib/pos.ts";
import {
  purchaseReturns,
  purchasing,
  type PurchaseReturn as Sheet,
  type PurchaseReturnSummary,
  type Returnable,
} from "../lib/purchasing.ts";

function message(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "ارتباط با سرور برقرار نشد.";
}

/**
 * طرح ۱۰: فهرست برگه‌ها. هر سه مبلغ همان ستون‌هایی‌اند که `post_purchase_return()` نوشته:
 * بهای فاکتور (کاهش بدهی تأمین‌کننده)، ارزش دفتری (خروج از موجودی) و حمل برنگشتنی (زیان).
 */
const RETURN_COLUMNS: readonly Column<PurchaseReturnSummary>[] = [
  { key: "number", header: "برگه", cell: (r) => <span className="cell-stack"><span className="num">{r.number ?? "—"}</span><small className="muted">{formatJalaliMoment(r.occurredAt)}</small></span> },
  { key: "supplier", header: "تأمین‌کننده", cell: (r) => <span className="cell-stack"><span>{r.supplierName}</span>{r.receiptNumber ? <small className="muted">رسید <span className="num">{r.receiptNumber}</span></small> : null}</span> },
  { key: "item", header: "کالا", cell: (r) => r.firstItem ? `${r.firstItem}${r.lineCount > 1 ? ` و ${formatQty(String(r.lineCount - 1))} قلم دیگر` : ""}` : "—" },
  { key: "qty", header: "تعداد", numeric: true, cell: (r) => <span className="num">{formatQty(r.totalQty)}</span> },
  { key: "goods", header: "بهای فاکتور", numeric: true, cell: (r) => <Money rial={r.goodsAmount} unit={false} /> },
  { key: "cost", header: "ارزش دفتری", numeric: true, cell: (r) => <Money rial={r.costAmount} unit={false} /> },
  { key: "loss", header: "حمل برنگشتنی", numeric: true, cell: (r) => r.chargeLoss === "0" ? <span className="muted">—</span> : <Money rial={r.chargeLoss} unit={false} /> },
  { key: "status", header: "وضعیت", cell: (r) => <StatusBadge state={r.status === "posted" ? "completed" : r.status === "draft" ? "draft" : "cancelled"}
    label={r.status === "posted" ? "ثبت‌شده" : r.status === "draft" ? "پیش‌نویس" : "باطل"} /> },
];

export function PurchaseReturn() {
  const [list, setList] = useState<PurchaseReturnSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listVersion, setListVersion] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    setListError(null);
    purchaseReturns.list().then((r) => { if (alive) setList(r.returns); }, (err: unknown) => { if (alive) setListError(message(err)); });
    return () => { alive = false; };
  }, [listVersion]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("");
  const [reasons, setReasons] = useState<ReturnReason[]>([]);

  const [number, setNumber] = useState("");
  const [source, setSource] = useState<Returnable | null>(null);
  const [picked, setPicked] = useState<Map<string, number>>(new Map());
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [posted, setPosted] = useState<Sheet | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keys] = useState(() => new ActionKeys());

  useEffect(() => {
    void (async () => {
      try {
        const [b, r] = await Promise.all([pos.branches(), pos.returnReasons()]);
        setBranches(b.branches);
        setBranchId(b.branches[0]?.id ?? "");
        setReasons(r.reasons);
      } catch (err) {
        setError(message(err));
      }
    })();
  }, []);

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

  /**
   * یافتن رسید از روی شماره.
   *
   * جست‌وجو **سمت سرور** است، نه فیلتر روی فهرست: فهرست رسیدها سقف
   * دارد و فقط تازه‌ترین‌ها را می‌دهد. برگشت از خریدی که سه ماه پیش
   * رسید شده، با فیلتر مرورگر هرگز پیدا نمی‌شد.
   */
  const lookup = () =>
    guarded(async () => {
      setPosted(null);
      const receipt = await purchasing.receiptByNumber(number.trim(), branchId);
      const view = await purchaseReturns.returnable(receipt.id);
      setSource(view);
      setPicked(new Map());
    });

  function setQty(receiptLineId: string, qty: number) {
    const line = source?.lines.find((l) => l.receiptLineId === receiptLineId);
    if (!line) return;
    const max = Math.floor(Number(line.remainingQty));
    const next = new Map(picked);
    next.set(receiptLineId, Math.max(0, Math.min(Math.floor(qty), max)));
    setPicked(next);
  }

  const chosen = (source?.lines ?? []).filter((l) => (picked.get(l.receiptLineId) ?? 0) > 0);

  /**
   * پیش‌نمای دو مبلغ.
   *
   * این‌ها **پیشنهاد** نیستند، محاسبه‌اند: هر دو نرخ Snapshot سطر
   * رسیدند و سرور با همان‌ها ثبت می‌کند. اگر روزی از هم جدا افتادند،
   * یعنی جایی نرخ جاری جای نرخ رسید نشسته.
   */
  const goods = chosen.reduce(
    (a, l) => a + parseRial(l.unitPrice) * BigInt(picked.get(l.receiptLineId) ?? 0),
    0n,
  );
  const cost = chosen.reduce(
    (a, l) => a + parseRial(l.landedUnitCost) * BigInt(picked.get(l.receiptLineId) ?? 0),
    0n,
  );

  const submit = () =>
    guarded(async () => {
      if (!source) return;
      const body = {
        receiptId: source.receiptId,
        reasonCode: reason,
        lines: chosen.map((l) => ({
          receiptLineId: l.receiptLineId,
          qty: String(picked.get(l.receiptLineId) ?? 0),
        })),
        ...(note.trim() === "" ? {} : { reasonNote: note.trim() }),
      };
      // نام عمل از بدنه ساخته می‌شود: Retry همان کلید را می‌برد، ولی
      // اگر انباردار پس از یک شکست تعداد را اصلاح کند، کلید تازه
      // می‌گیرد به‌جای ۴۰۹.
      const sheet = await keys.run(actionFor("purchase-return", body), (key) =>
        purchaseReturns.create(body, { idempotencyKey: key }),
      );
      setPosted(sheet);
      setListVersion((v) => v + 1);
      setSource(null);
      setPicked(new Map());
      setNumber("");
      setReason("");
      setNote("");
    });

  const ready = source !== null && chosen.length > 0 && reason !== "";

  return (
    <div className="stack" style={{ gap: "var(--s-4)" }}>
      <Solid as="section" className="list-card" aria-labelledby="pret-title">
        <SectionHeader id="pret-title" title="برگشت از خرید"
          description={<>بدهی تأمین‌کننده با بهای فاکتور کم می‌شود و کالا با بهای <strong>همان رسید</strong> خارج می‌شود، نه میانگین جاری انبار.</>}
          actions={<button type="button" className="btn btn--primary" aria-expanded={formOpen} aria-controls="pret-new-form" onClick={() => setFormOpen(v => !v)}>
            <Icon name={formOpen ? "close" : "plus"} size="sm" />{formOpen ? "بستن فرم" : "برگشت تازه"}</button>} />
        {formOpen ? <div id="pret-new-form" className="list-card-body" role="group" aria-label="برگشت تازه">

        {branches.length > 1 ? (
          <div className="stack" style={{ gap: "var(--s-2)", marginBottom: "var(--s-3)" }}>
            {branches.map((b) => (
              <button
                key={b.id}
                type="button"
                className={b.id === branchId ? "btn btn--primary" : "btn"}
                onClick={() => setBranchId(b.id)}
              >
                {b.name}
              </button>
            ))}
          </div>
        ) : null}

        <form
          className="stack list-card-form"
          style={{ gap: "var(--s-3)" }}
          onSubmit={(e) => {
            e.preventDefault();
            void lookup();
          }}
        >
          <Solid className="auth-field">
            <label htmlFor="pret-no">شماره رسید خرید</label>
            <input
              id="pret-no"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="P-1405-000012"
              autoComplete="off"
            />
          </Solid>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={busy || number.trim() === ""}
          >
            {busy ? "…" : "پیدا کن"}
          </button>
        </form>
        </div> : null}
        {listError ? <p className="list-card-body" role="alert">{listError}</p>
          : <DataTable<PurchaseReturnSummary> caption="برگه‌های برگشت از خرید؛ مبلغ‌ها به تومان" stack loading={list === null}
              rows={list ?? []} rowKey={(r) => r.id} columns={RETURN_COLUMNS}
              empty={{ title: "هنوز برگشتی ثبت نشده.", description: "برای برگشت کالا به تأمین‌کننده، «برگشت تازه» را بزنید و شمارهٔ رسید خرید را وارد کنید." }} />}
        {list?.length ? <div className="list-card-body"><Note>بهای فاکتور بدهی تأمین‌کننده را کم می‌کند و ارزش دفتری از موجودی خارج می‌شود؛ تفاوتشان حملی است که برای کالای پس‌فرستاده پرداخت شده و برنمی‌گردد و زیان ثبت می‌شود.</Note></div> : null}
      </Solid>

      {error ? (
        <p className="solid pos-alert" role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> {error}
        </p>
      ) : null}

      {posted ? (
        <Solid as="section" className="pad stack" style={{ gap: "var(--s-2)" }}>
          <p className="pos-alert" role="status" style={{ margin: 0 }}>
            <span className="dot dot--good" aria-hidden="true">●</span> برگ برگشت{" "}
            {posted.number} ثبت شد.
          </p>
          <div className="total">
            <span>کاهش بدهی تأمین‌کننده</span>
            <span className="num total-value">{toman(parseRial(posted.goodsAmount))}</span>
          </div>
          <div className="total">
            <span>کاهش ارزش موجودی</span>
            <span className="num total-value">{toman(parseRial(posted.costAmount))}</span>
          </div>
          {parseRial(posted.chargeLoss) !== 0n ? (
            <div className="total">
              <span>حملِ برنگشتنی (زیان)</span>
              <span className="num total-value">{toman(parseRial(posted.chargeLoss))}</span>
            </div>
          ) : null}
        </Solid>
      ) : null}

      {source ? (
        <>
          <Solid as="section" className="pad">
            <h3 style={{ marginTop: 0 }}>
              رسید {source.number} — {source.supplierName}
            </h3>
            <p className="muted small" style={{ marginTop: 0 }}>
              انبار {source.warehouseName}
            </p>
            <ul className="lines">
              {source.lines.map((l) => {
                const max = Math.floor(Number(l.remainingQty));
                const qty = picked.get(l.receiptLineId) ?? 0;
                return (
                  <li key={l.receiptLineId}>
                    <div className="line-name">
                      <strong>{l.productName}</strong>
                      <span className="muted small">
                        {l.sku}
                        {l.color ? ` · ${l.color}` : ""}
                        {l.size ? ` · ${l.size}` : ""} · رسیدشده {Number(l.receivedQty)}
                        {Number(l.returnedQty) > 0
                          ? ` · قبلاً برگشته ${Number(l.returnedQty)}`
                          : ""}
                      </span>
                      {/* دو نرخ کنار هم — تفاوتشان سهم حمل است. */}
                      <span className="muted small">
                        فاکتور {toman(parseRial(l.unitPrice))} · دفتری{" "}
                        {toman(parseRial(l.landedUnitCost))}
                      </span>
                    </div>
                    <div className="qty">
                      <button
                        type="button"
                        onClick={() => setQty(l.receiptLineId, qty - 1)}
                        disabled={busy || qty <= 0}
                        aria-label={`کم کردن ${l.productName}`}
                      >
                        −
                      </button>
                      <span className="num" aria-live="polite">{qty}</span>
                      <button
                        type="button"
                        onClick={() => setQty(l.receiptLineId, qty + 1)}
                        disabled={busy || qty >= max}
                        aria-label={`اضافه کردن ${l.productName}`}
                      >
                        +
                      </button>
                    </div>
                    <span className="num line-total">
                      {max === 0 ? "کاملاً برگشته" : `حداکثر ${max}`}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Solid>

          <Solid as="section" className="pad stack" style={{ gap: "var(--s-3)" }}>
            <h3 style={{ margin: 0 }}>علت و جمع</h3>

            <label className="auth-field">
              <span>علت برگشت</span>
              {/* همان فهرست بسته مرجوعی فروش — از `platform.setting`. */}
              <select value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="">— انتخاب کنید —</option>
                {reasons.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="auth-field">
              <span>توضیح (اختیاری)</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} />
            </label>

            <div className="total">
              <span>کاهش بدهی تأمین‌کننده</span>
              <span className="num total-value">{toman(goods)}</span>
            </div>
            <div className="total">
              <span>کاهش ارزش موجودی</span>
              <span className="num total-value">{toman(cost)}</span>
            </div>
            {cost !== goods ? (
              <p className="muted small" style={{ margin: 0 }}>
                <span className="dot dot--warn" aria-hidden="true">●</span> تفاوت{" "}
                <span className="num">{toman(cost > goods ? cost - goods : goods - cost)}</span>{" "}
                تومان، سهم حمل این کالاست. باربری آن را برنمی‌گرداند و به‌عنوان زیان ثبت
                می‌شود.
              </p>
            ) : null}

            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || !ready}
              onClick={() => void submit()}
            >
              {busy ? "…" : "ثبت برگشت"}
            </button>
          </Solid>
        </>
      ) : null}
    </div>
  );
}
