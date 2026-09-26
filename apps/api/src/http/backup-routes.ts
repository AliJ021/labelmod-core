import { request } from "node:http";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import type { Config } from "../lib/config.ts";
import { requireForSession } from "../auth/permission.ts";
import { branchesOf } from "../sales/scope.ts";
import { InvoiceError } from "../sales/invoice.ts";

export function registerBackupRoutes(app:FastifyInstance,db:Db,config:Config) {
  async function guard(req:FastifyRequest,operation:string) {
    if(!req.session || req.headers.authorization || !req.cookies[config.COOKIE_NAME] || req.session.pinUnlocked || req.session.enrollmentOnly) throw new InvoiceError("backup_session","نشست انسانی کامل لازم است.",403);
    await requireForSession(db,req.session,operation);
    if(await branchesOf(db,req.session.userId)!=="all") throw new InvoiceError("backup_scope","بکاپ سراسری فقط برای مدیر مجاز همهٔ شعب است.",403);
  }
  function rpc(req:FastifyRequest,method:string,url:string,body?:unknown) {
    const socketPath=config.BACKUP_MANAGER_SOCKET,token=config.BACKUP_MANAGER_TOKEN;
    if(!socketPath || !token) throw new InvoiceError("backup_unavailable","سرویس مستقل پشتیبان‌گیری هنوز به این نصب متصل نشده است.",503);
    return new Promise<import("node:http").IncomingMessage>((resolve,reject)=>{
      const data=body===undefined?undefined:JSON.stringify(body);
      const call=request({socketPath,method,path:url,headers:{authorization:"Bearer "+token,"x-labelmod-session":req.cookies[config.COOKIE_NAME]!,...(data?{"content-type":"application/json","content-length":Buffer.byteLength(data)}:{})}},resolve);
      call.on("error",()=>reject(new InvoiceError("backup_unavailable","ارتباط با سرویس بکاپ قطع است؛ پیش از تلاش دوباره تاریخچه را بررسی کنید.",503)));
      call.setTimeout(65000,()=>call.destroy());call.end(data);
    });
  }
  app.get("/backups",async(req,reply)=>{
    await guard(req,"backup.view");reply.header("Cache-Control","no-store");
    if(!config.BACKUP_MANAGER_SOCKET || !config.BACKUP_MANAGER_TOKEN) return {available:false,backups:[],jobs:[],needsRecovery:false};
    const response=await rpc(req,"GET","/status");return reply.code(response.statusCode??502).type("application/json").send(response);
  });
  app.post("/backups",async(req,reply)=>{
    await guard(req,"backup.create");z.object({}).strict().parse(req.body??{});
    const response=await rpc(req,"POST","/backup",{});return reply.code(response.statusCode??502).type("application/json").send(response);
  });
  app.get("/backups/:id/download",async(req,reply)=>{
    await guard(req,"backup.download");const {id}=z.object({id:z.string().uuid()}).parse(req.params);
    const response=await rpc(req,"GET",`/download/${id}`);
    reply.header("Cache-Control","no-store");
    if(response.statusCode===200) reply.header("Content-Disposition",`attachment; filename="labelmod-${id}.dump"`);
    return reply.code(response.statusCode??502).type(response.statusCode===200?"application/octet-stream":"application/json").send(response);
  });
  app.post("/backups/restore",{config:{rateLimit:{max:5,timeWindow:"10 minutes"}}},async(req,reply)=>{
    await guard(req,"backup.restore");
    const body=z.object({backupId:z.string().uuid(),operationId:z.string().uuid(),confirmedTimestamp:z.string().datetime(),password:z.string().min(1).max(1024),factorKind:z.enum(["totp","recovery"]),code:z.string().min(6).max(100)}).strict().parse(req.body);
    const response=await rpc(req,"POST","/restore",body);return reply.code(response.statusCode??502).type("application/json").send(response);
  });
}
