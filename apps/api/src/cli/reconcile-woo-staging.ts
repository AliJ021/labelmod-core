import {readFile} from "node:fs/promises";
import {z} from "zod";
import {createDb} from "../db/client.ts";
import {reconcileWooSnapshot} from "../operations/woo-reconciliation.ts";

const url=new URL(process.env.STAGING_DATABASE_URL??"about:blank");
if(!["localhost","127.0.0.1","[::1]"].includes(url.hostname) || !/^\/labelmod_(?:apitest_|.*_test$|staging(?:_|$))/.test(url.pathname))
  throw new Error("این ابزار به نسخهٔ آزمایشی محلی وصل می‌شود.");
const [file,actor,unit]=z.tuple([z.string().min(1),z.uuid(),z.enum(["rial","toman"])]).parse(process.argv.slice(2));
const source=JSON.parse(await readFile(file,"utf8"));
const handle=createDb(url.href,1);
try {
  const findings=await handle.db.transaction().setAccessMode("read only").execute(tx=>reconcileWooSnapshot(tx,actor,source,unit));
  process.stdout.write(JSON.stringify(findings,null,2)+"\n");
} finally {await handle.close();}
