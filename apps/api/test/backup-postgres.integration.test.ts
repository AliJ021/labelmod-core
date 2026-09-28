import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createDisposableDb } from "./helpers/disposable-db.ts";
import { BackupStore, terminalPhase, type RestoreJob } from "../src/operations/backup-store.ts";
import { PostgresBackupDriver } from "../src/operations/postgres-backup-driver.ts";
import { RestoreManager } from "../src/operations/restore-manager.ts";

const databaseUrl=process.env.DATABASE_URL;
test("real PostgreSQL dump, isolated rehearsal, database swap and rollback preserve exact database identity",{skip:databaseUrl?false:"DATABASE_URL لازم است"},async()=>{
  const disposable=createDisposableDb(databaseUrl!);assert.ok(disposable);
  const root=await mkdtemp(path.join(tmpdir(),"labelmod-pg-backup-test-"));
  const names:string[]=[];
  const adminUrl=new URL(disposable.ownerUrl);const primary=adminUrl.pathname.slice(1);adminUrl.pathname="/postgres";
  assert.ok(primary.startsWith("labelmod_apitest_"));
  const admin=new pg.Client({connectionString:adminUrl.toString()});await admin.connect();
  const pgBin=(process.env.PATH??"").split(path.delimiter).find(p=>existsSync(path.join(p,process.platform==="win32"?"pg_dump.exe":"pg_dump")));
  assert.ok(pgBin,"کلاینت pg_dump باید در PATH باشد");
  const store=new BackupStore(root,"local-test","1".repeat(64));await store.init();
  const controls:string[]=[];
  const driver=new PostgresBackupDriver(store,{databaseUrl:disposable.ownerUrl,pgBin:path.resolve(pgBin),writerHook:path.resolve("ops/backup-writers.sh")},async action=>{controls.push(action);});
  const manager=new RestoreManager(store,driver);
  const query=async(sql:string,values?:unknown[])=>{const client=new pg.Client({connectionString:disposable.ownerUrl});await client.connect();try{return await client.query(sql,values);}finally{await client.end();}};
  try {
    const user=await query("INSERT INTO identity.app_user(username,full_name,password_hash) VALUES ($1,'کاربر تست بازیابی','synthetic-unused-hash') RETURNING id",["restore_user_"+randomUUID()]);
    await query("INSERT INTO identity.user_role(user_id,role_code,branch_id) VALUES ($1,'admin',NULL)",[user.rows[0].id]);
    await query("INSERT INTO identity.session(token_hash,user_id,auth_method,expires_at) VALUES ($1,$2,'password',now()+interval '1 day')",["2".repeat(64),user.rows[0].id]);
    const backup=await manager.createBackup();await store.verify(backup.id);
    await query("UPDATE identity.app_user SET password_hash='newer-synthetic-unused-hash' WHERE id=$1",[user.rows[0].id]);
    await query("INSERT INTO catalog.product(code,name_internal) VALUES ('AFTER_BACKUP','فقط پس از بکاپ')");
    const job:RestoreJob={id:randomUUID(),backupId:backup.id,actorId:user.rows[0].id,phase:"rehearsing",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    names.push("lm_restore_"+job.id.replaceAll("-",""),"lm_previous_"+job.id.replaceAll("-",""),"lm_failed_"+job.id.replaceAll("-",""));
    // اجرای مستقیم مراحل، خطای واقعی کلاینت/SQL را پیش از آزمون مسیر پس‌زمینه آشکار می‌کند.
    await driver.rehearse(job,backup);
    assert.equal(Number((await query("SELECT count(*) AS n FROM catalog.product WHERE code='AFTER_BACKUP'")).rows[0].n),1);
    const safety=await driver.backup(randomUUID());await store.seal(safety);job.safetyBackupId=safety.id;
    await driver.stopWriters();await driver.swap(job);await driver.validatePrimary();
    assert.equal(Number((await query("SELECT count(*) AS n FROM catalog.product WHERE code='AFTER_BACKUP'")).rows[0].n),0);
    assert.equal(Number((await query("SELECT count(*) AS n FROM identity.session WHERE revoked_at IS NULL")).rows[0].n),0);
    assert.equal((await query("SELECT password_hash FROM identity.app_user WHERE id=$1",[user.rows[0].id])).rows[0].password_hash,"newer-synthetic-unused-hash");
    assert.equal(Number((await query("SELECT oid FROM pg_database WHERE datname=current_database()")).rows[0].oid),job.stagedOid);
    await driver.rollback(job);
    assert.equal(Number((await query("SELECT count(*) AS n FROM catalog.product WHERE code='AFTER_BACKUP'")).rows[0].n),1);
    assert.equal(Number((await query("SELECT oid FROM pg_database WHERE datname=current_database()")).rows[0].oid),job.originalOid);
    // نسخهٔ تمرین اول تنها دادهٔ آزمایشی این تست است؛ وضعیت آن دستی بسته می‌شود.
    job.phase="rolled_back";await store.saveJob(job);
    const automatic=await manager.restore({backupId:backup.id,confirmedTimestamp:backup.createdAt,actorId:user.rows[0].id,operationId:randomUUID()});
    names.push("lm_restore_"+automatic.id.replaceAll("-",""),"lm_previous_"+automatic.id.replaceAll("-",""),"lm_failed_"+automatic.id.replaceAll("-",""));
    let result=automatic;
    for(let n=0;n<600&&!terminalPhase(result.phase);n++){await new Promise(r=>setTimeout(r,100));result=await store.job(automatic.id);}
    assert.equal(result.phase,"completed",JSON.stringify(result));
    assert.ok(result.safetyBackupId);await store.verify(result.safetyBackupId);
    assert.deepEqual(controls,["stop","stop","resume-restored"]);
    assert.equal(Number((await query("SELECT count(*) AS n FROM identity.app_user WHERE lower(username) IN ('bardia','recovery_admin') AND is_active")).rows[0].n),0);
  }finally {
    // فقط نام‌های تصادفی همین آزمون؛ هیچ نام عملیاتی یا محاسبه‌شدهٔ آزاد حذف نمی‌شود.
    for(const name of names) {
      assert.match(name,/^lm_(restore|previous|failed)_[a-f0-9]{32}$/);
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
    await admin.end();disposable.drop();
    assert.equal(path.dirname(root),tmpdir());assert.ok(path.basename(root).startsWith("labelmod-pg-backup-test-"));await rm(root,{recursive:true});
  }
});
