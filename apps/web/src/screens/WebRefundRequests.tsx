import { useState } from "react";
import { api, ApiError } from "../lib/api.ts";
import { parseRial, toman } from "../lib/money.ts";

interface Request {
  id: string; invoiceId: string; number: string; requestedBy: string; requestedAt: string;
  payload: { orderId: string; refundId: string; amount: string; shippingAmount: string;
    lines: Array<{ lineNo: number; qty: string; restock: boolean }> };
}

export function WebRefundRequests({ branchId }: { branchId: string }) {
  const [items, setItems] = useState<Request[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Request | null>(null);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const showError = (e: unknown) => setError(e instanceof ApiError ? e.message : "ارتباط برقرار نشد؛ پیش از تصمیم تازه وضعیت را دوباره دریافت کنید.");
  async function refresh() {
    setBusy(true); setError("");
    try {
      const result = await api.get<{ items: Request[] }>(`/web-refund-requests?branchId=${encodeURIComponent(branchId)}`);
      setItems(result.items); setLoaded(true); setSelected(null);
    } catch (e) { showError(e); }
    finally { setBusy(false); }
  }
  async function decide(decision: "approved" | "rejected") {
    if (!selected || busy || reason.trim().length < 3 || (decision === "approved" && !confirmed)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api.post<{ status: string }>(`/web-refund-requests/${selected.id}/decision`, { decision, reason: reason.trim() });
      if (result.status !== (decision === "approved" ? "posted" : "rejected")) throw new Error("invalid response");
      setItems((rows) => rows.filter((row) => row.id !== selected.id)); setSelected(null);
      setNotice(decision === "approved" ? "تأیید و سند مرجوعی ثبت شد؛ پرداخت بانکی تازه‌ای انجام نشد." : "درخواست رد شد؛ سند و موجودی تغییر نکردند.");
    } catch (e) { showError(e); }
    finally { setBusy(false); }
  }
  return <section className="solid pad stack" aria-label="بررسی مرجوعی سایت">
    <h3>درخواست‌های مرجوعی سایت</h3>
    <p>اعلام سایت تا تأیید مستقل حسابدار یا کاربر مجاز، سند مالی و تغییر موجودی ایجاد نمی‌کند.</p>
    <button type="button" className="btn" disabled={busy || !branchId} onClick={() => { void refresh(); }}>دریافت درخواست‌های منتظر تأیید</button>
    {error && <p role="alert" className="solid pos-alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {loaded && items.length === 0 && <p>درخواستی منتظر تأیید نیست.</p>}
    {items.map((item) => <button type="button" className="btn" key={item.id} disabled={busy} onClick={() => {
      setSelected(item); setReason(""); setConfirmed(false); setNotice("");
    }}>بررسی فاکتور {item.number} · مرجوعی سایت {item.payload.refundId}</button>)}
    {selected && <div className="stack">
      <p>فاکتور {selected.number} · سفارش سایت {selected.payload.orderId} · ارسال‌کننده: {selected.requestedBy}</p>
      <p>دریافت درخواست: {new Date(selected.requestedAt).toLocaleString("fa-IR")}</p>
      <p>وجه مرجوعی: <span className="num">{toman(parseRial(selected.payload.amount))}</span> تومان؛ کرایهٔ برگشتی: <span className="num">{toman(parseRial(selected.payload.shippingAmount))}</span> تومان</p>
      <ul>{selected.payload.lines.map((line) => <li key={line.lineNo}>سطر {line.lineNo} فاکتور · تعداد {line.qty} · {line.restock ? "بازگشت به موجودی" : "بدون بازگشت به موجودی"}</li>)}</ul>
      <label>دلیل تصمیم<textarea value={reason} maxLength={500} disabled={busy} onChange={(e) => setReason(e.target.value)} /></label>
      <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={(e) => setConfirmed(e.target.checked)} />واقعیت مرجوعی، مبلغ و وضعیت بازگشت کالا را مستقل از پیام سایت بررسی کردم.</label>
      <div className="stack">
        <button type="button" className="btn btn--primary" disabled={busy || !confirmed || reason.trim().length < 3} onClick={() => { void decide("approved"); }}>تأیید و ثبت سند مرجوعی</button>
        <button type="button" className="btn" disabled={busy || reason.trim().length < 3} onClick={() => { void decide("rejected"); }}>رد درخواست بدون ثبت سند</button>
      </div>
    </div>}
  </section>;
}
