import pg from "pg";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { chmod } from "node:fs/promises";
import { BackupStore, hashFile, type BackupManifest, type RestoreJob } from "./backup-store.ts";
import type { RestoreDriver } from "./restore-manager.ts";

const execute=promisify(execFile);
const name=(s:string)=>{if(!/^[a-z_][a-z0-9_]{0,62}$/.test(s)) throw new Error("نام دیتابیس نامعتبر است.");return '"'+s+'"';};
const stageName=(job:RestoreJob)=>"lm_restore_"+job.id.replaceAll("-","");
const previousName=(job:RestoreJob)=>"lm_previous_"+job.id.replaceAll("-","");
const failedName=(job:RestoreJob)=>"lm_failed_"+job.id.replaceAll("-","");
export interface BackupDriverConfig {databaseUrl:string;pgBin:string;writerHook:string;}

/** فقط این فرایند مستقل، اعتبارنامهٔ مالک و برنامهٔ توقف نویسنده‌ها را دارد. */
export class PostgresBackupDriver implements RestoreDriver {
  readonly primary:string;
  private readonly url:URL;
  readonly store:BackupStore;
  private readonly config:BackupDriverConfig;
  private readonly writerControl:((action:"stop"|"resume-original"|"resume-restored")=>Promise<void>)|undefined;
  constructor(store:BackupStore,config:BackupDriverConfig,writerControl?: (action:"stop"|"resume-original"|"resume-restored")=>Promise<void>) {
    this.store=store;this.config=config;this.writerControl=writerControl;
    this.url=new URL(config.databaseUrl);this.primary=decodeURIComponent(this.url.pathname.slice(1));name(this.primary);
    if(["postgres","template0","template1"].includes(this.primary) || !path.isAbsolute(config.pgBin) || !path.isAbsolute(config.writerHook)) throw new Error("هدف سرویس مدیریتی نامعتبر است.");
  }
  private connection(database:string) {const url=new URL(this.url);url.pathname="/"+database;return new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:10000,application_name:"labelmod-backup-manager"});}
  private async using<T>(database:string,run:(client:pg.Client)=>Promise<T>) {const client=this.connection(database);await client.connect();try{return await run(client);}finally{await client.end();}}
  private environment(database:string):NodeJS.ProcessEnv {
    return {...process.env,PGHOST:this.url.hostname,PGPORT:this.url.port||"5432",PGUSER:decodeURIComponent(this.url.username),PGPASSWORD:decodeURIComponent(this.url.password),PGDATABASE:database,PGCLIENTENCODING:"UTF8",PGCONNECT_TIMEOUT:"10",
      ...(this.url.searchParams.get("sslmode")?{PGSSLMODE:this.url.searchParams.get("sslmode")!}:{})};
  }
  private async command(tool:"pg_dump"|"pg_restore",args:string[],database:string) {
    try {await execute(path.join(this.config.pgBin,tool+(process.platform==="win32"?".exe":"")),args,{env:this.environment(database),timeout:60*60*1000,maxBuffer:1024*1024,windowsHide:true});}
    catch {throw new Error("ابزار پستگرس عملیات را کامل نکرد؛ بکاپ یا بازیابی معتبر اعلام نشد.");}
  }
  private async metadata(client:pg.Client) {
    const rows=await client.query("SELECT filename,checksum FROM public.schema_migration ORDER BY filename");
    if(rows.rows.length===0) throw new Error("تاریخچهٔ مهاجرت پیدا نشد.");
    const version=await client.query("SELECT current_setting('server_version_num')::int AS version");
    return {schemaHash:createHash("sha256").update(JSON.stringify(rows.rows)).digest("hex"),serverMajor:Math.floor(Number(version.rows[0].version)/10000)};
  }
  async backup(id:string):Promise<BackupManifest> {
    return this.using(this.primary,async client=>{
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        const snapshot=await client.query("SELECT pg_export_snapshot() AS snapshot,clock_timestamp() AS created_at");
        const meta=await this.metadata(client);
        const file=this.store.file(id,"dump");
        await this.command("pg_dump",["--format=custom","--no-password","--snapshot="+snapshot.rows[0].snapshot,"--file="+file],this.primary);
        await chmod(file,0o600);
        const digest=await hashFile(file);
        await client.query("COMMIT");
        return {version:1,id,instance:this.store.instance,database:this.primary,createdAt:new Date(snapshot.rows[0].created_at).toISOString(),...meta,...digest};
      } catch(error) {await client.query("ROLLBACK");throw error;}
    });
  }
  async compatible(backup:BackupManifest) {
    const current=await this.using(this.primary,c=>this.metadata(c));
    if(backup.database!==this.primary || backup.serverMajor!==current.serverMajor || backup.schemaHash!==current.schemaHash) throw new Error("نسخهٔ پستگرس یا مهاجرت‌های بکاپ با سامانهٔ فعلی یکسان نیست.");
  }
  async rehearse(job:RestoreJob,backup:BackupManifest) {
    await this.store.verify(backup.id);
    const stage=stageName(job);
    await this.using("postgres",async client=>{
      const original=await client.query("SELECT oid FROM pg_database WHERE datname=$1",[this.primary]);
      job.originalOid=Number(original.rows[0]?.oid);
      if(!job.originalOid) throw new Error("دیتابیس اصلی پیدا نشد.");
      await client.query(`CREATE DATABASE ${name(stage)} TEMPLATE template0`);
      const staged=await client.query("SELECT oid FROM pg_database WHERE datname=$1",[stage]);job.stagedOid=Number(staged.rows[0].oid);
      await this.store.saveJob(job);
    });
    await this.command("pg_restore",["--exit-on-error","--single-transaction","--no-password","--dbname="+stage,this.store.file(backup.id,"dump")],stage);
    await this.using(stage,async client=>{
      const meta=await this.metadata(client);
      if(meta.schemaHash!==backup.schemaHash) throw new Error("مهاجرت‌های نسخهٔ آزمایشی با بکاپ یکسان نیست.");
      await this.checkFinancial(client);
      // نشست‌های پیش از بازیابی معتبر نیستند؛ حساب ممنوع فقط غیرفعال می‌شود و ساخته نمی‌شود.
      await client.query("BEGIN");
      try {
        await client.query("UPDATE identity.session SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL");
        await client.query("UPDATE identity.pending_login SET expires_at=clock_timestamp() WHERE expires_at>clock_timestamp()");
        await client.query("UPDATE identity.api_client SET is_active=false WHERE is_active");
        await client.query("UPDATE identity.app_user SET is_active=false WHERE lower(username) IN ('bardia','recovery_admin') AND is_active");
        await client.query("COMMIT");
      }catch(error){await client.query("ROLLBACK");throw error;}
      await this.checkFinancial(client);
    });
  }
  private async hook(action:"stop"|"resume-original"|"resume-restored") {
    if(this.writerControl) {await this.writerControl(action);return;}
    // مسیر از تنظیم محلی مدیر است؛ هیچ رشتهٔ HTTP به فرمان تبدیل نمی‌شود.
    try {await execute(this.config.writerHook,[action],{timeout:180000,maxBuffer:1024*1024,windowsHide:true});}
    catch {throw new Error("توقف یا راه‌اندازی نویسنده‌ها تأیید نشد.");}
  }
  async stopWriters() {await this.hook("stop");}
  async startWriters(restored:boolean) {await this.hook(restored?"resume-restored":"resume-original");}
  private async fence(client:pg.Client,database:string) {
    await client.query(`ALTER DATABASE ${name(database)} ALLOW_CONNECTIONS false`);
    await client.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",[database]);
  }
  async swap(job:RestoreJob) {
    if(!job.safetyBackupId || !job.originalOid || !job.stagedOid) throw new Error("پیش‌شرط جایگزینی کامل نیست.");
    await this.store.verify(job.safetyBackupId);
    await this.preserveCurrentIdentity(job);
    await this.using("postgres",async client=>{
      const rows=await client.query("SELECT datname,oid FROM pg_database WHERE datname=ANY($1::text[])",[[this.primary,stageName(job)]]);
      if(!rows.rows.some(r=>r.datname===this.primary && Number(r.oid)===job.originalOid) || !rows.rows.some(r=>r.datname===stageName(job) && Number(r.oid)===job.stagedOid)) throw new Error("هویت دیتابیس از زمان تمرین تغییر کرده است.");
      await this.fence(client,this.primary);await this.fence(client,stageName(job));
      await client.query("BEGIN");
      try {
        await client.query(`ALTER DATABASE ${name(this.primary)} RENAME TO ${name(previousName(job))}`);
        await client.query(`ALTER DATABASE ${name(stageName(job))} RENAME TO ${name(this.primary)}`);
        await client.query("COMMIT");
      }catch(error){await client.query("ROLLBACK");throw error;}
      await client.query(`ALTER DATABASE ${name(this.primary)} ALLOW_CONNECTIONS true`);
    });
  }
  private async preserveCurrentIdentity(job:RestoreJob) {
    // بازیابی مالی نباید رمز تغییرکرده، عامل حذف‌شده یا مجوز لغوشده را دوباره معتبر کند.
    // پس از توقف نویسنده‌ها، امنیت جاری فقط برای شناسه‌های موجود در بکاپ حفظ می‌شود.
    const tables=["role","permission_rule","user_role","webauthn_credential","recovery_code","sms_factor"] as const;
    const current=await this.using(this.primary,async client=>{
      const users=await client.query("SELECT id,username,password_hash,pin_hash,totp_secret,mobile,is_active FROM identity.app_user");
      const settings=await client.query("SELECT key,value FROM platform.setting WHERE key LIKE 'auth.%' AND is_editable");
      const records:Record<string,unknown[]>={};
      for(const table of tables) records[table]=(await client.query(`SELECT * FROM identity.${table}`)).rows;
      return {users:users.rows,records,settings:settings.rows};
    });
    await this.using(stageName(job),async client=>{
      await client.query("BEGIN");
      try {
        await client.query("SELECT platform.set_actor($1::uuid)",[job.actorId]);
        await client.query(`UPDATE identity.app_user SET is_active=false
          WHERE NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS live(id uuid,username text)
            WHERE live.id=identity.app_user.id AND live.username=identity.app_user.username)`,[JSON.stringify(current.users)]);
        await client.query(`UPDATE identity.app_user u SET password_hash=live.password_hash,pin_hash=live.pin_hash,
          totp_secret=live.totp_secret,mobile=live.mobile,is_active=live.is_active AND lower(u.username) NOT IN ('bardia','recovery_admin')
          FROM jsonb_to_recordset($1::jsonb) AS live(id uuid,username text,password_hash text,pin_hash text,totp_secret text,mobile text,is_active boolean)
          WHERE u.id=live.id AND u.username=live.username`,[JSON.stringify(current.users)]);
        await client.query("INSERT INTO identity.role SELECT * FROM json_populate_recordset(NULL::identity.role,$1::json) ON CONFLICT(code) DO NOTHING",[JSON.stringify(current.records.role)]);
        for(const table of tables.filter(t=>t!=="role")) {
          await client.query(`DELETE FROM identity.${table}`);
          const hasUser=table!=="permission_rule";
          const branch=table==="user_role"?" AND (src.branch_id IS NULL OR EXISTS(SELECT 1 FROM platform.branch b WHERE b.id=src.branch_id))":"";
          await client.query(`INSERT INTO identity.${table} SELECT src.* FROM json_populate_recordset(NULL::identity.${table},$1::json) src
            ${hasUser?"WHERE EXISTS(SELECT 1 FROM identity.app_user u WHERE u.id=src.user_id AND u.is_active)"+branch:""}`,[JSON.stringify(current.records[table])]);
        }
        await client.query("DELETE FROM identity.totp_enrollment");
        await client.query("DELETE FROM identity.webauthn_challenge");
        await client.query("DELETE FROM identity.sms_challenge");
        await client.query("UPDATE identity.device SET secret_hash=NULL,is_approved=false,approved_at=NULL,approved_by=NULL");
        const operator=await client.query(`SELECT u.id FROM identity.app_user u WHERE u.id=$1::uuid AND u.is_active
          AND EXISTS(SELECT 1 FROM identity.user_role r WHERE r.user_id=u.id AND r.branch_id IS NULL)
          AND EXISTS(SELECT 1 FROM identity.can(u.id,'backup.restore',NULL,NULL,false) WHERE verdict='allow')`,[job.actorId]);
        if(!operator.rows.length) throw new Error("مدیر درخواست‌کننده در نسخهٔ بازیابی‌شده دسترسی معتبر نخواهد داشت؛ جایگزینی متوقف شد.");
        for(const setting of current.settings) await client.query("SELECT platform.set_setting($1,$2::jsonb,'حفظ سیاست امنیتی جاری هنگام بازیابی')",[setting.key,JSON.stringify(setting.value)]);
        await client.query("SELECT platform.audit('backup.restore_identity','backup',$1::text,jsonb_build_object('jobId',$2::text),$3::uuid)",[job.backupId,job.id,job.actorId]);
        await client.query("COMMIT");
      }catch(error){await client.query("ROLLBACK");throw error;}
    });
  }
  async rollback(job:RestoreJob) {
    await this.using("postgres",async client=>{
      const current=await client.query("SELECT oid FROM pg_database WHERE datname=$1",[this.primary]);
      const oid=Number(current.rows[0]?.oid);
      if(oid===job.originalOid) {await client.query(`ALTER DATABASE ${name(this.primary)} ALLOW_CONNECTIONS true`);return;}
      const old=await client.query("SELECT oid FROM pg_database WHERE datname=$1",[previousName(job)]);
      if(oid!==job.stagedOid || Number(old.rows[0]?.oid)!==job.originalOid) throw new Error("هویت نسخهٔ بازگشت قابل اثبات نیست.");
      await this.fence(client,this.primary);
      await client.query("BEGIN");
      try {
        await client.query(`ALTER DATABASE ${name(this.primary)} RENAME TO ${name(failedName(job))}`);
        await client.query(`ALTER DATABASE ${name(previousName(job))} RENAME TO ${name(this.primary)}`);
        await client.query("COMMIT");
      }catch(error){await client.query("ROLLBACK");throw error;}
      await client.query(`ALTER DATABASE ${name(this.primary)} ALLOW_CONNECTIONS true`);
    });
  }
  async validatePrimary() {
    await this.using(this.primary,async client=>{
      await this.checkFinancial(client);
      const result=await client.query("SELECT (SELECT count(*) FROM identity.session WHERE revoked_at IS NULL) + (SELECT count(*) FROM identity.app_user WHERE is_active AND lower(username) IN ('bardia','recovery_admin')) AS n");
      if(Number(result.rows[0].n)!==0) throw new Error("کنترل نشست‌ها و حساب‌های ممنوع موفق نشد.");
    });
  }
  private async checkFinancial(client:pg.Client) {
    const queries=[
      "SELECT count(*) AS n FROM (SELECT entry_id FROM ledger.journal_line GROUP BY entry_id HAVING sum(debit)<>sum(credit)) x",
      "SELECT count(*) AS n FROM inventory.stock_balance WHERE on_hand<0",
      "SELECT count(*) AS n FROM inventory.balance_check WHERE qty_diff<>0 OR value_diff<>0",
      "SELECT count(*) AS n FROM inventory.ledger_check WHERE diff<>0",
      "SELECT count(*) AS n FROM platform.audit_check",
      "SELECT count(*) AS n FROM ledger.party_check",
      "SELECT count(*) AS n FROM treasury.cheque_check WHERE diff<>0",
    ];
    for(const query of queries) if(Number((await client.query(query)).rows[0].n)!==0) throw new Error("کنترل سازگاری مالی یا حسابرسی بازیابی ناموفق بود.");
  }
}
