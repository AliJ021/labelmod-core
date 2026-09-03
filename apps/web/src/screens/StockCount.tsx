/**
 * انبارگردانی — شمارش قفسه و تطبیقش با موجودی.
 *
 * ── چیزی که این صفحه عمداً نشان **نمی‌دهد** ────────────────────────
 *
 * **موجودی سیستم، پیش از ثبت.**
 *
 * این وسوسه‌انگیزترین ستون ممکن است و بدترین. اگر انباردار عدد سیستم
 * را کنار عدد شمارش ببیند، دیگر نمی‌شمارد — عدد سیستم را تأیید
 * می‌کند. انبارگردانی دقیقاً برای پیدا کردن جایی است که سیستم اشتباه
 * می‌گوید؛ نشان‌دادن جوابِ سیستم، خودِ آزمون را بی‌اثر می‌کند.
 *
 * دلیل فنی هم دارد: آن عدد در لحظه ثبت خوانده می‌شود، نه حالا. عددی
 * که روی صفحه بنشیند تا لحظه ثبت کهنه می‌شود.
 *
 * پس تفاوت **پس از ثبت** دیده می‌شود، و همان‌جا کامل است: چه چیزی
 * کم بود، چقدر، و به چه ارزشی.
 *
 * ── شمارش مطلق است ────────────────────────────────────────────────
 *
 * اسکن دوباره همان کالا یعنی «دوباره شمردم و این عدد است». اگر جمع
 * می‌شد، هر بازبینی عدد را دو برابر می‌کرد.
 */
import { useEffect, useState } from "react";
import { Glass, Solid } from "../components/Glass.tsx";
import { ApiError } from "../lib/api.ts";
import { ActionKeys, actionFor } from "../lib/action-key.ts";
import { parseRial, toman } from "../lib/money.ts";
import { pos, type Branch } from "../lib/pos.ts";
import {
  RECEIPT_STATUS,
  stockCounts,
  type StockCount as Sheet,
  type StockCountSummary,
} from "../lib/purchasing.ts";

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

export function StockCount() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");

  const [list, setList] = useState<StockCountSummary[]>([]);
  const [sheet, setSheet] = useState<Sheet | null>(null);

  const [barcode, setBarcode] = useState("");
  const [qty, setQty] = useState("1");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [keys] = useState(() => new ActionKeys());

  const branch = branches.find((b) => b.id === branchId) ?? null;
  const editable = sheet !== null && sheet.status === "draft";

  useEffect(() => {
    void (async () => {
      try {
        const b = await pos.branches();
        setBranches(b.branches);
        const first = b.branches[0];
        if (first) {
          setBranchId(first.id);
          setWarehouseId(first.warehouses[0]?.id ?? "");
        }
        setList(await stockCounts.list());
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

  const refreshList = async () => setList(await stockCounts.list());

  const start = () =>
    guarded(async () => {
      setDone(null);
      const body = { branchId, warehouseId };
      const fresh = await keys.run(actionFor("count", body), (key) =>
        stockCounts.create(body, { idempotencyKey: key }),
      );
      setSheet(fresh);
      await refreshList();
    });

  const open = (id: string) =>
    guarded(async () => {
      setDone(null);
      setSheet(await stockCounts.get(id));
    });

  const count = () =>
    guarded(async () => {
      if (!sheet) return;
      // مطلق است، پس نه کلید Idempotency لازم دارد نه نگرانی از Retry.
      setSheet(
        await stockCounts.setLine(sheet.id, {
          barcode: barcode.trim(),
          countedQty: qty.trim(),
        }),
      );
      setBarcode("");
      setQty("1");
    });

  const removeLine = (lineId: string) =>
    guarded(async () => {
      if (!sheet) return;
      setSheet(await stockCounts.removeLine(sheet.id, lineId));
    });

  const post = () =>
    guarded(async () => {
      if (!sheet) return;
      const posted = await keys.run(`count-post:${sheet.id}`, (key) =>
        stockCounts.post(sheet.id, { idempotencyKey: key }),
      );
      setSheet(posted);
      const diffs = posted.lines.filter((l) => Number(l.diffQty ?? 0) !== 0).length;
      setDone(
        diffs === 0
          ? `برگه ${posted.number ?? ""} ثبت شد — هیچ تفاوتی نبود.`
          : `برگه ${posted.number ?? ""} ثبت شد — ${diffs} قلم تفاوت داشت.`,
      );
      await refreshList();
    });

  const cancel = () =>
    guarded(async () => {
      if (!sheet) return;
      setSheet(await stockCounts.cancel(sheet.id));
      await refreshList();
    });

  const netValue = (sheet?.lines ?? []).reduce(
    (a, l) => a + (l.valueDelta === null ? 0n : parseRial(l.valueDelta)),
    0n,
  );

  return (
    <div className="stack" style={{ gap: "var(--s-4)" }}>
      <Glass as="section" className="pad" live>
        <h2 style={{ marginTop: 0 }}>انبارگردانی</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          قفسه را بشمارید و عدد را وارد کنید. موجودی سیستم عمداً نشان داده نمی‌شود —
          انبارگردانی برای پیدا کردن جایی است که سیستم اشتباه می‌گوید.
        </p>

        <div className="stack" style={{ gap: "var(--s-3)" }}>
          {branches.length > 1 ? (
            <label className="auth-field">
              <span>شعبه</span>
              <select
                value={branchId}
                onChange={(e) => {
                  setBranchId(e.target.value);
                  const b = branches.find((x) => x.id === e.target.value);
                  setWarehouseId(b?.warehouses[0]?.id ?? "");
                }}
              >
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="auth-field">
            <span>کدام انبار شمرده می‌شود</span>
            <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              {(branch?.warehouses ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || warehouseId === ""}
            onClick={() => void start()}
          >
            {busy ? "…" : "برگه شمارش تازه"}
          </button>
        </div>
      </Glass>

      {error ? (
        <p className="solid pos-alert" role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> {error}
        </p>
      ) : null}
      {done ? (
        <p className="solid pos-alert" role="status">
          <span className="dot dot--good" aria-hidden="true">●</span> {done}
        </p>
      ) : null}

      {sheet ? (
        <Solid as="section" className="pad stack" style={{ gap: "var(--s-3)" }}>
          <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
            <h3 style={{ margin: 0, flex: "1 1 auto" }}>
              {sheet.number ?? "برگه بی‌شماره"} — انبار {sheet.warehouseName}
            </h3>
            <span className="chip">{RECEIPT_STATUS[sheet.status] ?? sheet.status}</span>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            شروع {shortDate(sheet.startedAt)} · {sheet.lines.length} قلم شمرده شده
          </p>

          {editable ? (
            <form
              className="stack"
              style={{ gap: "var(--s-2)" }}
              onSubmit={(e) => {
                e.preventDefault();
                void count();
              }}
            >
              <span className="muted small">
                بارکد را اسکن کنید و تعداد شمرده‌شده را بنویسید
              </span>
              <div className="rcpt-add">
                <input
                  value={barcode}
                  onChange={(e) => setBarcode(e.target.value)}
                  placeholder="بارکد"
                  autoComplete="off"
                  aria-label="بارکد"
                />
                {/* `type="text"` نه `type="number"`: صفحه‌کلید فارسی «۴۸»
                    می‌فرستد و ورودی عددی مرورگر آن را دور می‌اندازد. */}
                <input
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  inputMode="decimal"
                  placeholder="تعداد"
                  aria-label="تعداد شمرده‌شده"
                />
                <button
                  type="submit"
                  className="btn btn--primary"
                  disabled={busy || barcode.trim() === ""}
                >
                  ثبت شمارش
                </button>
              </div>
              <p className="muted small" style={{ margin: 0 }}>
                اسکن دوباره همان کالا، عدد را <strong>جایگزین</strong> می‌کند نه اینکه
                جمع بزند. صفر هم یک شمارش است: «گشتیم و نبود».
              </p>
            </form>
          ) : null}

          {sheet.lines.length === 0 ? (
            <p className="empty">هنوز چیزی شمرده نشده.</p>
          ) : (
            <ul className="lines">
              {sheet.lines.map((l) => {
                const diff = l.diffQty === null ? null : Number(l.diffQty);
                return (
                  <li key={l.id}>
                    <div className="line-name">
                      <strong>{l.productName}</strong>
                      <span className="muted small">
                        {l.sku}
                        {l.color ? ` · ${l.color}` : ""}
                        {l.size ? ` · ${l.size}` : ""}
                      </span>
                    </div>
                    <span className="num">شمارش {Number(l.countedQty)}</span>
                    {/* پیش از ثبت هیچ عددی از سیستم نشان داده نمی‌شود. */}
                    {diff === null ? (
                      <span className="muted small">—</span>
                    ) : diff === 0 ? (
                      <span className="cnt-ok">
                        <span aria-hidden="true">●</span> می‌خواند
                      </span>
                    ) : diff < 0 ? (
                      <span className="cnt-short">
                        <span aria-hidden="true">▼</span> کسری {Math.abs(diff)}
                      </span>
                    ) : (
                      <span className="cnt-over">
                        <span aria-hidden="true">▲</span> اضافه {diff}
                      </span>
                    )}
                    <span className="num line-total">
                      {l.valueDelta === null ? "" : toman(parseRial(l.valueDelta))}
                    </span>
                    {editable ? (
                      <button
                        type="button"
                        className="line-drop"
                        onClick={() => void removeLine(l.id)}
                        disabled={busy}
                        aria-label={`حذف ${l.productName}`}
                      >
                        ×
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          {sheet.status === "posted" ? (
            <>
              <div className="total">
                <span>{netValue < 0n ? "کسری ارزش" : "اضافه ارزش"}</span>
                <span className="num total-value">
                  {toman(netValue < 0n ? -netValue : netValue)}
                </span>
              </div>
              <p className="muted small" style={{ margin: 0 }}>
                برگه ثبت‌شده تغییر نمی‌کند. اصلاح فقط با یک برگه تازه.
                کالایی که در این برگه نبود، دست‌نخورده مانده است.
              </p>
            </>
          ) : null}

          {editable ? (
            <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || sheet.lines.length === 0}
                onClick={() => void post()}
              >
                {busy ? "…" : "ثبت و تعدیل موجودی"}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => void cancel()}>
                ابطال برگه
              </button>
            </div>
          ) : null}
        </Solid>
      ) : null}

      <Solid as="section" className="pad">
        <h3 style={{ marginTop: 0 }}>برگه‌های اخیر</h3>
        {list.length === 0 ? (
          <p className="empty">هنوز انبارگردانی‌ای ثبت نشده.</p>
        ) : (
          <ul className="lines">
            {list.map((c) => (
              <li key={c.id}>
                <div className="line-name">
                  <strong>{c.number ?? "پیش‌نویس"}</strong>
                  <span className="muted small">
                    {c.warehouseName} · {shortDate(c.startedAt)} · {c.lineCount} قلم
                  </span>
                </div>
                <span className="chip">{RECEIPT_STATUS[c.status] ?? c.status}</span>
                <span className="num line-total">
                  {c.status === "posted"
                    ? c.diffCount === 0
                      ? "بدون تفاوت"
                      : `${c.diffCount} تفاوت`
                    : ""}
                </span>
                <button
                  type="button"
                  className="btn btn--quiet"
                  onClick={() => void open(c.id)}
                  disabled={busy}
                >
                  باز کن
                </button>
              </li>
            ))}
          </ul>
        )}
      </Solid>
    </div>
  );
}
