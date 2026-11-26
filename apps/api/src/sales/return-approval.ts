import {sql, type Transaction} from "kysely";
import type {Db} from "../db/client.ts";
import type {Database} from "../db/types.ts";
import {ReturnError} from "./return-error.ts";
import type {SplitRefund} from "./refund-plan.ts";

type Proposal = {invoice:string;branch:string;actor:string;intent:string;details:unknown};
class AwaitingApproval extends Error {
  proposal:Proposal;
  constructor(proposal:Proposal) {super("awaiting approval");this.proposal=proposal;}
}

export async function checkFullReturnApproval(tx:Transaction<Database>,id:string,actor:string,intent:string,split?:SplitRefund) {
  const result=(await sql<{invoice:string;branch:string;details:unknown}>`SELECT r.invoice_id AS invoice,r.branch_id AS branch,
    jsonb_build_object('amount',r.refund_amount::text,'method',r.refund_method,'reference',r.refund_reference,'source',r.refund_payment_id,'warehouse',r.warehouse_id,
      'shift',r.shift_id,'shipping',r.shipping_amount::text,'reason',r.reason_code,'note',r.reason_note,'split',${JSON.stringify(split??null)}::jsonb,
      'lines',(SELECT jsonb_agg(jsonb_build_object('line',l.invoice_line_id,'qty',l.qty,'restock',l.restock,'condition',l.condition,
        'product',p.name_internal,'sku',v.sku) ORDER BY l.invoice_line_id) FROM sales.sale_return_line l
        JOIN sales.invoice_line il ON il.id=l.invoice_line_id JOIN catalog.variation v ON v.id=il.variation_id JOIN catalog.product p ON p.id=v.product_id WHERE l.return_id=r.id)) AS details
    FROM sales.sale_return r WHERE r.id=${id}::uuid AND platform.setting_text('return.full_review','false')='true'
      AND r.refund_amount >= 10::bigint * platform.setting_text('return.full_review_min','0')::bigint
      AND NOT EXISTS(SELECT FROM sales.invoice_line il WHERE il.invoice_id=r.invoice_id AND il.qty-il.returned_qty <>
        coalesce((SELECT sum(l.qty) FROM sales.sale_return_line l WHERE l.return_id=r.id AND l.invoice_line_id=il.id),0))`.execute(tx)).rows[0];
  if (!result) return;
  const prior=(await sql<{id:string;status:string;same:boolean;consumed_by:string|null}>`SELECT a.id,a.status,a.context=${JSON.stringify(result.details)}::jsonb AS same,r.consumed_by
    FROM sales.return_approval r JOIN identity.approval_request a ON a.id=r.id
    WHERE r.actor_id=${actor}::uuid AND r.intent=${intent} AND r.invoice_id=${result.invoice}::uuid FOR UPDATE OF a,r`.execute(tx)).rows[0];
  if(!prior) throw new AwaitingApproval({...result,actor,intent});
  if(!prior.same || prior.consumed_by)throw new ReturnError("approval_changed","اطلاعات این درخواست تغییر کرده یا قبلاً ثبت شده است. وضعیت درخواست را بررسی کنید.");
  if(prior.status!=="approved") throw new ReturnError("approval_"+prior.status,prior.status==="pending"?"در انتظار تأیید مدیر است.":"مدیر این درخواست را رد کرده است.");
  await sql`UPDATE sales.return_approval SET consumed_by=${id}::uuid WHERE id=${prior.id}::uuid`.execute(tx);
}

export async function recordApproval(db:Db,error:unknown):Promise<never> {
  if (!(error instanceof AwaitingApproval)) throw error;
  const p=error.proposal;
  await db.transaction().execute(async tx=>{
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${p.actor+p.intent},519))`.execute(tx);
    if((await sql`SELECT FROM sales.return_approval WHERE actor_id=${p.actor}::uuid AND intent=${p.intent}`.execute(tx)).rows.length)return;
    const created=await sql<{id:string}>`INSERT INTO identity.approval_request(operation,requested_by,reason,context)
      VALUES('return.full',${p.actor}::uuid,'درخواست ابطال کامل',${JSON.stringify(p.details)}::jsonb) RETURNING id`.execute(tx);
    const id=created.rows[0]!.id;
    await sql`INSERT INTO sales.return_approval(id,actor_id,intent,invoice_id,branch_id) VALUES(${id}::uuid,${p.actor}::uuid,${p.intent},${p.invoice}::uuid,${p.branch}::uuid)`.execute(tx);
    await sql`SELECT platform.audit('return.approval.request','approval_request',${id},NULL,${p.actor}::uuid)`.execute(tx);
  });
  throw new ReturnError("approval_pending","درخواست به مدیر رسید. پس از تأیید، همین عملیات را از بخش بازیابی عملیات مالی ادامه دهید.");
}
