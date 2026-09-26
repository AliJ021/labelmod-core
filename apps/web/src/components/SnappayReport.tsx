import { useCallback } from "react";
import { api, ApiError } from "../lib/api.ts";
import { useLatestQuery } from "../lib/use-latest-query.ts";
import { useUrlState } from "../lib/use-url-state.ts";
import { toman } from "../lib/money.ts";
import type { Period } from "../lib/reports.ts";
import { ResultState } from "./ResultState.tsx";
interface Row {id:string;occurredAt:string;direction:string;amount:string;reference:string;accountName:string|null;invoiceNumber:string|null;invoiceStatus:string;returnNumber:string|null}
interface Report {rows:Row[];total:number;received:string;refunded:string;net:string}
export function SnappayReport({period}:{period:Period}) {
  const [page,setPage]=useUrlState("reports.snappayPage","1");
  const {from,to,branchId}=period;
  const load=useCallback((signal:AbortSignal)=>{
    const q=new URLSearchParams({from,to,page}); if(branchId) q.set("branchId",branchId);
    return api.get<Report>(`/reports/snappay?${q}`,{signal});
  },[from,to,branchId,page]);
  const q=useLatestQuery({key:JSON.stringify([from,to,branchId,page]),load});
  return <section className="solid pad stack"><h2>گردش اسنپ‌پی</h2>
    <p className="muted">دریافت و برگشت دستیِ تأییدشده، شامل دریافتِ پیش‌نویس؛ این مبلغ‌ها به‌معنای واریز بانک نیستند. مبالغ به تومان‌اند.</p>
    {q.loading ? <ResultState kind="loading" title="در حال دریافت گردش…"/> : q.error ? <ResultState kind="error" title={q.error instanceof ApiError?q.error.message:"دریافت گردش ممکن نشد."}/> : q.data && <>
      <div className="row dashboard-actions"><span>دریافت: <b>{toman(BigInt(q.data.received))}</b></span><span>برگشت: <b>{toman(BigInt(q.data.refunded))}</b></span><span>خالص: <b>{toman(BigInt(q.data.net))}</b></span></div>
      {!q.data.rows.length ? <ResultState title="گردشی در این بازه نیست."/> : <div className="scroll-x"><table className="grid"><thead><tr><th>تاریخ</th><th>سند</th><th>نوع</th><th>مبلغ</th><th>پیگیری</th><th>حساب واسط</th></tr></thead><tbody>{q.data.rows.map(r=><tr key={r.id}><td>{new Date(r.occurredAt).toLocaleString("fa-IR")}</td><td>{r.returnNumber??r.invoiceNumber??"پیش‌نویس"}{r.invoiceStatus==="draft"?" · پیش‌نویس":""}</td><td>{r.direction==="in"?"دریافت":"برگشت"}</td><td className="num">{toman(BigInt(r.amount))}</td><td>{r.reference}</td><td>{r.accountName??"نامعلوم"}</td></tr>)}</tbody></table></div>}
      <nav className="row between" aria-label="صفحه‌بندی گردش اسنپ‌پی"><button className="btn" disabled={Number(page)<=1} onClick={()=>setPage(String(Number(page)-1))}>قبلی</button><span>صفحه {page} · {q.data.total} ردیف</span><button className="btn" disabled={Number(page)*50>=q.data.total} onClick={()=>setPage(String(Number(page)+1))}>بعدی</button></nav>
    </>}
  </section>;
}
