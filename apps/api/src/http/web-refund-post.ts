import { sql, type Transaction } from "kysely";
import type { Database } from "../db/types.ts";
import type { ResolvedSession } from "../auth/service.ts";
import { setActor } from "../lib/idempotency.ts";
import { ReturnError } from "../sales/return.ts";
import { requireWebReturnHuman } from "../auth/human-session.ts";
import type { WooRefundBody } from "./web-refund-body.ts";
export async function postWooReturn(trx: Transaction<Database>, s: ResolvedSession,
  order: { invoice_id: string; branch_id: string; payment_method: string }, body: WooRefundBody): Promise<string> {
  await requireWebReturnHuman(trx,s,order.invoice_id);
    const method = await trx.selectFrom("treasury.payment_method").select(["kind", "is_active"])
      .where("code", "=", order.payment_method).executeTakeFirst();
    if (!method?.is_active || !["gateway", "card_reader", "transfer"].includes(method.kind)) {
      throw new ReturnError("manual_refund_required", "بازپرداخت این روش باید با صندوق مشخص در حسابداری ثبت شود", 422);
    }
        await setActor(trx, s.userId);
        const inv = await trx.selectFrom("sales.invoice").select(["id", "warehouse_id", "status"])
          .where("id", "=", order.invoice_id).forUpdate().executeTakeFirstOrThrow();
        if (!["finalized", "paid", "partially_returned"].includes(inv.status)) {
          throw new ReturnError("invoice_not_returnable", "فاکتور قابل مرجوعی نیست", 409);
        }
        const inserted = await sql<{ id: string }>`
          INSERT INTO sales.sale_return(branch_id,invoice_id,warehouse_id,reason_code,reason_note,
             refund_amount,refund_method,shipping_amount,created_by)
          VALUES(${order.branch_id}::uuid,${inv.id}::uuid,${inv.warehouse_id}::uuid,'web_refund',
            ${`Woo refund ${body.refundId}`},${body.amount}::numeric,${order.payment_method},
            ${body.shippingAmount}::numeric,${s.userId}::uuid) RETURNING id
        `.execute(trx);
        const id = inserted.rows[0]!.id;
        for (const line of body.lines) {
          const found = await trx.selectFrom("sales.invoice_line").select("id")
            .where("invoice_id", "=", inv.id).where("line_no", "=", line.lineNo).executeTakeFirst();
          if (!found) throw new ReturnError("line_not_found", "قلم سفارش یافت نشد", 422);
          await sql`INSERT INTO sales.sale_return_line(return_id,invoice_line_id,qty,restock,unit_price,net_amount,unit_cost,cogs_amount)
            VALUES(${id}::uuid,${found.id}::uuid,${line.qty}::numeric,${line.restock},0,0,0,0)`.execute(trx);
        }
        await sql`SELECT sales.post_return(${id}::uuid,${s.userId}::uuid)`.execute(trx);
        const checked = await sql<{ matches: boolean }>`SELECT net_amount+tax_amount+shipping_amount=refund_amount AS matches
          FROM sales.sale_return WHERE id=${id}::uuid`.execute(trx);
        if (!checked.rows[0]?.matches) {
          throw new ReturnError("refund_amount_mismatch", "مبلغ مرجوعی سایت با ارزش اقلام و مالیات حسابداری برابر نیست؛ هیچ سندی ثبت نشد", 422);
        }
        return id;
}
