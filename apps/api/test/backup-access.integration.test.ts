import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { createDisposableDb } from "./helpers/disposable-db.ts";
import { createDb } from "../src/db/client.ts";
import { hashSecret } from "../src/auth/password.ts";
import { AuthService } from "../src/auth/service.ts";
import { totp } from "../src/auth/totp.ts";
import { loadConfig } from "../src/lib/config.ts";
import { buildApp } from "../src/http/app.ts";
import { loginWithMfa } from "./helpers/login-with-mfa.ts";
import { BackupStore, hashFile, terminalPhase } from "../src/operations/backup-store.ts";
import { RestoreManager, type RestoreDriver } from "../src/operations/restore-manager.ts";
import { buildManagementApp } from "../src/operations/management-app.ts";

test("backup routes enforce independent permissions, global scope, password and fresh second factor",{skip:process.env.DATABASE_URL?false:"DATABASE_URL لازم است"},async()=>{
  const disposable=createDisposableDb(process.env.DATABASE_URL!);assert.ok(disposable);
  const handle=createDb(disposable.url,3);
  const root=await mkdtemp(path.join(tmpdir(),"labelmod-backup-access-"));
  const store=new BackupStore(root,"access-test","a".repeat(64));await store.init();
  let swaps=0;
  const driver:RestoreDriver={
    async backup(id){await writeFile(store.file(id,"dump"),"isolated access-control fixture");return {version:1,id,instance:store.instance,database:"access_test",serverMajor:16,schemaHash:"b".repeat(64),createdAt:new Date().toISOString(),...await hashFile(store.file(id,"dump"))};},
    async compatible(){},async rehearse(){},async stopWriters(){},async swap(){swaps++;},async validatePrimary(){},async rollback(){},async startWriters(){},
  };
  const manager=new RestoreManager(store,driver);const backup=await manager.createBackup();
  const app=await buildApp({db:handle.db,auth:new AuthService(handle.db),config:loadConfig({...process.env,NODE_ENV:"test",LOG_LEVEL:"fatal"})});
  // سرویس مستقل بکاپ در تولید با نقش **مالک** وصل است (`OPS_DATABASE_URL`)، نه نقش برنامه؛
  // با `LMC_TEST_DB_ROLE=app` هم باید همان‌طور بماند، وگرنه ثبت سابقهٔ بکاپ (که از نقش برنامه
  // گرفته شده) اینجا به‌اشتباه می‌شکست.
  const owner=createDb(disposable.ownerUrl,2);
  const rpcToken="c".repeat(64),management=await buildManagementApp({db:owner.db,manager,rpcToken});
  await app.ready();await management.ready();
  const password="backup-access-only-strong-password";
  try {
    const hash=await hashSecret(password),branch=(await sql<{id:string}>`SELECT id FROM platform.branch WHERE code='MAIN'`.execute(handle.db)).rows[0]!.id;
    const users:Array<{role:string;branch:string|null;id:string;token:string;cookies:Record<string,string>;headers:Record<string,string>}> = [];
    for(const [index,kind] of ["global","scoped","cashier"].entries()) {
      const username="backup_"+kind+"_"+randomUUID();
      const user=await handle.db.insertInto("identity.app_user").values({username,full_name:"کاربر آزمون بکاپ",password_hash:hash,is_active:true,mobile:null,pin_hash:null,totp_secret:null}).returning("id").executeTakeFirstOrThrow();
      const role=kind==="cashier"?"cashier":"admin",scope=kind==="global"?null:branch;
      await handle.db.insertInto("identity.user_role").values({user_id:user.id,role_code:role,branch_id:scope}).execute();
      const login=await loginWithMfa(app,{method:"POST",url:"/auth/login",remoteAddress:`127.0.1.${index+1}`,payload:{username,password,deviceFingerprint:username}});
      assert.equal(login.statusCode,200,login.body);
      const cookies=Object.fromEntries(login.cookies.map(c=>[c.name,c.value]));
      users.push({role,branch:scope,id:user.id,token:cookies.labelmod_session!,cookies,headers:{"x-csrf-token":cookies.labelmod_csrf!}});
    }
    const admin=users[0]!;
    const unavailable=await app.inject({method:"GET",url:"/backups",cookies:admin.cookies});
    assert.equal(unavailable.statusCode,200,unavailable.body);assert.equal(unavailable.json().available,false);
    for(const user of users.slice(1)) {
      for(const url of ["/backups",`/backups/${backup.id}/download`]) {
        const denied=await app.inject({method:"GET",url,cookies:user.cookies});assert.equal(denied.statusCode,403,denied.body);
      }
    }
    const channel={authorization:"Bearer "+rpcToken,"x-labelmod-session":admin.token};
    const noChannel=await management.inject({method:"GET",url:"/status",headers:{"x-labelmod-session":admin.token}});assert.equal(noChannel.statusCode,401);
    const restricted=await management.inject({method:"GET",url:"/status",headers:{...channel,"x-labelmod-session":users[1]!.token}});assert.equal(restricted.statusCode,403);
    const download=await management.inject({method:"GET",url:`/download/${backup.id}`,headers:channel});assert.equal(download.statusCode,200,download.body);
    // مهاجرت ۱۲۲: چه کسی بکاپ را بیرون برد در حسابرسی، و «نسخهٔ بیرونی» در سابقهٔ بکاپ.
    const events=async()=>(await sql<{kind:string;source:string;backup_ref:string;actor_id:string|null;sha256:string|null}>`
      SELECT kind,source,backup_ref,actor_id,sha256 FROM platform.backup_event ORDER BY occurred_at`.execute(handle.db)).rows;
    for(let n=0;n<100&&!(await events()).some(e=>e.kind==="downloaded");n++)await new Promise(r=>setTimeout(r,10));
    assert.deepEqual(await events(),[{kind:"downloaded",source:"manager",backup_ref:backup.id,actor_id:admin.id,sha256:backup.sha256}]);
    const downloadAudit=await sql<{actor_id:string;entity_id:string}>`SELECT actor_id,entity_id FROM platform.audit_log WHERE action='backup.download'`.execute(handle.db);
    assert.deepEqual(downloadAudit.rows,[{actor_id:admin.id,entity_id:backup.id}]);
    assert.equal((await sql<{n:string}>`SELECT n::text FROM platform.health_alerts() WHERE code='backup_offsite_stale'`.execute(handle.db)).rows[0]!.n,"0");
    // ساخت از پنل هم ثبت می‌شود؛ ساختِ مستقیم مدیر (بالا، بیرون از مسیر) نه.
    const created=await management.inject({method:"POST",url:"/backup",headers:channel,payload:{}});assert.equal(created.statusCode,200,created.body);
    assert.deepEqual((await events()).map(e=>[e.kind,e.backup_ref,e.actor_id]),[["downloaded",backup.id,admin.id],["created",created.json().id,admin.id]]);
    assert.equal((await sql<{n:string}>`SELECT n::text FROM platform.health_alerts() WHERE code='backup_stale'`.execute(handle.db)).rows[0]!.n,"0");
    // دانلودِ ردشده نه حسابرسی دانلود می‌سازد و نه نسخهٔ بیرونی.
    const unknownBackup=await management.inject({method:"GET",url:`/download/${randomUUID()}`,headers:channel});assert.notEqual(unknownBackup.statusCode,200);
    assert.equal((await events()).filter(e=>e.kind==="downloaded").length,1);
    const secret=await handle.db.selectFrom("identity.app_user").select("totp_secret").where("id","=",admin.id).executeTakeFirstOrThrow();assert.ok(secret.totp_secret);
    const code=totp(secret.totp_secret);
    const payload={backupId:backup.id,operationId:randomUUID(),confirmedTimestamp:backup.createdAt,password,code,factorKind:"totp"};
    const wrongPassword=await management.inject({method:"POST",url:"/restore",headers:channel,payload:{...payload,password:"wrong-password"}});assert.equal(wrongPassword.statusCode,403);assert.equal(swaps,0);
    const wrongFactor=await management.inject({method:"POST",url:"/restore",headers:channel,payload:{...payload,code:"bad-factor"}});assert.equal(wrongFactor.statusCode,403);assert.equal(swaps,0);
    const accepted=await management.inject({method:"POST",url:"/restore",headers:channel,payload});assert.equal(accepted.statusCode,202,accepted.body);
    for(let n=0;n<300&&!terminalPhase((await store.job(payload.operationId)).phase);n++)await new Promise(r=>setTimeout(r,10));
    assert.equal((await store.job(payload.operationId)).phase,"completed");assert.equal(swaps,1);
    const replay=await management.inject({method:"POST",url:"/restore",headers:channel,payload:{...payload,operationId:randomUUID()}});assert.equal(replay.statusCode,409);assert.equal(swaps,1);
    // مجوز دانلود جدا از مشاهده است؛ لغو آن باید در خود سرویس نیز اعمال شود.
    await sql`UPDATE identity.permission_rule SET allowed=false WHERE role_code='admin' AND operation='backup.download'`.execute(handle.db);
    const deniedDownload=await management.inject({method:"GET",url:`/download/${backup.id}`,headers:channel});assert.equal(deniedDownload.statusCode,403);
    const stillVisible=await management.inject({method:"GET",url:"/status",headers:channel});assert.equal(stillVisible.statusCode,200);
  } finally {
    await management.close();await app.close();await owner.close();await handle.close();disposable.drop();
    assert.equal(path.dirname(root),tmpdir());assert.ok(path.basename(root).startsWith("labelmod-backup-access-"));await rm(root,{recursive:true});
  }
});
