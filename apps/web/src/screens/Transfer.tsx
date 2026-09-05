/**
 * انتقال بین انبارها.
 *
 * ناحیه «متوسط» ADR-002: کار انبار طولانی است و خستگی چشم مهم، پس هر
 * عدد و هر فرم مات می‌ماند.
 *
 * ── سه چیزی که این صفحه عمداً نمی‌کند ──────────────────────────────
 *
 * **بها را نشان نمی‌دهد، تا ثبت نشود.** بهای خروج در لحظه ثبت از
 * لایه‌های انبار مبدأ حساب می‌شود؛ عددی که پیش از آن نشان داده شود،
 * حدس است. پس ستون بها تا لحظه ثبت «—» می‌ماند.
 *
 * **موجودی مبدأ را کنار قلم نمی‌گذارد.** انتقال کالایی که نیست، در
 * لحظه ثبت با پیام صریح رد می‌شود — و آن پیام از دیتابیس می‌آید،
 * جایی که عدد واقعی و قفل‌شده است. عدد کهنه روی صفحه فقط اعتماد کاذب
 * می‌سازد.
 *
 * **پیش‌نویس شماره نمی‌گیرد.** شماره در لحظه ثبت تخصیص می‌یابد، پس
 * برگه رهاشده شماره‌ای نمی‌سوزاند. صفحه هم همین را می‌نویسد.
 */
import { useCallback, useEffect, useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { ApiError } from "../lib/api.ts";
import { ActionKeys } from "../lib/action-key.ts";
import { parseRial, toman } from "../lib/money.ts";
import { pos, type Branch, type Warehouse } from "../lib/pos.ts";
import {
  TRANSFER_STATUS,
  transfers,
  type Transfer as Sheet,
  type TransferHead,
} from "../lib/transfer.ts";

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

export function Transfer() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("");
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");

  const [list, setList] = useState<TransferHead[]>([]);
  const [sheet, setSheet] = useState<Sheet | null>(null);

  const [barcode, setBarcode] = useState("");
  const [qty, setQty] = useState("1");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [keys] = useState(() => new ActionKeys());

  const branch = branches.find((b) => b.id === branchId) ?? null;
  const warehouses: Warehouse[] = branch?.warehouses ?? [];
  const editable = sheet !== null && sheet.status === "draft";

  const reload = useCallback(async () => {
    setList((await transfers.list()).transfers);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const { branches: bs } = await pos.branches();
        setBranches(bs);
        const first = bs[0];
        if (first) {
          setBranchId(first.id);
          // پیش‌فرض: از قفسه فروشگاه به انبار پشتیبان — پرتکرارترین
          // جهت. ولی هر دو قابل عوض‌شدن‌اند.
          const store = first.warehouses.find((w) => w.kind === "store");
          const back = first.warehouses.find((w) => w.kind !== "store");
          setFromId(store?.id ?? first.warehouses[0]?.id ?? "");
          setToId(back?.id ?? "");
        }
        await reload();
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

  const startSheet = () =>
    guarded(async () => {
      setDone(null);
      const { id } = await transfers.create({
        branchId,
        fromWarehouseId: fromId,
        toWarehouseId: toId,
      });
      setSheet(await transfers.byId(id));
      await reload();
    });

  const openSheet = (id: string) =>
    guarded(async () => {
      setDone(null);
      setSheet(await transfers.byId(id));
    });

  const addLine = () =>
    guarded(async () => {
      if (!sheet || barcode.trim() === "") return;
      setSheet(await transfers.addLine(sheet.id, { barcode: barcode.trim(), qty }));
      setBarcode("");
      setQty("1");
    });

  const setLineQty = (lineId: string, next: string) =>
    guarded(async () => {
      if (!sheet) return;
      setSheet(await transfers.setLineQty(sheet.id, lineId, next));
    });

  const removeLine = (lineId: string) =>
    guarded(async () => {
      if (!sheet) return;
      setSheet(await transfers.removeLine(sheet.id, lineId));
    });

  const discard = () =>
    guarded(async () => {
      if (!sheet) return;
      await transfers.discard(sheet.id);
      setSheet(null);
      await reload();
    });

  const post = () =>
    guarded(async () => {
      if (!sheet) return;
      // کلید روی Retry ثابت می‌ماند: اثر انباری دارد و تکرارش کالا را
      // دو بار جابه‌جا می‌کند. سرور هم اگر کلید نیاید خودش از شناسه
      // برگه می‌سازد — این لایه اول است، نه تنها لایه.
      const out = await keys.run(`transfer-post:${sheet.id}`, (key: string) =>
        transfers.post(sheet.id, { idempotencyKey: key }),
      );
      setSheet(await transfers.byId(sheet.id));
      setDone(
        out.replayed
          ? "این برگه قبلاً ثبت شده بود؛ چیزی دوباره جابه‌جا نشد."
          : `برگه ${out.number ?? ""} ثبت شد — ${out.lines} قلم جابه‌جا شد.`,
      );
      await reload();
    });

  return (
    <div className="stack" style={{ gap: "var(--s-3)" }}>
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

      {sheet === null ? (
        <>
          <Solid className="pad stack" style={{ gap: "var(--s-3)" }}>
            <h2 style={{ margin: 0, fontSize: "1rem" }}>برگه انتقال تازه</h2>
            <div className="filters">
              {branches.length > 1 ? (
                <label className="auth-field">
                  <span>شعبه</span>
                  <select
                    value={branchId}
                    onChange={(e) => {
                      setBranchId(e.target.value);
                      setFromId("");
                      setToId("");
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
                <span>از انبار</span>
                <select value={fromId} onChange={(e) => setFromId(e.target.value)}>
                  <option value="">انتخاب کنید</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="auth-field">
                <span>به انبار</span>
                <select value={toId} onChange={(e) => setToId(e.target.value)}>
                  <option value="">انتخاب کنید</option>
                  {warehouses
                    .filter((w) => w.id !== fromId)
                    .map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                </select>
              </label>
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || fromId === "" || toId === "" || fromId === toId}
                onClick={() => void startSheet()}
              >
                ساخت برگه
              </button>
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              برگه تا لحظه ثبت هیچ کالایی را جابه‌جا نمی‌کند و شماره‌ای هم نمی‌گیرد.
            </p>
          </Solid>

          <Solid className="pad">
            <h2 style={{ marginTop: 0, fontSize: "1rem" }}>برگه‌های اخیر</h2>
            {list.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>هنوز برگه‌ای ثبت نشده است.</p>
            ) : (
              <div className="grid-wrap">
                <table className="grid">
                  <thead>
                    <tr>
                      <th scope="col">شماره</th>
                      <th scope="col">تاریخ</th>
                      <th scope="col">از</th>
                      <th scope="col">به</th>
                      <th scope="col">اقلام</th>
                      <th scope="col">تعداد</th>
                      <th scope="col">وضعیت</th>
                      <th scope="col"> </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((t) => (
                      <tr key={t.id}>
                        <td className="num">
                          {t.number ?? <span className="muted">—</span>}
                        </td>
                        <td className="num">{shortDate(t.occurredAt)}</td>
                        <td>{t.fromWarehouseName}</td>
                        <td>{t.toWarehouseName}</td>
                        <td className="num">{t.lineCount}</td>
                        <td className="num">{Number(t.totalQty)}</td>
                        <td>{TRANSFER_STATUS[t.status] ?? t.status}</td>
                        <td>
                          <button
                            type="button"
                            className="link"
                            onClick={() => void openSheet(t.id)}
                            disabled={busy}
                          >
                            باز کردن
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Solid>
        </>
      ) : (
        <>
          <Solid className="pad">
            <div className="row between">
              <div>
                <h2 style={{ margin: 0, fontSize: "1rem" }}>
                  {sheet.number ?? "پیش‌نویس"} · {sheet.fromWarehouseName} ←{" "}
                  {sheet.toWarehouseName}
                </h2>
                <p className="muted small" style={{ margin: 0 }}>
                  {TRANSFER_STATUS[sheet.status] ?? sheet.status} ·{" "}
                  {shortDate(sheet.occurredAt)}
                  {sheet.createdByName === null ? "" : ` · ${sheet.createdByName}`}
                </p>
              </div>
              <button type="button" className="btn btn--quiet" onClick={() => setSheet(null)}>
                بازگشت به فهرست
              </button>
            </div>
          </Solid>

          {editable ? (
            <Solid className="pad">
              <form
                className="filters"
                onSubmit={(e) => {
                  e.preventDefault();
                  void addLine();
                }}
              >
                <label className="auth-field">
                  <span>بارکد</span>
                  <input
                    type="text"
                    value={barcode}
                    onChange={(e) => setBarcode(e.target.value)}
                    autoFocus
                  />
                </label>
                <label className="auth-field">
                  <span>تعداد</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={qty}
                    onChange={(e) => setQty(e.target.value)}
                  />
                </label>
                <button
                  type="submit"
                  className="btn btn--primary"
                  disabled={busy || barcode.trim() === ""}
                >
                  افزودن
                </button>
              </form>
              <p className="muted small" style={{ margin: 0 }}>
                اسکن دوباره همان کالا، تعدادش را جمع می‌زند — سطر دوم نمی‌سازد.
              </p>
            </Solid>
          ) : null}

          <Solid className="pad">
            {sheet.lines.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>هنوز قلمی اضافه نشده است.</p>
            ) : (
              <div className="grid-wrap">
                <table className="grid">
                  <caption className="sr-only">اقلام برگه انتقال</caption>
                  <thead>
                    <tr>
                      <th scope="col">کالا</th>
                      <th scope="col">SKU</th>
                      <th scope="col">تعداد</th>
                      <th scope="col">بهای واحد</th>
                      <th scope="col">ارزش</th>
                      {editable ? <th scope="col"> </th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {sheet.lines.map((l) => (
                      <tr key={l.id}>
                        <td>
                          {l.productName}
                          <span className="muted small"> · {l.color} {l.size}</span>
                        </td>
                        <td className="num">{l.sku}</td>
                        <td className="num">
                          {editable ? (
                            <input
                              type="text"
                              inputMode="numeric"
                              className="qty-cell"
                              defaultValue={String(Number(l.qty))}
                              onBlur={(e) => {
                                const next = e.target.value.trim();
                                if (next !== "" && next !== String(Number(l.qty))) {
                                  void setLineQty(l.id, next);
                                }
                              }}
                              aria-label={`تعداد ${l.productName}`}
                            />
                          ) : (
                            Number(l.qty)
                          )}
                        </td>
                        {/*
                          بها تا لحظه ثبت «—» است، نه صفر: در لحظه خروج
                          از لایه‌های انبار مبدأ حساب می‌شود و هر عددی
                          پیش از آن حدس است.
                        */}
                        <td>
                          {l.unitCost === null ? (
                            <span className="muted">—</span>
                          ) : (
                            <span className="num">{toman(parseRial(l.unitCost))}</span>
                          )}
                        </td>
                        <td>
                          {l.valueDelta === null ? (
                            <span className="muted">—</span>
                          ) : (
                            <span className="num">{toman(parseRial(l.valueDelta))}</span>
                          )}
                        </td>
                        {editable ? (
                          <td>
                            <button
                              type="button"
                              className="link"
                              onClick={() => void removeLine(l.id)}
                              disabled={busy}
                              aria-label={`حذف ${l.productName}`}
                            >
                              حذف
                            </button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Solid>

          {editable ? (
            <Solid className="pad stack" style={{ gap: "var(--s-2)" }}>
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || sheet.lines.length === 0}
                onClick={() => void post()}
              >
                ثبت انتقال — کالا همین لحظه جابه‌جا می‌شود
              </button>
              <button
                type="button"
                className="btn btn--quiet"
                disabled={busy}
                onClick={() => void discard()}
              >
                دور انداختن پیش‌نویس
              </button>
              <p className="muted small" style={{ margin: 0 }}>
                پس از ثبت، برگه تغییر نمی‌کند. برای اصلاح باید یک انتقال معکوس ثبت کنید.
              </p>
            </Solid>
          ) : null}
        </>
      )}
    </div>
  );
}
