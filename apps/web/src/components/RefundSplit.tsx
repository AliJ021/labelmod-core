import { useState } from "react";
import { exactTomanInput, rialFromExactTomanInput } from "../lib/money.ts";
import type { PaymentMethod } from "../lib/pos.ts";
import { AmountInput } from "./ui/AmountInput.tsx";
import { Money } from "./ui/Money.tsx";

export interface RefundPlan {
  basis: string;
  mixed: boolean;
  canChange: boolean;
  legs: Array<{method:string;sourceId:string;originalReference:string|null;amount:string;remaining:string}>;
}
interface Edit {basis:string;custom:boolean;reason:string;amounts:Record<string,string>;refs:Record<string,string>}
export function useRefundSplit(plan:RefundPlan | null | undefined, total:bigint | null, methods:PaymentMethod[], reason:string, disabled:boolean) {
  const [saved,setSaved]=useState<Edit|null>(null);
  if (!plan?.mixed || total===null || total<=0n) return null;
  const fresh:Edit={basis:plan.basis,custom:false,reason:"",amounts:{},refs:{}};
  const edit=saved?.basis===plan.basis ? saved : fresh;
  const choices=plan.legs.map(l=>({...l,sourceId:l.sourceId as string|null,key:l.sourceId}));
  if (edit.custom) {
    for (const m of methods) {
      if (["snappay","digipay"].includes(m.code) || choices.some(c=>c.method===m.code)) continue;
      choices.push({method:m.code,sourceId:null,key:m.code,amount:"0",remaining:"0",originalReference:null});
    }
  }
  const rows=choices.map(c=>{
    const m=methods.find(x=>x.code===c.method);
    const input=edit.amounts[c.key] ?? exactTomanInput(c.amount);
    const amount=input.trim()==="" ? 0n : rialFromExactTomanInput(input);
    const reference=(edit.refs[c.key] ?? "").trim();
    const provider=["snappay","digipay"].includes(c.method);
    return {...c,name:m?.name ?? c.method,requiresRef:m?.requiresRef ?? c.method!=="cash",input,actual:amount,reference,
      overLimit:provider && amount!==null && amount>BigInt(c.remaining)};
  });
  const changed=rows.some(r=>r.actual!==BigInt(r.amount));
  const sum=rows.reduce((a,r)=>a+(r.actual ?? 0n),0n);
  const legs=rows.filter(r=>r.actual!==null && r.actual>0n).map(r=>({
    method:r.method,sourceId:r.sourceId,amount:r.actual!.toString(),...(r.reference && {reference:r.reference})}));
  const ready=plan.canChange && sum===total && rows.every(r=>r.actual!==null && r.actual>=0n && !r.overLimit &&
    (!r.requiresRef || !r.actual || !!r.reference)) && (!changed || !!edit.reason.trim() || !!reason.trim());
  const editor=<fieldset className="solid pad stack" disabled={disabled || !plan.canChange}><legend>ترکیب بازپرداخت</legend>
    <div className="row"><span>{edit.custom ? "سهم هر روش را وارد کنید" : "طبق پرداخت مشتری"}</span>
      <button type="button" className="btn btn--quiet" onClick={()=>setSaved({...fresh,custom:!edit.custom})}>
        {edit.custom ? "بازگشت به ترکیب اصلی" : "تغییر ترکیب"}</button></div>
    {!plan.canChange && <span>ثبت یا تغییر این بازپرداخت به مجوز مسئول نیاز دارد.</span>}
    {rows.filter(r=>edit.custom || r.actual!==0n).map(r=><div key={r.key} className="stack">
      <div className="row"><strong>{r.name}</strong>{r.originalReference && <small>دریافت اولیه · <bdi>{r.originalReference}</bdi></small>}</div>
      {edit.custom ? <label className="auth-field">سهم {r.name} (تومان)
        <AmountInput inputMode="decimal" value={r.input} onChange={e=>setSaved({...edit,amounts:{...edit.amounts,[r.key]:e.target.value}})}/>
      </label> : <Money rial={r.actual ?? 0n}/>}
      {r.overLimit && <span role="alert">مبلغ از ماندهٔ پرداخت ارائه‌دهنده بیشتر است.</span>}
      {r.requiresRef && r.actual!==null && r.actual>0n && <label className="auth-field">پیگیری برگشت {r.name}
        <input maxLength={200} value={edit.refs[r.key] ?? ""} onChange={e=>setSaved({...edit,refs:{...edit.refs,[r.key]:e.target.value}})}/></label>}
    </div>)}
    {sum!==total && <span role="status">جمع سهم‌ها باید <Money rial={total}/> باشد.</span>}
    {changed && <label className="auth-field">دلیل تغییر ترکیب
      <input value={edit.reason} placeholder={reason.trim() || undefined} maxLength={500}
        onChange={e=>setSaved({...edit,reason:e.target.value})}/></label>}
  </fieldset>;
  const summary=<ul>{rows.filter(r=>r.actual!==null && r.actual>0n).map(r=><li key={r.key}>{r.name} · <Money rial={r.actual!}/></li>)}</ul>;
  return {payload:{basis:plan.basis,legs,...(changed && {reason:edit.reason.trim() || reason.trim()})},editor,summary,ready,changed,hasCash:legs.some(l=>methods.find(m=>m.code===l.method)?.kind==="cash" || l.method==="cash")};
}
