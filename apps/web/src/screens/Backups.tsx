import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api.ts";
import { useLatestQuery } from "../lib/use-latest-query.ts";
import { ResultState } from "../components/ResultState.tsx";

interface Manifest {id:string;createdAt:string;bytes:number;serverMajor:number;}
interface Job {id:string;backupId:string;phase:string;createdAt:string;updatedAt:string;error?:string;safetyBackupId?:string;}
interface Status {available:boolean;backups:Array<{id:string;valid:boolean;manifest:Manifest|null}>;jobs:Job[];needsRecovery:boolean;busy?:boolean;}
const phases:Record<string,string>={queued:"در صف",verifying:"بررسی صحت فایل",rehearsing:"بازیابی آزمایشی و کنترل مالی",quiescing:"توقف ثبت‌های سامانه",safety_backup:"ساخت بکاپ بازگشت",swapping:"جایگزینی دیتابیس",validating:"کنترل نسخهٔ جایگزین",resuming:"راه‌اندازی مجدد",completed:"بازیابی کامل شد؛ اتصال‌های بیرونی منتظر بررسی مدیرند",failed:"متوقف شد؛ اصلی جایگزین نشده",rolled_back:"بازگشت به نسخهٔ قبل انجام شد",manual_recovery:"رسیدگی مدیر سامانه لازم است"};
const date=(s:string)=>new Intl.DateTimeFormat("fa-IR",{dateStyle:"medium",timeStyle:"medium",timeZone:"Asia/Tehran"}).format(new Date(s));
const message=(e:unknown)=>e instanceof ApiError?e.message:"ارتباط قطع شد؛ پیش از تلاش دوباره، تاریخچه را تازه‌سازی کنید.";
const finished=(phase:string)=>["completed","failed","rolled_back","manual_recovery"].includes(phase);

export function Backups() {
  const [version,refresh]=useState(0),[error,setError]=useState(""),[busy,setBusy]=useState(false),[notice,setNotice]=useState("");
  const [selected,setSelected]=useState<Manifest|null>(null),[confirmed,setConfirmed]=useState(false);
  const [password,setPassword]=useState(""),[code,setCode]=useState(""),[factorKind,setFactorKind]=useState("totp");
  const operation=useRef<string|null>(null),working=useRef(false);
  const [permissions,setPermissions]=useState<Set<string>>(new Set());
  const load=useCallback((signal:AbortSignal)=>api.get<Status>("/backups",{signal}),[]);
  const query=useLatestQuery({key:"backups",version,load});
  useEffect(()=>{
    const controller=new AbortController();
    void Promise.allSettled(["create","download","restore"].map(async kind=>{
      const result=await api.get<{verdict:string}>("/auth/can?operation=backup."+kind,{signal:controller.signal});
      return result.verdict==="allow"?kind:null;
    })).then(results=>{if(!controller.signal.aborted)setPermissions(new Set(results.flatMap(r=>r.status==="fulfilled"&&r.value?[r.value]:[])));});
    return ()=>controller.abort();
  },[]);
  // Polling a single resource keeps its last confirmed content visible. A failed
  // refresh is explicit and disables mutations until authoritative state returns.
  const [previous,setPrevious]=useState<Status|null>(null);
  useEffect(()=>{if(query.data)setPrevious(query.data);},[query.data]);
  const status=query.data??previous;
  const active=!!status?.busy || (status?.jobs.some(j=>!finished(j.phase))??false);
  const unavailable=query.loading||!!query.error;
  useEffect(()=>{if(!active)return;const timer=setInterval(()=>refresh(v=>v+1),5000);return()=>clearInterval(timer);},[active]);
  async function create() {
    if(working.current)return;working.current=true;setBusy(true);setError("");setNotice("");
    try {await api.post("/backups",{});setNotice("بکاپ تازه ساخته شد.");refresh(v=>v+1);}
    catch(e){setError(message(e));}finally{working.current=false;setBusy(false);}
  }
  async function restore() {
    if(!selected||!confirmed||working.current)return;
    working.current=true;setBusy(true);setError("");setNotice("");
    operation.current??=crypto.randomUUID();
    try {
      const job=await api.post<Job>("/backups/restore",{backupId:selected.id,operationId:operation.current,confirmedTimestamp:selected.createdAt,password,code,factorKind});
      setNotice("درخواست بازیابی ثبت شد. شناسهٔ پیگیری: "+job.id+". ممکن است اتصال موقتاً قطع شود؛ پس از راه‌اندازی دوباره وارد شوید و همین صفحه را باز کنید.");
      setSelected(null);setConfirmed(false);refresh(v=>v+1);
    }catch(e){setError(message(e));}
    finally{setPassword("");setCode("");working.current=false;setBusy(false);}
  }
  return <section className="solid pad stack backup-center">
    <header className="row between"><h1>پشتیبان‌گیری و بازیابی</h1><button className="btn" type="button" onClick={()=>refresh(v=>v+1)}>تازه‌سازی تاریخچه</button></header>
    <p className="muted">بازیابی، تمام داده‌های سامانه را به زمان بکاپ برمی‌گرداند. فایل دلخواه در این بخش پذیرفته نمی‌شود.</p>
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status" className="break-anywhere">{notice}</p>}
    {query.loading&&!status?<ResultState kind="loading" title="در حال بررسی سرویس بکاپ…"/>:query.error&&!status?<ResultState kind="error" title={message(query.error)} actionLabel="تلاش دوباره" onAction={()=>refresh(v=>v+1)}/>:status&&!status.available?<ResultState title="سرویس مستقل بکاپ هنوز متصل نشده است." description="مدیر سامانه باید فضای بکاپ و سرویس بازیابی را پیکربندی کند. تا آن زمان، عملیات از این صفحه اجرا نمی‌شود."/>:status&&<>
      {query.error&&<p role="alert">{message(query.error)} وضعیت نمایش‌داده‌شده از آخرین پاسخ تأییدشده است؛ عملیات تا تازه‌سازی موفق متوقف است.</p>}
      {active&&!status.needsRecovery&&<p role="status">عملیات بکاپ در حال اجراست؛ تاریخچه خودکار تازه می‌شود.</p>}
      {status.needsRecovery&&<p role="alert">عملیات فعال یا ناقص وجود دارد؛ ابتدا وضعیت آن را بررسی کنید.</p>}
      {permissions.has("create")&&<button className="btn primary" type="button" disabled={busy||active||unavailable||status.needsRecovery} onClick={()=>void create()}>ساخت بکاپ تازه</button>}
      <h2>بکاپ‌های سامانه</h2>
      {!status.backups.length?<p>هنوز بکاپی در این سرویس ثبت نشده است.</p>:<ul className="backup-list">{status.backups.map(b=><li key={b.id} className="solid pad stack">
        {b.valid&&b.manifest?<><strong>{date(b.manifest.createdAt)}</strong><span>{(b.manifest.bytes/1048576).toFixed(1)} مگابایت · صحت فایل هنگام دانلود یا بازیابی دوباره بررسی می‌شود</span><div className="row">
          {permissions.has("download")&&<a className="btn" href={`/api/backups/${b.id}/download`}>دانلود بکاپ</a>}
          {permissions.has("restore")&&<button className="btn" type="button" disabled={busy||active||unavailable||!!status?.needsRecovery} onClick={()=>{setSelected(b.manifest);setConfirmed(false);setPassword("");setCode("");operation.current=null;}}>بررسی برای بازیابی</button>}
        </div></>:<p role="alert">این بکاپ امضای معتبر ندارد و قابل استفاده نیست.</p>}
      </li>)}</ul>}
      {selected&&<form className="stack backup-confirm" onSubmit={e=>{e.preventDefault();void restore();}}>
        <h2>تأیید بازیابی همین بکاپ</h2><p>زمان انتخاب‌شده: <strong>{date(selected.createdAt)}</strong></p>
        <p>فاکتورها، دریافت‌ها، موجودی، مشتریان و تنظیمات ثبت‌شده پس از این زمان در نسخهٔ بازیابی‌شده وجود نخواهند داشت. قبل از جایگزینی، نسخهٔ بازگشت تازه گرفته می‌شود؛ نشست‌ها باطل می‌شوند و اتصال‌های بیرونی تا بررسی مدیر متوقف می‌مانند.</p>
        <p>رمزها، عوامل دوم و مجوزهای جاریِ کاربران موجود حفظ می‌شوند؛ رمز یا دسترسی لغوشده دوباره فعال نمی‌شود. دستگاه‌های صندوق نیازمند تأیید دوباره خواهند بود.</p>
        <label className="row"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} required/>بازگشت تمام داده‌ها به همین زمان را تأیید می‌کنم.</label>
        <label>رمز فعلی من<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required/></label>
        <label>عامل دوم<select value={factorKind} onChange={e=>{setFactorKind(e.target.value);setCode("");}}><option value="totp">کد برنامهٔ احراز هویت</option><option value="recovery">کد بازیابی یک‌بارمصرف</option></select></label>
        <label>کد عامل دوم<input autoComplete="one-time-code" value={code} onChange={e=>setCode(e.target.value.replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-1776)))} required maxLength={100}/></label>
        <div className="row"><button className="btn" type="submit" disabled={!confirmed||!password||!code||busy||active||unavailable||!!status.needsRecovery}>تأیید و شروع بازیابی</button><button className="btn" type="button" disabled={busy} onClick={()=>{setSelected(null);setPassword("");setCode("");}}>انصراف</button></div>
      </form>}
      <h2>تاریخچهٔ بازیابی</h2>{status.jobs.length?<ul className="backup-list">{status.jobs.map(j=><li key={j.id} className="solid pad stack"><strong>{phases[j.phase]??"وضعیت ناشناخته؛ با مدیر سامانه بررسی کنید"}</strong><span>{date(j.updatedAt)}</span><small className="break-anywhere">شناسهٔ پیگیری: {j.id}</small>{j.error&&<p role="alert">{j.error}</p>}{j.safetyBackupId&&<p>بکاپ بازگشت جداگانه ثبت شده است.</p>}</li>)}</ul>:<p>عملیات بازیابی ثبت نشده است.</p>}
    </>}
  </section>;
}
