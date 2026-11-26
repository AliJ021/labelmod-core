import { spawn } from "node:child_process";
import { once } from "node:events";
import { openAsBlob } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { sql } from "kysely";
import type { Db } from "../db/client.ts";
import { hashFile } from "./backup-store.ts";

type Destination = {token:string; chat:string; recipient:string};
type Json = {ok?:boolean; result?:{id?:number;type?:string;message_id?:number;chat?:{id?:number;type?:string}}};

async function destination(dir:string):Promise<Destination> {
  const read=async(name:string)=>(await readFile(join(dir,name),"utf8")).trim();
  const [token,chat,recipient]=await Promise.all(["token","chat","recipient"].map(read));
  if (!token || !/^[a-zA-Z0-9:_-]+$/.test(token) || !chat || !/^[1-9]\d*$/.test(chat) || !recipient || !/^age1[a-z0-9]{58}$/.test(recipient))
    throw new Error("config");
  return {token,chat,recipient};
}

export async function verifyBaleChat(dest:Destination,send:typeof fetch=fetch) {
  const response=await send("https://tapi.bale.ai/bot"+dest.token+"/getChat",{
    method:"POST",redirect:"error",body:new URLSearchParams({chat_id:dest.chat}),signal:AbortSignal.timeout(15000)
  });
  const data=await response.json() as Json;
  if (!response.ok || !data.ok || data.result?.type!=="private" || String(data.result.id)!==dest.chat) throw new Error("private_chat");
}

// Only the public recipient and ciphertext file are passed to age. No plaintext dump on disk.
export async function encryptDatabase(url:string,recipient:string,file:string,pgDump="pg_dump",age="age") {
  const conn=new URL(url);
  const pgEnv={...process.env,PGDATABASE:decodeURIComponent(conn.pathname.slice(1)),PGHOST:conn.hostname,PGPORT:conn.port||"5432",
    PGUSER:decodeURIComponent(conn.username),PGPASSWORD:decodeURIComponent(conn.password),PGCONNECT_TIMEOUT:"10",
    ...(conn.searchParams.has("sslmode")?{PGSSLMODE:conn.searchParams.get("sslmode")!}:{})};
  const dump=spawn(pgDump,["--format=custom","--no-password"],{env:pgEnv,stdio:["ignore","pipe","ignore"]});
  const encrypt=spawn(age,["-r",recipient,"-o",file],{stdio:["pipe","ignore","ignore"]});
  const ended=async(child:typeof dump|typeof encrypt)=>{const [code]=await once(child,"close");if(code!==0)throw new Error("encryption");};
  try {
    await Promise.all([ended(dump),ended(encrypt),pipeline(dump.stdout,encrypt.stdin)]);
  } catch {
    dump.kill();encrypt.kill();
    throw new Error("encryption");
  }
}

export async function deliverBale(dest:Destination,file:string,date:string,digest:string,send:typeof fetch=fetch) {
  const body=new FormData();
  body.set("chat_id",dest.chat);
  body.set("caption",date+" · SHA-256 "+digest);
  body.set("document",await openAsBlob(file),"labelmod-"+date+".dump.age");
  const response=await send("https://tapi.bale.ai/bot"+dest.token+"/sendDocument",{method:"POST",redirect:"error",body,signal:AbortSignal.timeout(120000)});
  const data=await response.json() as Json;
  if (!response.ok || !data.ok || !Number.isSafeInteger(data.result?.message_id) ||
      String(data.result?.chat?.id)!==dest.chat || data.result?.chat?.type!=="private") throw new Error("delivery");
  return String(data.result!.message_id);
}

export async function runBaleBackup(db:Db, url:string,root:string,configDir:string) {
  // The panel-backup process holds an exclusive volume lock for its entire lifetime.
  const current=(await sql<{day:string}> `SELECT (now() AT TIME ZONE 'Asia/Tehran')::date::text AS day
    WHERE platform.setting_text('backup.bale_enabled','false')='true'
      AND (now() AT TIME ZONE 'Asia/Tehran')::time >= make_time(platform.setting_text('backup.bale_hour','0')::int,platform.setting_text('backup.bale_minute','0')::int,0)`.execute(db)).rows[0];
  if (!current) return;
  const {day}=current;
  const file=join(root,day+".dump.age");
  await sql`INSERT INTO platform.bale_backup(due_day,state) VALUES(${day}::date,'preparing') ON CONFLICT DO NOTHING`.execute(db);
  const record=(await sql<{state:string;digest:string|null;recent:boolean}>`SELECT state,digest,updated_at>now()-interval '15 minutes' AS recent
    FROM platform.bale_backup WHERE due_day=${day}::date`.execute(db)).rows[0]!;
  if (record.state==="sent") {await rm(file,{force:true});return;}
  if (record.state==="unknown") return;
  if (record.state==="sending") {
    await sql`UPDATE platform.bale_backup SET state='unknown',detail='پاسخ ارسال قبلی را در گفت‌وگوی بله بررسی کنید.',updated_at=now() WHERE due_day=${day}::date`.execute(db);
    return;
  }
  if(record.state==="failed" && record.recent) return;
  let deliveryStarted=false;
  let detail="بات، مقصد خصوصی و کلید عمومی بکاپ را بررسی کنید.";
  try {
    const dest=await destination(configDir);
    await verifyBaleChat(dest);
    await mkdir(root,{recursive:true,mode:0o700});
    detail="ساخت بکاپ رمزگذاری‌شده موفق نبود.";
    if (!record.digest) {
      const tmp=file+".part";
      await rm(tmp,{force:true});
      try {await encryptDatabase(url,dest.recipient,tmp);await rename(tmp,file);}
      finally {await rm(tmp,{force:true});}
    }
    const checked=await hashFile(file);
    if (record.digest && record.digest!==checked.sha256) throw new Error("digest");
    await sql`UPDATE platform.bale_backup SET state='ready',encrypted_at=coalesce(encrypted_at,now()),bytes=${checked.bytes},digest=${checked.sha256},detail=NULL,updated_at=now() WHERE due_day=${day}::date`.execute(db);
    detail="فایل از سقف ۵۰ مگابایت بله بزرگ‌تر است. از دانلود دستی استفاده کنید.";
    if (checked.bytes>50000000) throw new Error("size");
    await sql`UPDATE platform.bale_backup SET state='sending',updated_at=now() WHERE due_day=${day}::date`.execute(db);
    deliveryStarted=true;
    detail="نتیجهٔ تحویل قطعی نیست. فایل و هش همان روز را در گفت‌وگوی بله تطبیق دهید.";
    const id=await deliverBale(dest,file,day,checked.sha256);
    await sql`UPDATE platform.bale_backup SET state='sent',delivered_at=now(),message_id=${id},detail=NULL,updated_at=now() WHERE due_day=${day}::date`.execute(db);
  } catch {
    await sql`UPDATE platform.bale_backup SET state=${deliveryStarted?"unknown":"failed"},detail=${detail},updated_at=now() WHERE due_day=${day}::date`.execute(db);
    return;
  }
  await rm(file,{force:true});
}
