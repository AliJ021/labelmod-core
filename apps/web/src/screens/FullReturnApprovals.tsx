import {useState} from "react";
import {api} from "../lib/api.ts";
import {toman} from "../lib/money.ts";

interface Proposal {
  id:string;number:string;actor:string;details:{
    amount:string;method:string|null;reference:string|null;note:string|null;
    split:{legs:Array<{method:string;amount:string;reference?:string}>}|null;
    lines:Array<{line:string;product:string;sku:string;qty:number;restock:boolean;condition:string}>;
  }
}
export function FullReturnApprovals({branchId}:{branchId:string}) {
  const [items,setItems]=useState<Proposal[]>([]),[selected,select]=useState<Proposal|null>(null);
  const [reason,setReason]=useState(""),[message,notify]=useState(""),[busy,setBusy]=useState(false);
  async function load(){
    setBusy(true);select(null);
    try{const r=await api.get<{items:Proposal[]}>("/return-approvals?branchId="+encodeURIComponent(branchId));setItems(r.items);notify(r.items.length?"":"درخواستی در انتظار تأیید نیست.");}
    catch(e){setItems([]);notify(e instanceof Error?e.message:"خواندن درخواست‌ها ناموفق بود.");}finally{setBusy(false);}
  }
  async function decide(decision:"approved"|"rejected"){
    if(!selected||busy||reason.trim().length<3)return;
    setBusy(true);
    try{await api.post("/return-approvals/"+selected.id+"/decision",{decision,reason});setItems(items.filter(r=>r.id!==selected.id));select(null);
      notify(decision==="approved"?"تأیید شد. فروشنده می‌تواند همان عملیات را ادامه دهد.":"درخواست رد شد.");}
    catch(e){notify(e instanceof Error?e.message:"نتیجه را دوباره بررسی کنید.");}finally{setBusy(false);}
  }
  return <section className="solid pad stack"><h3>تأیید ابطال فاکتور فروشگاه</h3>
    <button type="button" className="btn" disabled={!branchId||busy} onClick={()=>void load()}>نمایش درخواست‌ها</button>
    <p role="status">{message}</p>
    {items.map(r=><button type="button" className="btn" disabled={busy} key={r.id} onClick={()=>{select(r);setReason("");}}>فاکتور {r.number} · {r.actor} · {toman(BigInt(r.details.amount))} تومان</button>)}
    {selected&&<section className="stack"><h4>فاکتور {selected.number}</h4>
      <ul>{selected.details.lines.map(l=><li key={l.line}>{l.product} · {l.sku} · {l.qty} عدد · {l.restock?(l.condition==="defective"?"بازگشت به موجودی معیوب":"بازگشت به موجودی"):"بدون بازگشت به موجودی"}</li>)}</ul>
      <p>مقصد بازپرداخت · {selected.details.split?.legs.map(l=>l.method+" "+toman(BigInt(l.amount))+" تومان").join("، ")??selected.details.method??"بدون روش ثبت‌شده"}</p>
      {selected.details.note&&<p>{selected.details.note}</p>}
      <label>دلیل تصمیم<input maxLength={500} value={reason} onChange={e=>setReason(e.target.value)}/></label>
      <div className="row"><button type="button" className="btn btn--primary" disabled={busy||reason.trim().length<3} onClick={()=>void decide("approved")}>تأیید این ترکیب</button>
      <button type="button" className="btn" disabled={busy||reason.trim().length<3} onClick={()=>void decide("rejected")}>رد درخواست</button></div>
    </section>}
  </section>;
}
