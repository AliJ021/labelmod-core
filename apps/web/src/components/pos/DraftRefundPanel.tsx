import { useState } from "react";
import { Solid } from "../Glass.tsx";
import { Money } from "../ui/Money.tsx";
import { parseRial } from "../../lib/money.ts";
import type { DraftPayment } from "../../lib/pos.ts";

export function DraftRefundPanel({ payments, busy, onCancel, onConfirm }: {
  payments: DraftPayment[]; busy: boolean; onCancel: () => void;
  onConfirm: (reason: string, ref: string, payoutMethod:string) => void;
}) {
  const [reason, setReason] = useState("");
  const [ref, setRef] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [payout,setPayout] = useState("");
  const external = payout === "transfer" || !payout && payments.some((p) => ["card_reader", "gateway", "transfer"].includes(p.kind));
  const blocked = payments.some(p => p.direction !== "in" || (payout && ["snappay","digipay"].includes(p.method_code ?? "")) ||
    ((!["snappay","digipay"].includes(p.method_code ?? "") && (payout && ["cash","card_reader","gateway","transfer"].includes(p.kind) || ["card_reader","gateway","transfer"].includes(p.kind)))
    ? !["succeeded","settled","reconciled"].includes(p.status)
    : p.status !== "succeeded" || p.settlement_id !== null || p.settled_at !== null || parseRial(p.fee_amount) !== 0n));
  return <section role="region" aria-label="برگشت پرداخت پیش‌نویس"><Solid className="pad">
    <h3>برگشت پرداخت و لغو پیش‌نویس</h3>
    <p>{external ? "بازپرداخت بانکی را انجام دهید و شماره پیگیری آن را ثبت کنید." : "مبلغ نقدی انتخاب‌شده را از کشوی همین شیفت به مشتری تحویل دهید."} رزرو اعتبار و امتیاز مربوط به پیش‌نویس هنگام لغو آزاد می‌شود.</p>
    <ul>{payments.map((p) => <li key={p.id}>{p.name}: <Money rial={p.amount} /></li>)}</ul>
    <label>روش پس‌دادن وجه<select disabled={busy} value={payout} onChange={e => {setPayout(e.target.value);setConfirmed(false);}}>
      <option value="">هر مبلغ با روش دریافت خودش</option><option value="cash">نقد از کشوی همین شیفت</option>
      <option value="transfer">کارت‌به‌کارت با شماره پیگیری</option></select></label>
    {blocked ? <p role="alert">برای این پرداخت، وضعیت یا تأیید برگشت ارائه‌دهنده باید بررسی شود.</p> : null}
    <label className="auth-field">دلیل برگشت<input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} /></label>
    {external ? <label className="auth-field">شماره پیگیری برگشت بانکی<input value={ref} maxLength={120} onChange={(e) => setRef(e.target.value)} /></label> : null}
    <label><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />برگشت وجه لازم را انجام داده‌ام و لغو این پیش‌نویس را تأیید می‌کنم.</label>
    <button type="button" className="btn btn--primary" disabled={busy || blocked || !confirmed || reason.trim().length < 3 || (external && !ref.trim())}
      onClick={() => onConfirm(reason.trim(), ref, payout)}>ثبت برگشت و لغو پیش‌نویس</button>
    <button type="button" className="btn btn--quiet" disabled={busy} onClick={onCancel}>انصراف</button>
  </Solid></section>;
}
