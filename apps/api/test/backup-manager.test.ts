import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BackupStore, hashFile, terminalPhase, type RestoreJob } from "../src/operations/backup-store.ts";
import { RestoreManager, type RestoreDriver } from "../src/operations/restore-manager.ts";
import { recoverAbandonedBackupLock } from "../src/operations/recover-restore.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";

async function fixture() {
  const root=await mkdtemp(path.join(tmpdir(),"labelmod-backup-test-"));
  const store=new BackupStore(root,"test-instance","a".repeat(64));await store.init();
  const events:string[]=[];let failure="";let hold:Promise<void>|null=null;
  const driver:RestoreDriver={
    async backup(id) {
      events.push("backup");if(failure==="backup")throw new Error("private diagnostic");
      await writeFile(store.file(id,"dump"),"verified fixture backup");
      return {version:1,id,instance:store.instance,database:"labelmod_test",serverMajor:16,schemaHash:"b".repeat(64),createdAt:new Date().toISOString(),...await hashFile(store.file(id,"dump"))};
    },
    async compatible(){events.push("compatible");if(failure==="compatible")throw new Error("wrong version");},
    async rehearse(){events.push("rehearse");if(hold)await hold;if(failure==="rehearse")throw new Error("unbalanced ledger");},
    async stopWriters(){events.push("stop");},
    async swap(){events.push("swap");if(failure==="swap")throw new Error("connection lost after commit");},
    async validatePrimary(){events.push("validate");if(failure==="validate")throw new Error("bad primary");},
    async rollback(){events.push("rollback");if(failure==="rollback")throw new Error("cannot rollback");},
    async startWriters(restored){events.push(restored?"start-restored":"start-original");if(failure==="start")throw new Error("writer result unknown");},
  };
  const manager=new RestoreManager(store,driver);
  const backup=await manager.createBackup();events.length=0;
  const start=()=>manager.restore({backupId:backup.id,confirmedTimestamp:backup.createdAt,actorId:randomUUID(),operationId:randomUUID()});
  const cleanup=async()=>{assert.equal(path.dirname(root),tmpdir());assert.ok(path.basename(root).startsWith("labelmod-backup-test-"));await rm(root,{recursive:true});};
  return {store,driver,manager,backup,events,start,cleanup,fail:(stage:string)=>{failure=stage;},hold:(value:Promise<void>)=>{hold=value;}};
}
async function finished(store:BackupStore,id:string) {
  for(let n=0;n<200;n++) {const job=await store.job(id);if(terminalPhase(job.phase))return job;await new Promise(r=>setTimeout(r,10));}
  throw new Error("operation did not finish");
}

test("trusted backup detects corruption, forged metadata, wrong instance and traversal",async()=>{
  const f=await fixture();try {
    assert.equal((await f.store.verify(f.backup.id)).id,f.backup.id);
    assert.throws(()=>f.store.file("../secrets","dump"));
    const raw=await readFile(f.store.file(f.backup.id,"manifest"),"utf8");
    const signed=JSON.parse(raw);signed.payload=signed.payload.replace("test-instance","evil-instance");
    await writeFile(f.store.file(f.backup.id,"manifest"),JSON.stringify(signed));
    await assert.rejects(()=>f.store.verify(f.backup.id),/امضا/);
    await writeFile(f.store.file(f.backup.id,"manifest"),raw);
    await writeFile(f.store.file(f.backup.id,"dump"),"corrupted");
    await assert.rejects(()=>f.start(),/ناقص/);assert.deepEqual(f.events,[]);
    const other=new BackupStore(f.store.root,"other-instance","a".repeat(64));
    await assert.rejects(()=>other.manifest(f.backup.id));
  }finally{await f.cleanup();}
});

test("wrong confirmation timestamp and incompatible schema never stop writers",async()=>{
  const f=await fixture();try {
    await assert.rejects(()=>f.manager.restore({backupId:f.backup.id,confirmedTimestamp:"2000-01-01T00:00:00.000Z",actorId:randomUUID(),operationId:randomUUID()}));
    f.fail("compatible");await assert.rejects(()=>f.start());assert.deepEqual(f.events,["compatible"]);
  }finally{await f.cleanup();}
});

test("restore rehearses before stopping, creates safety backup, then validates before resuming",async()=>{
  const f=await fixture();try {
    const job=await f.start();const done=await finished(f.store,job.id);
    assert.equal(done.phase,"completed");assert.ok(done.safetyBackupId);await f.store.verify(done.safetyBackupId);
    assert.deepEqual(f.events,["compatible","rehearse","compatible","stop","backup","swap","validate","start-restored"]);
    await assert.rejects(()=>f.manager.restore({backupId:f.backup.id,confirmedTimestamp:f.backup.createdAt,actorId:randomUUID(),operationId:job.id}));
    // تاریخچه با ساختن یک Store تازه از دیسک برمی‌گردد.
    const reopened=new BackupStore(f.store.root,f.store.instance,"a".repeat(64));assert.equal((await reopened.job(job.id)).phase,"completed");
  }finally{await f.cleanup();}
});

test("concurrent restore is rejected while first isolated rehearsal is running",async()=>{
  const f=await fixture();let release!:()=>void;f.hold(new Promise<void>(r=>{release=r;}));
  try {const one=await f.start();await assert.rejects(()=>f.start(),/عملیات/);release();assert.equal((await finished(f.store,one.id)).phase,"completed");}
  finally{release();await f.cleanup();}
});

for(const failure of ["rehearse","backup","swap","validate","start"]) test(`restore failure ${failure} preserves an explicit recoverable state`,async()=>{
  const f=await fixture();f.fail(failure);
  try {
    const job=await f.start(),done=await finished(f.store,job.id);
    assert.equal(done.phase,failure==="start"?"manual_recovery":["swap","validate"].includes(failure)?"rolled_back":"failed");
    if(failure==="rehearse") assert.ok(!f.events.includes("stop"));
    if(failure==="backup") {assert.ok(!f.events.includes("swap"));assert.ok(f.events.includes("start-original"));}
    if(["swap","validate"].includes(failure)) assert.ok(f.events.includes("rollback"));
    if(failure==="start") {assert.ok(!f.events.includes("rollback"));await assert.rejects(()=>f.manager.createBackup());}
    assert.ok(!JSON.stringify(done).includes("private diagnostic"));
  }finally{await f.cleanup();}
});

test("interrupted job blocks operations even if its process lock file is missing",async()=>{
  const f=await fixture();try {
    const job:RestoreJob={id:randomUUID(),backupId:f.backup.id,actorId:randomUUID(),phase:"swapping",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    await f.store.saveJob(job);await assert.rejects(()=>f.manager.createBackup(),/ناقص/);
    assert.deepEqual(f.events,[]);
  }finally{await f.cleanup();}
});

test("factor replay protection persists outside the database",async()=>{
  const f=await fixture();try {
    const actor=randomUUID();await f.store.consumeFactor(actor,"123456");
    const reopened=new BackupStore(f.store.root,f.store.instance,"a".repeat(64));await assert.rejects(()=>reopened.consumeFactor(actor,"123456"));
    await reopened.consumeFactor(actor,"654321");
  }finally{await f.cleanup();}
});

test("abandoned backup lock recovery refuses a living owner or unfinished restore",async()=>{
  const f=await fixture();try {
    const unlock=await f.store.lock();
    assert.deepEqual(await f.store.operationState(),{busy:true,abandoned:false});
    await assert.rejects(()=>recoverAbandonedBackupLock(f.store),/هنوز/);
    await unlock();
    const child=spawn(process.execPath,["-e",""],{windowsHide:true});
    await once(child,"exit");assert.ok(child.pid);
    const file=path.join(f.store.root,"operation.lock");
    await writeFile(file,JSON.stringify({pid:child.pid}));
    assert.deepEqual(await f.store.operationState(),{busy:true,abandoned:true});
    await recoverAbandonedBackupLock(f.store);
    assert.deepEqual(await f.store.operationState(),{busy:false,abandoned:false});
    const job:RestoreJob={id:randomUUID(),backupId:f.backup.id,actorId:randomUUID(),phase:"swapping",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    await f.store.saveJob(job);await writeFile(file,JSON.stringify({pid:child.pid}));
    await assert.rejects(()=>recoverAbandonedBackupLock(f.store),/ناقص/);
    assert.ok(await readFile(file,"utf8"));assert.deepEqual(f.events,[]);
  }finally{await f.cleanup();}
});
