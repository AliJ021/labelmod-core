import { useCallback, useId } from "react";
import { api, ApiError } from "../lib/api.ts";
import { useLatestQuery } from "../lib/use-latest-query.ts";
import { useUrlState } from "../lib/use-url-state.ts";
import { formatCount, formatJalaliMoment } from "../lib/format.ts";
import type { Period } from "../lib/reports.ts";
import { ResultState } from "./ResultState.tsx";
import { Solid } from "./Glass.tsx";
import { Button } from "./ui/Controls.tsx";
import { DataTable, type Column } from "./ui/DataTable.tsx";
import { Money } from "./ui/Money.tsx";
import { SectionHeader } from "./ui/PageHeader.tsx";
import { Skeleton } from "./ui/Skeleton.tsx";
import { StatusBadge } from "./ui/Status.tsx";
import { Ltr } from "./ui/Bidi.tsx";

interface Row {id:string;occurredAt:string;direction:string;amount:string;reference:string;accountName:string|null;invoiceNumber:string|null;invoiceStatus:string;returnNumber:string|null}
interface Report {rows:Row[];total:number;received:string;refunded:string;net:string}
/** اندازهٔ صفحهٔ سرور؛ فقط برای فعال/غیرفعال‌کردن «بعدی» — سرور همین را برمی‌گرداند. */
const PAGE_SIZE = 50;

/**
 * گردش اسنپ‌پی: دریافت و برگشت **دستیِ** تأییدشده. جمع‌ها از سرور می‌آیند؛
 * این صفحه هیچ مبلغی نمی‌سازد و «واریز بانک» ادعا نمی‌کند.
 */
export function SnappayReport({period}:{period:Period}) {
  const [page,setPage]=useUrlState("reports.snappayPage","1");
  const id=useId();
  const {from,to,branchId}=period;
  const load=useCallback((signal:AbortSignal)=>{
    const q=new URLSearchParams({from,to,page}); if(branchId) q.set("branchId",branchId);
    return api.get<Report>(`/reports/snappay?${q}`,{signal});
  },[from,to,branchId,page]);
  const q=useLatestQuery({key:JSON.stringify([from,to,branchId,page]),load});
  const columns:Column<Row>[]=[
    {key:"at",header:"تاریخ",cell:r=><span className="cell-nowrap">{formatJalaliMoment(r.occurredAt)}</span>},
    {key:"doc",header:"سند",cell:r=>{const n=r.returnNumber??r.invoiceNumber;return <>{n?<Ltr>{n}</Ltr>:"پیش‌نویس"}{r.invoiceStatus==="draft"&&n?<span className="cell-sub">پیش‌نویس</span>:null}</>;}},
    {key:"dir",header:"نوع",cell:r=>r.direction==="in"?"دریافت":"برگشت"},
    {key:"amount",header:"مبلغ",numeric:true,cell:r=><Money rial={r.amount} unit={false} size="sm"/>},
    {key:"ref",header:"پیگیری",cell:r=><Ltr>{r.reference}</Ltr>},
    {key:"account",header:"حساب واسط",cell:r=>r.accountName??"نامعلوم"},
  ];
  const n=Number(page);
  return <Solid as="section" className="report-section" aria-labelledby={id}>
    <SectionHeader id={id} title="گردش اسنپ‌پی" description="دریافت و برگشت دستیِ تأییدشده، شامل دریافتِ پیش‌نویس؛ این مبلغ‌ها به‌معنای واریز بانک نیستند. مبالغ به تومان‌اند."/>
    {q.loading ? <Skeleton variant="row" lines={4} label="در حال دریافت گردش…"/>
      : q.error ? (q.error instanceof ApiError&&q.error.status===403
        ? <ResultState kind="denied" title={q.error.message}/>
        : <ResultState kind="error" title={q.error instanceof ApiError?q.error.message:"دریافت گردش ممکن نشد."} reference={q.error instanceof ApiError?q.error.correlationId:null}/>)
      : q.data && <>
      <p className="report-totals">
        <span>دریافت: <Money rial={q.data.received}/></span>
        <span>برگشت: <Money rial={q.data.refunded}/></span>
        <span className="report-totals-net">خالص: <Money rial={q.data.net}/></span>
      </p>
      {!q.data.rows.length ? <ResultState title="گردشی در این بازه نیست."/> : <DataTable caption="گردش اسنپ‌پی" columns={columns} rows={q.data.rows} stack rowKey={r=>r.id}/>}
      <nav className="pager" aria-label="صفحه‌بندی گردش اسنپ‌پی">
        <Button disabled={n<=1} onClick={()=>setPage(String(n-1))}>قبلی</Button>
        <span className="pager-state">صفحهٔ {formatCount(n)} · {formatCount(q.data.total)} ردیف</span>
        <Button disabled={n*PAGE_SIZE>=q.data.total} onClick={()=>setPage(String(n+1))}>بعدی</Button>
        {q.data.rows.length===0&&n>1?<StatusBadge state="warning" label="این صفحه خالی است"/>:null}
      </nav>
    </>}
  </Solid>;
}
