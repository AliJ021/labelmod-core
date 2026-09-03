/**
 * سفارش خرید — تعهد به تأمین‌کننده.
 *
 * ── چیزی که این صفحه نشان می‌دهد و اکثر سیستم‌ها نه ────────────────
 *
 * **سفارش هیچ اثر مالی ندارد.** نه سندی می‌زند، نه بدهی‌ای، نه
 * موجودی‌ای. جمع سفارش یک عدد **برای مقایسه** است، نه یک بدهی —
 * و همین را روی صفحه می‌نویسیم، چون کسی که «جمع: ۲۰ میلیون» را
 * می‌بیند طبیعتاً فکر می‌کند چیزی بدهکار شده.
 *
 * ── جریان ─────────────────────────────────────────────────────────
 *
 *   تأمین‌کننده → اقلام و قیمت توافقی → فرستادن (شماره می‌گیرد)
 *   → «محموله رسید» → پیش‌نویس رسید → ثبت → پیشرفت جلو می‌رود
 *
 * ── «چقدرش رسیده» را این صفحه حساب نمی‌کند ────────────────────────
 *
 * از نمای سرور می‌آید و برگشتی را کم می‌کند. تفریق در مرورگر یعنی
 * سفارشی که کالایش پس رفته «کامل» بماند و کسی دنبال بقیه‌اش نرود.
 */
import { useEffect, useState } from "react";
import { Glass, Solid } from "../components/Glass.tsx";
import { ApiError } from "../lib/api.ts";
import { ActionKeys, actionFor } from "../lib/action-key.ts";
import { parseRial, rialFromTomanInput, toman } from "../lib/money.ts";
import { pos, type Branch } from "../lib/pos.ts";
import {
  ORDER_STATUS,
  purchaseOrders,
  purchasing,
  type Order,
  type OrderSummary,
  type Supplier,
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

export function PurchaseOrder() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState("");

  const [list, setList] = useState<OrderSummary[]>([]);
  const [order, setOrder] = useState<Order | null>(null);

  const [barcode, setBarcode] = useState("");
  const [qty, setQty] = useState("1");
  const [price, setPrice] = useState("");
  const [closeReason, setCloseReason] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [keys] = useState(() => new ActionKeys());

  const branch = branches.find((b) => b.id === branchId) ?? null;
  const editable = order !== null && order.status === "draft";
  const open = order !== null && order.status === "sent";

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
        const [s, l] = await Promise.all([purchasing.suppliers(), purchaseOrders.list()]);
        setSuppliers(s);
        setList(l);
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

  const refreshList = async () => setList(await purchaseOrders.list());

  const start = () =>
    guarded(async () => {
      setDone(null);
      const body = { branchId, supplierId, warehouseId };
      const fresh = await keys.run(actionFor("order", body), (key) =>
        purchaseOrders.create(body, { idempotencyKey: key }),
      );
      setOrder(fresh);
      await refreshList();
    });

  const load = (id: string) =>
    guarded(async () => {
      setDone(null);
      setOrder(await purchaseOrders.get(id));
    });

  const addLine = () =>
    guarded(async () => {
      if (!order) return;
      const rial = rialFromTomanInput(price);
      if (rial === null) throw new ApiError(400, "bad_price", "قیمت توافقی معتبر نیست.", null);
      setOrder(
        await purchaseOrders.setLine(order.id, {
          barcode: barcode.trim(),
          qty: qty.trim(),
          unitPrice: rial.toString(),
        }),
      );
      setBarcode("");
      setQty("1");
    });

  const removeLine = (lineId: string) =>
    guarded(async () => {
      if (!order) return;
      setOrder(await purchaseOrders.removeLine(order.id, lineId));
    });

  const send = () =>
    guarded(async () => {
      if (!order) return;
      const sent = await keys.run(`order-send:${order.id}`, (key) =>
        purchaseOrders.send(order.id, { idempotencyKey: key }),
      );
      setOrder(sent);
      setDone(`سفارش ${sent.number ?? ""} فرستاده شد. هیچ سندی زده نشد — سفارش یک تعهد است.`);
      await refreshList();
    });

  const makeReceipt = () =>
    guarded(async () => {
      if (!order) return;
      const receipt = await keys.run(
        actionFor(`order-receipt:${order.id}`, order.lines.map((l) => l.remainingQty)),
        (key) => purchaseOrders.makeReceipt(order.id, { idempotencyKey: key }),
      );
      setDone(
        `پیش‌نویس رسید ساخته شد با ${receipt.lines.length} قلم. ` +
          `در زبانه «رسید خرید» بازش کنید، با فاکتور تأمین‌کننده تطبیق دهید و ثبت کنید.`,
      );
      await refreshList();
    });

  const close = () =>
    guarded(async () => {
      if (!order) return;
      setOrder(await purchaseOrders.close(order.id, closeReason.trim() || undefined));
      setCloseReason("");
      await refreshList();
    });

  const pending = (order?.lines ?? []).filter((l) => Number(l.remainingQty) > 0).length;

  return (
    <div className="stack" style={{ gap: "var(--s-4)" }}>
      <Glass as="section" className="pad" live>
        <h2 style={{ marginTop: 0 }}>سفارش خرید</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          سفارش یک <strong>تعهد</strong> است، نه یک رویداد مالی: نه سندی می‌زند، نه بدهی‌ای،
          نه موجودی‌ای. تا وقتی کالا نیامده، هیچ‌چیز در دفتر عوض نمی‌شود.
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
            <span>تأمین‌کننده</span>
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">— انتخاب کنید —</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </select>
          </label>

          <label className="auth-field">
            <span>انبار مقصد (پیشنهادی)</span>
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
            disabled={busy || supplierId === "" || warehouseId === ""}
            onClick={() => void start()}
          >
            {busy ? "…" : "سفارش تازه"}
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

      {order ? (
        <Solid as="section" className="pad stack" style={{ gap: "var(--s-3)" }}>
          <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
            <h3 style={{ margin: 0, flex: "1 1 auto" }}>
              {order.number ?? "پیش‌نویس بی‌شماره"} — {order.supplierName}
            </h3>
            <span className="chip">{ORDER_STATUS[order.status] ?? order.status}</span>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            انبار {order.warehouseName} · ساخت {shortDate(order.createdAt)}
            {order.sentAt ? ` · فرستاده ${shortDate(order.sentAt)}` : ""}
          </p>
          {order.closeReason ? (
            <p className="muted small" style={{ margin: 0 }}>
              دلیل بستن: {order.closeReason}
            </p>
          ) : null}

          {editable ? (
            <form
              className="stack"
              style={{ gap: "var(--s-2)" }}
              onSubmit={(e) => {
                e.preventDefault();
                void addLine();
              }}
            >
              <span className="muted small">افزودن قلم — بارکد، تعداد، قیمت توافقی</span>
              <div className="rcpt-add">
                <input
                  value={barcode}
                  onChange={(e) => setBarcode(e.target.value)}
                  placeholder="بارکد"
                  autoComplete="off"
                  aria-label="بارکد"
                />
                <input
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  inputMode="decimal"
                  placeholder="تعداد"
                  aria-label="تعداد"
                />
                <input
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  inputMode="numeric"
                  placeholder="قیمت توافقی (تومان)"
                  aria-label="قیمت توافقی به تومان"
                />
                <button
                  type="submit"
                  className="btn btn--primary"
                  disabled={busy || barcode.trim() === "" || price.trim() === ""}
                >
                  افزودن
                </button>
              </div>
              <p className="muted small" style={{ margin: 0 }}>
                قیمت توافقی فقط برای مقایسه است. بهای واقعی را{" "}
                <strong>فاکتور تأمین‌کننده</strong> تعیین می‌کند، نه این عدد.
              </p>
            </form>
          ) : null}

          {order.lines.length === 0 ? (
            <p className="empty">هنوز قلمی اضافه نشده.</p>
          ) : (
            <ul className="lines">
              {order.lines.map((l) => {
                const received = Number(l.receivedQty);
                const remaining = Number(l.remainingQty);
                const over = Number(l.overQty);
                return (
                  <li key={l.id}>
                    <div className="line-name">
                      <strong>{l.productName}</strong>
                      <span className="muted small">
                        {l.sku}
                        {l.color ? ` · ${l.color}` : ""}
                        {l.size ? ` · ${l.size}` : ""} · {toman(parseRial(l.unitPrice))} تومان
                      </span>
                    </div>
                    <span className="num">سفارش {Number(l.qty)}</span>
                    {order.status === "draft" ? (
                      <span className="muted small">—</span>
                    ) : over > 0 ? (
                      <span className="cnt-over">
                        <span aria-hidden="true">▲</span> {received} رسید ({over} اضافه)
                      </span>
                    ) : remaining === 0 ? (
                      <span className="cnt-ok">
                        <span aria-hidden="true">●</span> کامل رسید
                      </span>
                    ) : (
                      <span className="cnt-short">
                        <span aria-hidden="true">▼</span> {received} رسید، {remaining} مانده
                      </span>
                    )}
                    <span className="num line-total">{toman(parseRial(l.lineAmount))}</span>
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

          <div className="total">
            <span>جمع توافقی</span>
            <span className="num total-value">{toman(parseRial(order.orderedAmount))}</span>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            این عدد یک <strong>بدهی نیست</strong> — تا کالا نیامده، چیزی بدهکار نشده‌ایم.
          </p>

          {editable ? (
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || order.lines.length === 0}
              onClick={() => void send()}
            >
              {busy ? "…" : "فرستادن به تأمین‌کننده"}
            </button>
          ) : null}

          {open ? (
            <div className="stack" style={{ gap: "var(--s-2)" }}>
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || pending === 0}
                onClick={() => void makeReceipt()}
              >
                {busy ? "…" : "محموله رسید — ساخت پیش‌نویس رسید"}
              </button>
              {pending === 0 ? (
                <p className="muted small" style={{ margin: 0 }}>
                  همه اقلام رسیده‌اند. سفارش را ببندید تا از فهرست باز بیرون برود.
                </p>
              ) : null}

              <label className="auth-field">
                <span>
                  بستن سفارش{pending > 0 ? " — دلیل لازم است" : " (اختیاری: دلیل)"}
                </span>
                <input
                  value={closeReason}
                  onChange={(e) => setCloseReason(e.target.value)}
                  placeholder={pending > 0 ? "مثلاً: تأمین‌کننده گفت بقیه‌اش نمی‌آید" : ""}
                />
              </label>
              <button
                type="button"
                className="btn"
                disabled={busy || (pending > 0 && closeReason.trim() === "")}
                onClick={() => void close()}
              >
                بستن سفارش
              </button>
            </div>
          ) : null}
        </Solid>
      ) : null}

      <Solid as="section" className="pad">
        <h3 style={{ marginTop: 0 }}>سفارش‌های اخیر</h3>
        {list.length === 0 ? (
          <p className="empty">هنوز سفارشی ثبت نشده.</p>
        ) : (
          <ul className="lines">
            {list.map((o) => (
              <li key={o.id}>
                <div className="line-name">
                  <strong>{o.number ?? "پیش‌نویس"}</strong>
                  <span className="muted small">
                    {o.supplierName} · {shortDate(o.createdAt)} · {o.lineCount} قلم
                  </span>
                </div>
                <span className="chip">{ORDER_STATUS[o.status] ?? o.status}</span>
                <span className="num line-total">
                  {o.status === "sent"
                    ? o.pendingLines === 0
                      ? "کامل رسید"
                      : `${o.pendingLines} قلم مانده`
                    : ""}
                </span>
                <button
                  type="button"
                  className="btn btn--quiet"
                  onClick={() => void load(o.id)}
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
