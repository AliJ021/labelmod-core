import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { terminalPhase, type BackupStore } from "./backup-store.ts";
import type { RestoreDriver } from "./restore-manager.ts";

/** قفل بکاپِ قطع‌شده فقط وقتی هیچ بازیابی ناقصی وجود ندارد آزاد می‌شود. */
export async function recoverAbandonedBackupLock(store:BackupStore) {
  if((await store.jobs()).some(j=>!terminalPhase(j.phase)||j.phase==="manual_recovery"))
    throw new Error("بازیابی ناقص وجود دارد؛ از مسیر بازیابی همان عملیات استفاده کنید.");
  const file=path.join(store.root,"operation.lock"),raw=await readFile(file,"utf8");
  const lock=JSON.parse(raw) as {pid:number};
  if(!Number.isSafeInteger(lock.pid)||lock.pid<=0) throw new Error("قفل قابل اعتبارسنجی نیست.");
  try {process.kill(lock.pid,0);throw new Error("فرایند صاحب قفل هنوز وجود دارد؛ ابتدا سرویس را متوقف کنید.");}
  catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error;}
  if(await readFile(file,"utf8")!==raw) throw new Error("قفل تغییر کرده است؛ حذف نشد.");
  await unlink(file);
}

/** فقط CLI مدیر میزبان؛ از HTTP قابل فراخوانی نیست. */
export async function recoverInterruptedRestore(store:BackupStore,driver:RestoreDriver,jobId:string) {
  const job=await store.job(jobId);
  if(!["queued","verifying","rehearsing","quiescing","safety_backup","swapping","validating"].includes(job.phase)) throw new Error("این مرحله بازگشت خودکار امن ندارد؛ وضعیت ثبت‌های تازه باید توسط مدیر بررسی شود.");
  const lockPath=path.join(store.root,"operation.lock");
  let raw:string|null=null;
  try {raw=await readFile(lockPath,"utf8");} catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  if(raw) {
    const lock=JSON.parse(raw) as {pid:number};
    if(!Number.isSafeInteger(lock.pid)||lock.pid<=0) throw new Error("قفل عملیات قابل اعتبارسنجی نیست.");
    try {process.kill(lock.pid,0);throw new Error("فرایند صاحب قفل هنوز وجود دارد؛ ابتدا سرویس را متوقف و هویتش را بررسی کنید.");}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error;}
  }
  const touched=["quiescing","safety_backup","swapping","validating"].includes(job.phase);
  if(touched) {
    await driver.stopWriters();
    if(["swapping","validating"].includes(job.phase)) await driver.rollback(job);
    await driver.startWriters(false);
  }
  job.phase=touched?"rolled_back":"failed";job.updatedAt=new Date().toISOString();
  job.error="عملیات قطع‌شده با ابزار بازیابی مدیر بررسی و بسته شد.";
  await store.saveJob(job);
  if(raw) {
    if(await readFile(lockPath,"utf8")!==raw) throw new Error("قفل هم‌زمان تغییر کرده؛ حذف نشد.");
    await unlink(lockPath);
  }
  return job;
}
