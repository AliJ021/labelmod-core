import { randomUUID } from "node:crypto";
import { BackupStore, type BackupManifest, type RestoreJob, type RestorePhase } from "./backup-store.ts";

/** فقط در فرایند مدیریتی پیاده می‌شود؛ API هیچ فرمان یا مسیر اجرایی نمی‌فرستد. */
export interface RestoreDriver {
  backup(id:string):Promise<BackupManifest>;
  compatible(backup:BackupManifest):Promise<void>;
  rehearse(job:RestoreJob,backup:BackupManifest):Promise<void>;
  stopWriters():Promise<void>;
  swap(job:RestoreJob):Promise<void>;
  validatePrimary():Promise<void>;
  rollback(job:RestoreJob):Promise<void>;
  startWriters(restored:boolean):Promise<void>;
}
export class RestoreManager {
  readonly store:BackupStore;
  private readonly driver:RestoreDriver;
  constructor(store:BackupStore,driver:RestoreDriver) {this.store=store;this.driver=driver;}
  async createBackup() {
    const unlock=await this.store.lock();
    try {const backup=await this.driver.backup(randomUUID());await this.store.seal(backup);return backup;}
    finally {await unlock();}
  }
  /** تأیید زمان دقیق و شناسه از کاربر می‌آید؛ فایل دلخواه پذیرفته نمی‌شود. */
  async restore(input:{backupId:string;confirmedTimestamp:string;actorId:string;operationId:string}) {
    const unlock=await this.store.lock();
    let job:RestoreJob;
    try {
      const backup=await this.store.verify(input.backupId);
      if(input.confirmedTimestamp!==backup.createdAt) throw new Error("زمان بکاپ با تأیید شما یکسان نیست.");
      await this.driver.compatible(backup);
      // شناسهٔ عملیات تکراری حتی پس از پایان، بازیابی دوم ایجاد نمی‌کند.
      if((await this.store.jobs()).some(j=>j.id===input.operationId)) throw new Error("این شناسهٔ عملیات قبلاً استفاده شده است؛ تاریخچه را بررسی کنید.");
      const now=new Date().toISOString();
      job={id:input.operationId,backupId:backup.id,actorId:input.actorId,createdAt:now,updatedAt:now,phase:"queued"};
      await this.store.saveJob(job);
      // درخواست HTTP منتظر عملیات طولانی نمی‌ماند؛ قفل تا پایان نگه داشته می‌شود.
      void this.run(job,backup).then(async safe=>{if(safe) await unlock();}).catch(()=>{/* قفل برای بررسی دستی باقی می‌ماند. */});
    } catch(error) {await unlock();throw error;}
    return job;
  }
  private async run(job:RestoreJob,backup:BackupManifest):Promise<boolean> {
    let writersMayBeStopped=false, swapMayHaveStarted=false, writersMayHaveStarted=false;
    const phase=async(value:RestorePhase)=>{job.phase=value;job.updatedAt=new Date().toISOString();await this.store.saveJob(job);};
    try {
      await phase("verifying");await this.store.verify(backup.id);
      await phase("rehearsing");await this.driver.rehearse(job,backup);
      await this.driver.compatible(backup);
      await phase("quiescing");writersMayBeStopped=true;await this.driver.stopWriters();
      await phase("safety_backup");
      const safety=await this.driver.backup(randomUUID());await this.store.seal(safety);
      await this.store.verify(safety.id);job.safetyBackupId=safety.id;await this.store.saveJob(job);
      await phase("swapping");swapMayHaveStarted=true;await this.driver.swap(job);
      await phase("validating");await this.driver.validatePrimary();
      await phase("resuming");writersMayHaveStarted=true;await this.driver.startWriters(true);
      await phase("completed");return true;
    } catch {
      // پیام subprocess ممکن است دادهٔ مالی داشته باشد؛ در وضعیت عمومی نوشته نمی‌شود.
      job.error="عملیات در مرحلهٔ "+job.phase+" متوقف شد؛ جزئیات فنی نزد مدیر سامانه است.";
      if(writersMayHaveStarted) {await phase("manual_recovery");return false;}
      try {
        if(swapMayHaveStarted) await this.driver.rollback(job);
        if(writersMayBeStopped) await this.driver.startWriters(false);
        await phase(swapMayHaveStarted?"rolled_back":"failed");return true;
      } catch {await phase("manual_recovery");return false;}
    }
  }
}
