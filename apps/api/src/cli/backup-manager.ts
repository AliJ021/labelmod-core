/** نقطهٔ ورود مستقل؛ در فرایند API یا Worker وارد نمی‌شود. */
import { z } from "zod";
import { chmod } from "node:fs/promises";
import path from "node:path";
import { createDb } from "../db/client.ts";
import { BackupStore } from "../operations/backup-store.ts";
import { PostgresBackupDriver } from "../operations/postgres-backup-driver.ts";
import { RestoreManager } from "../operations/restore-manager.ts";
import { buildManagementApp } from "../operations/management-app.ts";
import { recoverAbandonedBackupLock, recoverInterruptedRestore } from "../operations/recover-restore.ts";

process.umask(0o077);
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
const app=await buildManagementApp({db:db.db,manager:new RestoreManager(store,driver),rpcToken:config.OPS_RPC_TOKEN});
// سوکت موجود خودکار حذف نمی‌شود: ممکن است سرویس دیگری هنوز فعال باشد.
await app.listen({path:config.OPS_SOCKET});await chmod(config.OPS_SOCKET,0o660);
async function close(){await app.close();await db.close();}
process.once("SIGTERM",()=>{void close();});process.once("SIGINT",()=>{void close();});
