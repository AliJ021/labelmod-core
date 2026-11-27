/** نقطهٔ ورود مستقل؛ در فرایند API یا Worker وارد نمی‌شود. */
import { z } from "zod";
import { chmod, rm } from "node:fs/promises";
import path from "node:path";
import { createDb } from "../db/client.ts";
import { runBaleBackup } from "../operations/bale-backup.ts";
import { BackupStore } from "../operations/backup-store.ts";
import { PostgresBackupDriver } from "../operations/postgres-backup-driver.ts";
import { RestoreManager } from "../operations/restore-manager.ts";
import { buildManagementApp } from "../operations/management-app.ts";
import { recoverAbandonedBackupLock, recoverInterruptedRestore } from "../operations/recover-restore.ts";

import { getOrCreatePrivateKey } from "../lib/private-key-file.ts";

process.umask(0o077);
const panelMode = process.argv[2] === "--panel-backup";
if (panelMode) {
  // The container entry point holds the store lock for the lifetime of this process.
  const root = "/var/lib/labelmod-panel-backup";
  const channel = "/run/labelmod-panel-backup";
  process.env.OPS_INSTANCE = await getOrCreatePrivateKey(path.join(root, "instance"));
  process.env.OPS_SIGNING_KEY = await getOrCreatePrivateKey(path.join(root, "signing-key"));
  process.env.OPS_RPC_TOKEN = await getOrCreatePrivateKey(path.join(channel, "rpc-token"));
  process.env.OPS_SOCKET = path.join(channel, "manager.sock");
  process.env.OPS_BACKUP_DIR = path.join(root, "archives");
  process.env.OPS_PG_BIN = "/usr/local/bin";
  process.env.OPS_WRITER_HOOK = "/bin/false";
  // This private store serves backups only. flock excludes another live writer,
  // even when a new PID namespace reuses the PID recorded by a crashed container.
  await rm(path.join(process.env.OPS_BACKUP_DIR, "operation.lock"), { force: true });
  await rm(process.env.OPS_SOCKET, { force: true });
}
const absolute=z.string().refine(s=>path.isAbsolute(s));
const config=z.object({OPS_DATABASE_URL:z.string().url(),OPS_BACKUP_DIR:absolute,OPS_INSTANCE:z.string(),OPS_SIGNING_KEY:z.string(),OPS_RPC_TOKEN:z.string(),OPS_SOCKET:absolute,OPS_PG_BIN:absolute,OPS_WRITER_HOOK:absolute}).parse(process.env);
if(process.platform==="win32") throw new Error("سرویس عملیاتی با سوکت یونیکس روی میزبان لینوکس اجرا می‌شود؛ آزمون هسته روی ویندوز مستقل است.");
const store=new BackupStore(config.OPS_BACKUP_DIR,config.OPS_INSTANCE,config.OPS_SIGNING_KEY);await store.init();
const driver=new PostgresBackupDriver(store,{databaseUrl:config.OPS_DATABASE_URL,pgBin:config.OPS_PG_BIN,writerHook:config.OPS_WRITER_HOOK});
if(process.argv[2]==="--recover-backup-lock") {
  await recoverAbandonedBackupLock(store);
  process.stdout.write("Abandoned backup lock recovered; no database changed.\n");
  process.exit(0);
}
if(process.argv[2]==="--recover") {
  const id=z.string().uuid().parse(process.argv[3]);
  const job=await recoverInterruptedRestore(store,driver,id);
  process.stdout.write(JSON.stringify({id:job.id,phase:job.phase})+"\n");
  process.exit(0);
}
const db=createDb(config.OPS_DATABASE_URL,2);
const app=await buildManagementApp({db:db.db,manager:new RestoreManager(store,driver),rpcToken:config.OPS_RPC_TOKEN,restoreEnabled:!panelMode});
// سوکت موجود خودکار حذف نمی‌شود: ممکن است سرویس دیگری هنوز فعال باشد.
await app.listen({path:config.OPS_SOCKET});await chmod(config.OPS_SOCKET,0o660);
let timer:ReturnType<typeof setTimeout>|undefined;
let stopping=false;
let running:Promise<void>|undefined;
function tick() {
  running=runBaleBackup(db.db,config.OPS_DATABASE_URL,path.join(config.OPS_BACKUP_DIR,"bale"),"/run/labelmod-bale")
    .catch(()=>{process.stderr.write("Bale backup status unavailable.\n");})
    .finally(()=>{if (!stopping) timer=setTimeout(tick,60000);});
}
if (panelMode) tick();
async function close(){stopping=true;clearTimeout(timer);await running;await app.close();await db.close();}
process.once("SIGTERM",()=>{void close();});process.once("SIGINT",()=>{void close();});
