import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { toman } from "../lib/money.ts";
export function PaymentBreakdown({ invoiceId, received }: { invoiceId: string; received: bigint }) {
  const [rows,setRows]=useState<Array<{id:string;name:string;amount:string}>>([]);
  const [error,setError]=useState(false);
  useEffect(()=>{
    const c=new AbortController();setError(false);setRows([]);
    void api.get<{payments:Array<{id:string;name:string;amount:string}>}>(`/invoices/${invoiceId}/payments`,{signal:c.signal})
      .then(r=>{if(!c.signal.aborted)setRows(r.payments);}).catch(()=>{if(!c.signal.aborted)setError(true);});
    return ()=>c.abort();
  },[invoiceId,received]);
  return <section aria-label="پرداخت‌های ثبت‌شده"><h3>پرداخت‌های ثبت‌شده</h3>
    {error?<p role="alert">فهرست پرداخت‌ها دریافت نشد؛ برای بررسی پرداخت، صفحه را تازه کنید.</p>:null}
    <ul>{rows.map(p=><li key={p.id}>{p.name}: {toman(BigInt(p.amount))} تومان</li>)}</ul>
  </section>;
}
