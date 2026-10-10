import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api.ts";
import { useLatestQuery } from "../lib/use-latest-query.ts";
import { ResultState } from "../components/ResultState.tsx";
import { PageHeader, SectionHeader } from "../components/ui/PageHeader.tsx";
import { Button, Field } from "../components/ui/Controls.tsx";
import { StatusBadge, type StatusState } from "../components/ui/Status.tsx";
import { Ltr } from "../components/ui/Bidi.tsx";
import { formatJalali } from "../lib/format.ts";

interface Manifest {id:string;createdAt:string;bytes:number;serverMajor:number;}
interface Job {id:string;backupId:string;phase:string;createdAt:string;updatedAt:string;error?:string;safetyBackupId?:string;}
interface Status {available:boolean;backups:Array<{id:string;valid:boolean;manifest:Manifest|null}>;jobs:Job[];needsRecovery:boolean;busy?:boolean;}
const phases:Record<string,string>={queued:"در صف",verifying:"بررسی صحت فایل",rehearsing:"بازیابی آزمایشی و کنترل مالی",quiescing:"توقف ثبت‌های سامانه",safety_backup:"ساخت بکاپ بازگشت",swapping:"جایگزینی دیتابیس",validating:"کنترل نسخهٔ جایگزین",resuming:"راه‌اندازی مجدد",completed:"بازیابی کامل شد؛ اتصال‌های بیرونی منتظر بررسی مدیرند",failed:"متوقف شد؛ اصلی جایگزین نشده",rolled_back:"بازگشت به نسخهٔ قبل انجام شد",manual_recovery:"رسیدگی مدیر سامانه لازم است"};
const backupDay=new Intl.DateTimeFormat("en-CA",{year:"numeric",month:"2-digit",day:"2-digit",timeZone:"Asia/Tehran"});
const backupTime=new Intl.DateTimeFormat("fa-IR",{timeStyle:"medium",timeZone:"Asia/Tehran"});
const date=(s:string)=>{
  const instant=new Date(s),parts=backupDay.formatToParts(instant);
  const part=(key:string)=>parts.find(p=>p.type===key)!.value;
  return `${formatJalali(`${part("year")}-${part("month")}-${part("day")}`)}، ${backupTime.format(instant)}`;
};
const message=(e:unknown)=>e instanceof ApiError?e.message:"ارتباط قطع شد؛ پیش از تلاش دوباره، تاریخچه را تازه‌سازی کنید.";
const finished=(phase:string)=>["completed","failed","rolled_back","manual_recovery"].includes(phase);
const phaseState=(phase:string):StatusState=>phase==="completed"?"completed":phase==="manual_recovery"?"attention":phase==="failed"?"failed":phase==="rolled_back"?"warning":Object.hasOwn(phases,phase)?"pending":"unknown";

export function Backups() {
  const [version,refresh]=useState(0),[error,setError]=useState(""),[busy,setBusy]=useState(false),[notice,setNotice]=useState("");
  const [selected,setSelected]=useState<Manifest|null>(null),[confirmed,setConfirmed]=useState(false);
  const [password,setPassword]=useState(""),[code,setCode]=useState(""),[factorKind,setFactorKind]=useState("totp");
  const operation=useRef<string|null>(null),working=useRef(false);
  const confirmation=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{if(selected){confirmation.current?.scrollIntoView({block:"start"});confirmation.current?.focus();}},[selected]);
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
  return <section className="operations-screen backup-center">
    <PageHeader title="پشتیبان‌گیری و بازیابی" context="نسخهٔ تازه بسازید، نسخه‌های موجود را دریافت کنید یا تاریخچهٔ بازیابی را ببینید."
      actions={<>{status?.available&&permissions.has("create")&&<Button variant="primary" disabled={busy||active||unavailable||status.needsRecovery} onClick={()=>void create()}>ساخت بکاپ تازه</Button>}
        <Button disabled={query.loading} onClick={()=>refresh(v=>v+1)}>تازه‌سازی تاریخچه</Button></>} />
    {error&&<p className="solid pad" role="alert">{error}</p>}{notice&&<p role="status" className="solid pad break-anywhere">{notice}</p>}
    {query.loading&&!status?<ResultState kind="loading" title="در حال بررسی سرویس بکاپ…"/>:query.error&&!status?<ResultState kind="error" title={message(query.error)} actionLabel="تلاش دوباره" onAction={()=>refresh(v=>v+1)}/>:status&&!status.available?<ResultState title="سرویس مستقل بکاپ هنوز متصل نشده است." description="مدیر سامانه باید فضای بکاپ و سرویس بازیابی را پیکربندی کند. تا آن زمان، عملیات از این صفحه اجرا نمی‌شود."/>:status&&<>
      {query.error&&<p role="alert">{message(query.error)} وضعیت نمایش‌داده‌شده از آخرین پاسخ تأییدشده است؛ عملیات تا تازه‌سازی موفق متوقف است.</p>}
      {active&&!status.needsRecovery&&<p role="status">عملیات بکاپ در حال اجراست؛ تاریخچه خودکار تازه می‌شود.</p>}
      {status.needsRecovery&&<p role="alert">عملیات فعال یا ناقص وجود دارد؛ ابتدا وضعیت آن را بررسی کنید.</p>}
      <section className="solid pad operations-section">
      <SectionHeader title="بکاپ‌های سامانه" description="صحت فایل هنگام دانلود یا بازیابی دوباره بررسی می‌شود. فایل دلخواه در این بخش پذیرفته نمی‌شود." />
      {!status.backups.length?<ResultState title="هنوز بکاپی در این سرویس ثبت نشده است." description={permissions.has("create")?"برای تهیهٔ نخستین نسخه، از «ساخت بکاپ تازه» استفاده کنید.":"ساخت نسخهٔ تازه به دسترسی پشتیبان‌گیری نیاز دارد."}/>:<ul className="operations-list">{status.backups.map(b=><li key={b.id} className="operations-entry">
        {b.valid&&b.manifest?<><div className="operations-entry-head"><strong>{date(b.manifest.createdAt)}</strong><StatusBadge state="archived" label="نسخهٔ پشتیبان" /></div><p className="muted small">{(b.manifest.bytes/1048576).toFixed(1)} مگابایت</p><div className="operations-actions">
          {permissions.has("download")&&<a className="btn" href={`/api/backups/${b.id}/download`}>دانلود بکاپ</a>}
          {permissions.has("restore")&&<button className="btn" type="button" disabled={busy||active||unavailable||!!status?.needsRecovery} onClick={()=>{setSelected(b.manifest);setConfirmed(false);setPassword("");setCode("");operation.current=null;}}>بررسی برای بازیابی</button>}
        </div></>:<><StatusBadge state="failed" label="غیرقابل استفاده" /><p role="alert">این بکاپ امضای معتبر ندارد و قابل استفاده نیست.</p></>}
      </li>)}</ul>}
      </section>
      {selected&&<form className="solid pad operations-section backup-confirm" aria-labelledby="backup-confirm-title" onSubmit={e=>{e.preventDefault();void restore();}}>
        <h2 id="backup-confirm-title" className="section-title" ref={confirmation} tabIndex={-1}>تأیید بازیابی همین بکاپ</h2><p>زمان انتخاب‌شده: <strong>{date(selected.createdAt)}</strong></p>
        <p>فاکتورها، دریافت‌ها، موجودی، مشتریان و تنظیمات ثبت‌شده پس از این زمان در نسخهٔ بازیابی‌شده وجود نخواهند داشت. قبل از جایگزینی، نسخهٔ بازگشت تازه گرفته می‌شود؛ نشست‌ها باطل می‌شوند و اتصال‌های بیرونی تا بررسی مدیر متوقف می‌مانند.</p>
        <p>رمزها، عوامل دوم و مجوزهای جاریِ کاربران موجود حفظ می‌شوند؛ رمز یا دسترسی لغوشده دوباره فعال نمی‌شود. دستگاه‌های صندوق نیازمند تأیید دوباره خواهند بود.</p>
        <label className="row"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} required/>بازگشت تمام داده‌ها به همین زمان را تأیید می‌کنم.</label>
        <div className="operations-fields">
        <Field label="رمز فعلی من"><input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required/></Field>
        <Field label="عامل دوم"><select value={factorKind} onChange={e=>{setFactorKind(e.target.value);setCode("");}}><option value="totp">کد برنامهٔ احراز هویت</option><option value="recovery">کد بازیابی یک‌بارمصرف</option></select></Field>
        <Field label="کد عامل دوم"><input autoComplete="one-time-code" value={code} onChange={e=>setCode(e.target.value.replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-1776)))} required maxLength={100}/></Field>
        </div>
        <div className="operations-actions"><Button variant="danger" type="submit" disabled={!confirmed||!password||!code||busy||active||unavailable||!!status.needsRecovery}>تأیید و شروع بازیابی</Button><Button disabled={busy} onClick={()=>{setSelected(null);setPassword("");setCode("");}}>انصراف</Button></div>
      </form>}
      <section className="solid pad operations-section"><SectionHeader title="تاریخچهٔ بازیابی" description="وضعیت هر درخواست و شناسهٔ پیگیری آن؛ وجود بکاپ به‌تنهایی به معنای آزموده‌شدن بازیابی نیست." />
      {status.jobs.length?<ul className="operations-list">{status.jobs.map(j=><li key={j.id} className="operations-entry"><div className="operations-entry-head"><StatusBadge state={phaseState(j.phase)} label={phases[j.phase]??"وضعیت ناشناخته؛ با مدیر سامانه بررسی کنید"}/><span className="muted small">{date(j.updatedAt)}</span></div><small className="muted break-anywhere">شناسهٔ پیگیری: <Ltr>{j.id}</Ltr></small>{j.error&&<p className="operations-error" role="alert">{j.error}</p>}{j.safetyBackupId&&<p>بکاپ بازگشت جداگانه ثبت شده است.</p>}</li>)}</ul>:<ResultState title="عملیات بازیابی ثبت نشده است."/>}</section>
    </>}
  </section>;
}
