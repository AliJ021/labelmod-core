import {sql} from "kysely";
import {z} from "zod";
import type {Db} from "../db/client.ts";

const decimal=z.string().regex(/^-?\d+(?:\.\d+)?$/);
const wooOrder=z.object({
  id:z.union([z.string().min(1).max(64),z.number().int().safe()]).transform(String),
  status:z.string(),date_paid:z.string().nullish(),date_paid_gmt:z.string().nullish(),
  total:decimal,total_tax:decimal,fee_lines:z.array(z.object({total:decimal,total_tax:decimal})).default([])
});
export async function reconcileWooSnapshot(db:Db,actor:string,data:unknown,unit:"rial"|"toman"){
  const orders=z.array(wooOrder).parse(data);
  if(new Set(orders.map(r=>r.id)).size!==orders.length)throw new Error("شناسهٔ سفارش در فایل تکراری است.");
  const result=await sql<{orderId:string;invoice:string|null;issues:string[]}>
    `WITH source AS (SELECT value AS o FROM jsonb_array_elements(${JSON.stringify(orders)}::jsonb)),
    matched AS (
      SELECT o,i.id,i.status,i.tax_amount,i.payable_amount,sales.invoice_display_number(i.id) invoice
      FROM source s LEFT JOIN platform.inbox_message m ON m.source='api.web.order' AND m.event_id='woo-order:'||(o->>'id') AND m.payload->>'actorId'=${actor}
      LEFT JOIN sales.invoice i ON i.id=m.result_ref::uuid)
    SELECT o->>'id' AS "orderId",invoice,array_remove(ARRAY[
     CASE WHEN EXISTS(SELECT FROM jsonb_array_elements(o->'fee_lines') f WHERE (f->>'total')::numeric<>0 OR (f->>'total_tax')::numeric<>0) THEN 'fee_review' END,
     CASE WHEN id IS NULL AND (o->>'date_paid' IS NOT NULL OR o->>'date_paid_gmt' IS NOT NULL) AND o->>'status' IN ('processing','completed') THEN 'paid_missing' END,
     CASE WHEN id IS NOT NULL AND o->>'status' IN ('refunded','cancelled') AND status NOT IN ('returned','cancelled') THEN 'cancelled_after_posting' END,
     CASE WHEN id IS NOT NULL AND tax_amount<>round((o->>'total_tax')::numeric*${unit==="toman"?10:1}::int) THEN 'tax_mismatch' END,
     CASE WHEN id IS NOT NULL AND payable_amount<>round((o->>'total')::numeric*${unit==="toman"?10:1}::int) THEN 'total_mismatch' END
    ],NULL) AS issues FROM matched ORDER BY o->>'id'`.execute(db);
  return result.rows.filter(row=>row.issues.length);
}
