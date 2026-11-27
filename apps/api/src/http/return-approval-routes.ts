import type {FastifyInstance} from "fastify";
import {sql} from "kysely";
import {z} from "zod";
import type {Db} from "../db/client.ts";
import {AuthError} from "../auth/service.ts";
import {requireForSession} from "../auth/permission.ts";
import {requireHumanSession} from "../auth/human-session.ts";
import {assertBranch} from "../sales/scope.ts";
import {ReturnError} from "../sales/return-error.ts";

export function registerReturnApprovals(app:FastifyInstance,db:Db) {
  app.get("/return-approvals",async req=>{
    const s=req.session;if(!s)throw new AuthError("no_session","وارد نشده‌اید");
    const {branchId}=z.object({branchId:z.uuid()}).parse(req.query);
    await requireHumanSession(db,s);await requireForSession(db,s,"invoice.cancel");await assertBranch(db,s.userId,branchId);
    const rows=await sql`SELECT a.id,sales.invoice_display_number(r.invoice_id) AS number,u.full_name AS actor,a.context AS details
      FROM sales.return_approval r JOIN identity.approval_request a USING(id) JOIN identity.app_user u ON u.id=r.actor_id
      WHERE r.branch_id=${branchId}::uuid AND a.status='pending' AND NOT EXISTS(SELECT FROM platform.inbox_message m WHERE m.source='api.return.commit.'||r.actor_id::text AND m.event_id=r.intent AND m.payload->>'abandoned'='true') ORDER BY a.requested_at LIMIT 100`.execute(db);
    return {items:rows.rows};
  });
  app.post("/return-approvals/:id/decision",async req=>{
    const s=req.session;if(!s)throw new AuthError("no_session","وارد نشده‌اید");
    const {id}=z.object({id:z.uuid()}).parse(req.params);
    const {decision,reason}=z.object({decision:z.enum(["approved","rejected"]),reason:z.string().trim().min(3).max(500)}).strict().parse(req.body);
    await db.transaction().execute(async tx=>{
      await requireHumanSession(tx,s);await requireForSession(tx,s,"invoice.cancel");
      const row=(await sql<{actor_id:string;branch_id:string;status:string}>`SELECT r.actor_id,r.branch_id,a.status
        FROM sales.return_approval r JOIN identity.approval_request a USING(id) WHERE r.id=${id}::uuid FOR UPDATE OF a`.execute(tx)).rows[0];
      if(!row)throw new ReturnError("approval_missing","درخواست پیدا نشد.",404);
      await assertBranch(tx,s.userId,row.branch_id);
      if(row.actor_id===s.userId)throw new ReturnError("independent_review","برای تأیید این درخواست یک مسئول دیگر لازم است.",403);
      if(row.status===decision)return;
      if(row.status!=="pending")throw new ReturnError("already_decided","تصمیم این درخواست قبلاً ثبت شده است.");
      await sql`UPDATE identity.approval_request SET status=${decision},approved_by=${s.userId}::uuid,decided_at=now() WHERE id=${id}::uuid`.execute(tx);
      await sql`SELECT platform.audit('return.approval.decide','approval_request',${id},jsonb_build_object('decision',${decision}::text),${s.userId}::uuid,${reason})`.execute(tx);
    });
    return {status:decision};
  });
}
