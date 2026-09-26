/** فایل‌های این سرویس بیرون از دیتابیس و خارج از دسترس API عمومی‌اند. */
import { createHash, createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, unlink, stat } from "node:fs/promises";
import path from "node:path";

export interface BackupManifest {
  version: 1; id: string; instance: string; createdAt: string; database: string;
  serverMajor: number; schemaHash: string; bytes: number; sha256: string;
}
export type RestorePhase = "queued" | "verifying" | "rehearsing" | "quiescing" | "safety_backup" | "swapping" | "validating" | "resuming" | "completed" | "failed" | "rolled_back" | "manual_recovery";
export interface RestoreJob {
  id: string; backupId: string; actorId: string; createdAt: string; updatedAt: string;
  phase: RestorePhase; safetyBackupId?: string; error?: string;
  originalOid?: number; stagedOid?: number;
}
export const terminalPhase = (p: RestorePhase) => ["completed","failed","rolled_back","manual_recovery"].includes(p);
export function checkedId(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("شناسهٔ عملیات نامعتبر است.");
  return id;
}
export async function hashFile(file: string): Promise<{sha256:string;bytes:number}> {
  const hash=createHash("sha256"); let bytes=0;
  for await(const chunk of createReadStream(file)) { hash.update(chunk);bytes+=chunk.length; }
  return {sha256:hash.digest("hex"),bytes};
}

export class BackupStore {
  readonly root:string;
  readonly instance:string;
  private readonly signingKey:string;
  constructor(root: string, instance: string, signingKey: string) {
    this.root=root;this.instance=instance;this.signingKey=signingKey;
    if (!path.isAbsolute(root) || !/^[a-zA-Z0-9_-]{1,64}$/.test(instance) || !/^[a-f0-9]{64,128}$/i.test(signingKey)) throw new Error("پیکربندی مخزن بکاپ نامعتبر است.");
  }
  async init() {
    await mkdir(this.root,{recursive:true,mode:0o700});
    const info=await stat(this.root);
    if(!info.isDirectory() || (process.platform!=="win32" && (info.mode&0o077)!==0)) throw new Error("پوشهٔ بکاپ باید خصوصی و فقط در دسترس حساب سرویس باشد.");
  }
  file(id:string,kind:"dump"|"manifest"|"job") {return path.join(this.root,`${checkedId(id)}.${kind}`);}
  private mac(text:string) {return createHmac("sha256",this.signingKey).update(text).digest("hex");}
  private async atomic(file:string,value:unknown) {
    const temporary=file+"."+randomUUID()+".tmp";
    const fd=await open(temporary,"wx",0o600);
    try {await fd.writeFile(JSON.stringify(value),"utf8");await fd.sync();} finally {await fd.close();}
    // خوانندهٔ هم‌زمان یا آنتی‌ویروس در ویندوز ممکن است تغییر نام را لحظه‌ای قفل کند.
    for(let attempt=0;;attempt++) {
      try {await rename(temporary,file);break;}
      catch(error) {
        if(process.platform!=="win32" || attempt>=10 || !["EPERM","EACCES","EBUSY"].includes((error as NodeJS.ErrnoException).code??"")) throw error;
        await new Promise(resolve=>setTimeout(resolve,25*(attempt+1)));
      }
    }
    // روی لینوکس تغییر نام هم باید در برابر قطع برق پایدار شود.
    if(process.platform!=="win32") {const dir=await open(this.root,"r");try{await dir.sync();}finally{await dir.close();}}
  }
  async seal(manifest:BackupManifest) {
    if(manifest.instance!==this.instance) throw new Error("بکاپ متعلق به این نصب نیست.");
    const payload=JSON.stringify(manifest);
    await this.atomic(this.file(manifest.id,"manifest"),{payload,signature:this.mac(payload)});
  }
  async manifest(id:string):Promise<BackupManifest> {
    const raw=await readFile(this.file(id,"manifest"),"utf8");
    if(raw.length>16384) throw new Error("فرادادهٔ بکاپ نامعتبر است.");
    const signed=JSON.parse(raw) as {payload:string;signature:string};
    if(typeof signed.payload!=="string" || !/^[a-f0-9]{64}$/.test(signed.signature)) throw new Error("امضای بکاپ نامعتبر است.");
    if(!timingSafeEqual(Buffer.from(this.mac(signed.payload),"hex"),Buffer.from(signed.signature,"hex"))) throw new Error("امضای بکاپ معتبر نیست.");
    const manifest=JSON.parse(signed.payload) as BackupManifest;
    if(manifest.version!==1 || manifest.id!==id || manifest.instance!==this.instance || !Number.isSafeInteger(manifest.bytes) || manifest.bytes<=0 || !/^[a-f0-9]{64}$/.test(manifest.sha256) || !/^[a-f0-9]{64}$/.test(manifest.schemaHash) || !Number.isFinite(Date.parse(manifest.createdAt))) throw new Error("ساختار بکاپ معتبر نیست.");
    return manifest;
  }
  async verify(id:string) {
    const manifest=await this.manifest(id), actual=await hashFile(this.file(id,"dump"));
    if(actual.sha256!==manifest.sha256 || actual.bytes!==manifest.bytes) throw new Error("فایل بکاپ ناقص یا تغییرکرده است.");
    return manifest;
  }
  async backups() {
    const rows: Array<{id:string;manifest:BackupManifest|null;valid:boolean}>=[];
    for(const name of await readdir(this.root)) {
      if(!name.endsWith(".manifest")) continue;
      const id=name.slice(0,-9);
      try {rows.push({id,manifest:await this.manifest(id),valid:true});}
      catch {rows.push({id,manifest:null,valid:false});}
    }
    return rows.sort((a,b)=>(b.manifest?.createdAt??"").localeCompare(a.manifest?.createdAt??""));
  }
  async saveJob(job:RestoreJob) {await this.atomic(this.file(job.id,"job"),job);}
  async job(id:string):Promise<RestoreJob> {return JSON.parse(await readFile(this.file(id,"job"),"utf8")) as RestoreJob;}
  async jobs() {
    const rows:RestoreJob[]=[];
    for(const name of await readdir(this.root)) if(name.endsWith(".job")) rows.push(await this.job(name.slice(0,-4)));
    return rows.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  async consumeFactor(actorId:string,code:string) {
    const file=path.join(this.root,this.mac(checkedId(actorId)+":"+code)+".factor");
    try {
      const previous=Number(await readFile(file,"utf8"));
      if(!Number.isFinite(previous) || Date.now()-previous<120000) throw new Error("این کد عامل دوم تازه مصرف شده است؛ کد بعدی را وارد کنید.");
    }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;}
    await this.atomic(file,Date.now());
  }
  async operationState() {
    try {
      const lock=JSON.parse(await readFile(path.join(this.root,"operation.lock"),"utf8")) as {pid:number};
      if(!Number.isSafeInteger(lock.pid)||lock.pid<=0)return {busy:true,abandoned:true};
      try {process.kill(lock.pid,0);return {busy:true,abandoned:false};}
      catch(error){return {busy:true,abandoned:(error as NodeJS.ErrnoException).code==="ESRCH"};}
    }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return {busy:false,abandoned:false};throw error;}
  }
  /** قفل بین فرایندها؛ پس از مرگ فرایند خودکار حذف نمی‌شود. */
  async lock():Promise<()=>Promise<void>> {
    const file=path.join(this.root,"operation.lock");
    let fd;
    try {fd=await open(file,"wx",0o600);} catch {throw new Error("عملیات دیگری فعال است یا عملیات قبلی به بررسی بازیابی نیاز دارد.");}
    try {await fd.writeFile(JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}));await fd.sync();} finally {await fd.close();}
    if((await this.jobs()).some(j=>!terminalPhase(j.phase)||j.phase==="manual_recovery")) {
      // قفل حفظ می‌شود؛ حذف فایل قفل به‌تنهایی مجوز عبور از عملیات ناقص نیست.
      throw new Error("عملیات ناقص قبلی نیازمند بررسی مدیر سامانه است.");
    }
    return async()=>{await unlink(file);};
  }
}
