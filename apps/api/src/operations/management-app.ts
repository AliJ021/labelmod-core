import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { createReadStream } from "node:fs";
import { z } from "zod";
import { safeEqual } from "../auth/password.ts";
import { AuthService, AuthError } from "../auth/service.ts";
import { TwoFactorService } from "../auth/two-factor.ts";
import { requireForSession, ForbiddenError } from "../auth/permission.ts";
import { branchesOf } from "../sales/scope.ts";
import type { Db } from "../db/client.ts";
import { RestoreManager } from "./restore-manager.ts";
import { terminalPhase } from "./backup-store.ts";

const restoreInput=z.object({backupId:z.string().uuid(),operationId:z.string().uuid(),confirmedTimestamp:z.string().datetime(),password:z.string().min(1).max(1024),factorKind:z.enum(["totp","recovery"]),code:z.string().trim().min(6).max(100)}).strict();
export async function buildManagementApp(deps:{db:Db;manager:RestoreManager;rpcToken:string}) {
  if(!/^[a-f0-9]{64,128}$/i.test(deps.rpcToken)) throw new Error("کلید کانال مدیریت نامعتبر است.");
  const app=Fastify({logger:false,bodyLimit:8192});
  const auth=new AuthService(deps.db),factor=new TwoFactorService(deps.db),store=deps.manager.store;
  await app.register(rateLimit,{global:false});
  app.addHook("onRequest",async(req,reply)=>{
    if(typeof req.headers.authorization!=="string" || !safeEqual(req.headers.authorization,"Bearer "+deps.rpcToken)) return reply.code(401).send({error:{code:"manager_auth",message:"دسترسی کانال مدیریت معتبر نیست."}});
    reply.header("Cache-Control","no-store");
  });
  app.setErrorHandler((error,_req,reply)=>{
    if(error instanceof z.ZodError) return reply.code(400).send({error:{code:"invalid",message:"ورودی عملیات کامل و معتبر نیست."}});
    if(error instanceof AuthError || error instanceof ForbiddenError) return reply.code(403).send({error:{code:"backup_forbidden",message:error.message}});
    if((error as {statusCode?:number}).statusCode===429) return reply.code(429).send({error:{code:"rate_limited",message:"تعداد تلاش‌ها زیاد است؛ بعداً دوباره تلاش کنید."}});
    return reply.code(409).send({error:{code:"backup_blocked",message:"عملیات تأیید نشد؛ وضعیت و تاریخچهٔ بازیابی را بررسی کنید."}});
  });
  async function guard(token:unknown,operation:string) {
    if(typeof token!=="string" || token.length>1024) throw new AuthError("no_session","نشست انسانی معتبر لازم است.");
    const session=await auth.resolve(token);
    if(!session || session.pinUnlocked || session.enrollmentOnly) throw new AuthError("no_session","نشست کامل با رمز و عامل دوم لازم است.");
    await requireForSession(deps.db,session,operation);
    if(await branchesOf(deps.db,session.userId)!=="all") throw new AuthError("no_session","بکاپ سراسری فقط برای مدیر مجاز همهٔ شعب است.");
    return session;
  }
  app.get("/status",async req=>{
    await guard(req.headers["x-labelmod-session"],"backup.view");
    const jobs=await store.jobs();
    const operation=await store.operationState();
    return {available:true,backups:await store.backups(),jobs,busy:operation.busy,needsRecovery:operation.abandoned||jobs.some(j=>!terminalPhase(j.phase)||j.phase==="manual_recovery")};
  });
  app.post("/backup",{config:{rateLimit:{max:4,timeWindow:"1 hour"}}},async req=>{
    await guard(req.headers["x-labelmod-session"],"backup.create");
    return await deps.manager.createBackup();
  });
  app.get("/download/:id",async(req,reply)=>{
    await guard(req.headers["x-labelmod-session"],"backup.download");
    const {id}=z.object({id:z.string().uuid()}).parse(req.params);
    await store.verify(id);
    return reply.type("application/octet-stream").header("Content-Disposition",`attachment; filename="labelmod-${id}.dump"`).send(createReadStream(store.file(id,"dump")));
  });
  app.post("/restore",{config:{rateLimit:{max:5,timeWindow:"10 minutes"}}},async(req,reply)=>{
    const token=req.headers["x-labelmod-session"],session=await guard(token,"backup.restore");
    const body=restoreInput.parse(req.body);
    await auth.reauthenticate(token as string,body.password);
    const ok=body.factorKind==="totp" ? await factor.verifyTotpFor(session.userId,body.code) : await factor.consumeRecoveryCode(session.userId,body.code);
    if(!ok) throw new AuthError("bad_code","کد عامل دوم معتبر نیست.");
    if(body.factorKind==="totp") await store.consumeFactor(session.userId,body.code);
    const job=await deps.manager.restore({backupId:body.backupId,operationId:body.operationId,confirmedTimestamp:body.confirmedTimestamp,actorId:session.userId});
    return reply.code(202).send(job);
  });
  return app;
}
