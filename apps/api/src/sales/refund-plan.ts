import { createHash } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import type { Database } from "../db/types.ts";
import { can } from "../auth/permission.ts";
import { ReturnError } from "./return-error.ts";

export const splitRefundSchema = z.object({
  basis: z.string().regex(/^[0-9a-f]{64}$/),
  reason: z.string().trim().min(1).max(500).optional(),
  legs: z.array(z.object({
    method: z.string().regex(/^[a-z0-9_]{1,64}$/),
    amount: z.string().regex(/^[1-9][0-9]{0,17}$/),
    sourceId: z.uuid().nullable(),
    reference: z.string().trim().min(1).max(200).optional(),
  })).min(1).max(200),
});
export type SplitRefund = z.infer<typeof splitRefundSchema>;
type Executor = Db | Transaction<Database>;
interface Bucket { sourceId: string; method: string; account: string | null; reference: string | null; balance: bigint }
interface Flow { invoice: string; id: string; method: string; direction: string; amount: string;
  account: string | null; reference: string | null; source: string | null; returnId: string | null }

// Largest remainder, with a stable tie break. The sum always equals the requested Rials.
function shares(rows: Bucket[], total: bigint): bigint[] {
  const weight = rows.reduce((s,r) => s + r.balance, 0n);
  if (!weight) return rows.map(() => 0n);
  total = total < weight ? total : weight;
  const result = rows.map(r => total * r.balance / weight);
  const left = Number(total - result.reduce((a,b) => a+b,0n));
  const ranks = rows.map((r,i) => ({i, remainder:total*r.balance%weight, id:r.sourceId}))
    .sort((a,b) => a.remainder === b.remainder ? a.id.localeCompare(b.id) : a.remainder>b.remainder ? -1 : 1);
  for (const {i} of ranks.slice(0,left)) result[i] = result[i]! + 1n;
  return result;
}
function debit(rows: Bucket[], amount: bigint) {
  const available = rows.reduce((s,r) => s+r.balance,0n);
  const taken = amount < available ? amount : available;
  const portions = shares(rows,taken);
  rows.forEach((r,i) => { r.balance -= portions[i]!; });
  return amount-taken;
}

export async function refundPlan(db: Executor, invoice: string, amount: bigint) {
  const chain = await sql<{id:string; via:string|null}>`WITH RECURSIVE ancestors(id,via,depth) AS (
    SELECT ${invoice}::uuid,NULL::uuid,0 UNION ALL
    SELECT e.original_invoice_id,e.return_id,a.depth+1 FROM ancestors a JOIN sales.exchange e
      ON e.replacement_invoice_id=a.id WHERE e.funded_transfer>0
  ) SELECT id,via FROM ancestors ORDER BY depth DESC`.execute(db);
  const ids=chain.rows.map(r=>r.id);
  const receipts = await sql<Flow>`SELECT coalesce(p.invoice_id,r.invoice_id) invoice,p.id,p.method_code method,p.direction,
    p.amount::text,p.account_id account,p.ref_no reference,coalesce(p.refund_origin_id,r.refund_payment_id) source,p.return_id "returnId"
    FROM treasury.payment p JOIN treasury.payment_method m ON m.code=p.method_code
    LEFT JOIN sales.sale_return r ON r.id=p.return_id AND r.status='posted'
    WHERE (p.invoice_id=ANY(${ids}::uuid[]) OR r.invoice_id=ANY(${ids}::uuid[]))
      AND p.status IN ('succeeded','settled','reconciled') AND m.kind IN ('cash','transfer','card_reader','gateway')
    ORDER BY p.occurred_at,p.id`.execute(db);
  const returns = await sql<{id:string;invoice:string;funding:string}>`SELECT r.id,r.invoice_id invoice,
    coalesce(e.funded_transfer,0)::text funding FROM sales.sale_return r LEFT JOIN sales.exchange e ON e.return_id=r.id
    WHERE r.invoice_id=ANY(${ids}::uuid[]) AND r.status='posted' ORDER BY r.occurred_at,r.number,r.id`.execute(db);
  let buckets: Bucket[]=[];
  for (const node of chain.rows) {
    const flows=receipts.rows.filter(r=>r.invoice===node.id);
    for (const p of flows.filter(r=>r.direction==='in' && !r.returnId)) {
      buckets.push({sourceId:p.id,method:p.method,account:p.account,reference:p.reference,balance:BigInt(p.amount)});
    }
    const spent = (p:Flow) => {
      let remaining=BigInt(p.amount);
      if (p.source) remaining=debit(buckets.filter(b=>b.sourceId===p.source),remaining);
      remaining=debit(buckets.filter(b=>b.method===p.method),remaining);
      debit(buckets,remaining);
    };
    flows.filter(r=>r.direction==='out' && !r.returnId).forEach(spent);
    for (const ret of returns.rows.filter(r=>r.invoice===node.id)) {
      flows.filter(r=>r.returnId===ret.id && r.direction==='out').forEach(spent);
      if (ret.id===node.via) {
        const carried=shares(buckets,BigInt(ret.funding));
        buckets=buckets.map((b,i)=>({...b,balance:carried[i]!})); break;
      }
      debit(buckets,BigInt(ret.funding));
    }
  }
  const positive=buckets.filter(b=>b.balance>0n);
  const parts=shares(positive,amount);
  const legs=positive.map((b,i)=>({sourceId:b.sourceId,method:b.method,account:b.account,originalReference:b.reference,
    remaining:b.balance.toString(),amount:parts[i]!.toString()}));
  const basis=createHash("sha256").update(JSON.stringify([invoice,amount.toString(),legs])).digest("hex");
  return {basis,legs,mixed:new Set(buckets.map(b=>b.method)).size>1};
}

export async function previewRefundPlan(db:Db, invoice:string, amount:bigint, session:{userId:string;pinUnlocked:boolean}) {
  if (amount<=0n) return null;
  const plan=await refundPlan(db,invoice,amount);
  if (!plan.mixed) return null;
  const decision=await can(db,{userId:session.userId,viaPin:session.pinUnlocked,operation:"refund.cash",amount});
  const canChange = decision.verdict === "allow";
  const legs = plan.legs.map(({sourceId,method,amount,remaining,originalReference}) => ({
    sourceId, method, amount, remaining, originalReference: canChange ? originalReference : null
  }));
  return {basis:plan.basis, mixed:plan.mixed, legs, canChange};
}

export async function recordSplit(trx:Transaction<Database>, input:{id:string;invoice:string;shift:string|null;
  amount:bigint;reason:string|null; split:SplitRefund}) {
  const {split}=input;
  const expected=await refundPlan(trx,input.invoice,input.amount);
  if (split.basis!==expected.basis) throw new ReturnError("refund_split_changed","ماندهٔ روش‌های پرداخت تغییر کرد. پیش‌نمایش را تازه کنید.");
  if (split.legs.reduce((sum,l)=>sum+BigInt(l.amount),0n)!==input.amount)
    throw new ReturnError("refund_split_total","جمع روش‌های برگشت باید برابر مبلغ بازپرداخت باشد.",422);
  const expectedBySource=new Map(expected.legs.map(l=>[l.sourceId,l]));
  const seen=new Set<string>();
  let changed=false;
  for (const leg of split.legs) {
    const key=leg.sourceId ?? leg.method;
    if (seen.has(key)) throw new ReturnError("duplicate_refund_leg","ردیف بازپرداخت تکراری است.",422);
    seen.add(key);
    const origin=leg.sourceId ? expectedBySource.get(leg.sourceId) : undefined;
    if (leg.sourceId && (!origin || origin.method!==leg.method)) throw new ReturnError("refund_source_changed","مبدأ پرداخت با این روش تطابق ندارد.",422);
    changed ||= !origin || leg.amount!==origin.amount;
    const method=await trx.selectFrom("treasury.payment_method").select(["kind","is_active","requires_ref"]).where("code","=",leg.method).executeTakeFirst();
    const provider=leg.method==="snappay" || leg.method==="digipay";
    if (!method || (!method.is_active && !(provider && origin)) || !["cash","transfer","card_reader","gateway"].includes(method.kind) ||
        (provider && (!origin || BigInt(leg.amount)>BigInt(origin.remaining))))
      throw new ReturnError("bad_refund_method","روش یا سقف برگشت پرداخت اصلی معتبر نیست.",422);
    if (origin?.account) {
      const mapped=await sql`SELECT a.id FROM treasury.account a JOIN ledger.posting_rule pr ON pr.account_code=a.ledger_account_code
        WHERE a.id=${origin.account}::uuid AND pr.is_active AND pr.event_type='sale_shift' AND pr.side='debit'
        AND pr.leg=CASE ${method.kind}::text WHEN 'cash' THEN 'cash' WHEN 'transfer' THEN 'p2p_clearing'
          WHEN 'card_reader' THEN 'card_clearing' WHEN 'gateway' THEN 'gateway_clearing' END`.execute(trx);
      if (!mapped.rows.length) throw new ReturnError("refund_account_changed","نگاشت حساب دریافت تغییر کرده است. حساب بازپرداخت را بررسی کنید.");
    }
    if (method.requires_ref && !leg.reference) throw new ReturnError("refund_reference_required","شماره پیگیری هر برگشت بانکی را وارد کنید.",422);
    if (method.kind==="cash") {
      const drawer=await sql`SELECT s.id FROM sales.cash_shift s JOIN sales.invoice i ON i.branch_id=s.branch_id
        WHERE i.id=${input.invoice}::uuid AND s.id=${input.shift}::uuid AND s.status='open' FOR SHARE OF s`.execute(trx);
      if (!drawer.rows.length) throw new ReturnError("no_open_shift","برای سهم نقدی یک کشوی باز همان شعبه انتخاب کنید.",422);
    }
    await sql`INSERT INTO treasury.payment(return_id,shift_id,method_code,direction,amount,status,ref_no,account_id,refund_origin_id)
      VALUES (${input.id}::uuid,${method.kind==="cash"?input.shift:null}::uuid,${leg.method},'out',${leg.amount}::numeric,'succeeded',
      ${leg.reference ?? null},${origin?.account ?? null}::uuid,${leg.sourceId}::uuid)`.execute(trx);
  }
  if (changed && !split.reason?.trim() && !input.reason?.trim()) throw new ReturnError("payout_reason_required","برای تغییر ترکیب بازپرداخت دلیل بنویسید.",422);
  return expected;
}
