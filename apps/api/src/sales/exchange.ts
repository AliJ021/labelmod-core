import { createHash } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { Db } from "../db/client.ts";
import type { Database } from "../db/types.ts";
import { canonicalJson, setActor } from "../lib/idempotency.ts";
import { InvoiceService } from "./invoice.ts";
import { ReturnError, ReturnService, type ReturnLineInput } from "./return.ts";

export interface ExchangeInput {
  invoiceId: string;
  warehouseId: string;
  returnWarehouseId: string;
  lines: ReturnLineInput[];
  replacements: Array<{ variationId: string; qty: string }>;
  reasonCode: string;
  reasonNote?: string | undefined;
}
export interface ExchangeQuote {
  returnedValue: string; replacementValue: string; debt: string; funds: string;
  debtApplied: string; transferAmount: string; fundedTransfer: string;
  collectAmount: string; refundAmount: string; policy: string; token: string;
}
type Executor = Db | Transaction<Database>;

export class ExchangeService {
  readonly db: Db;
  constructor(db: Db) { this.db = db; }

  async quote(input: ExchangeInput, ex: Executor = this.db): Promise<ExchangeQuote> {
    // تعداد، مالیات و باقی‌مانده گردکردن همگی در SQL محاسبه می‌شوند.
    const result = await sql<Omit<ExchangeQuote, "token">>`
      WITH selected AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(input.lines)}::jsonb) AS x("invoiceLineId" uuid,qty numeric)
      ), returned AS (
        SELECT il.id, s.qty, il.qty-il.returned_qty remaining,
          round(il.net_amount*(il.returned_qty+s.qty)/il.qty)-coalesce((SELECT sum(rl.net_amount)
            FROM sales.sale_return_line rl JOIN sales.sale_return r ON r.id=rl.return_id WHERE rl.invoice_line_id=il.id AND r.status='posted'),0)
          +round(il.tax_amount*(il.returned_qty+s.qty)/il.qty)-coalesce((SELECT sum(rl.tax_amount)
            FROM sales.sale_return_line rl JOIN sales.sale_return r ON r.id=rl.return_id WHERE rl.invoice_line_id=il.id AND r.status='posted'),0) value
        FROM selected s JOIN sales.invoice_line il ON il.id=s."invoiceLineId" AND il.invoice_id=${input.invoiceId}::uuid
      ), replacements AS (
        SELECT x."variationId", x.qty, round(x.qty*p.amount) net FROM
          jsonb_to_recordset(${JSON.stringify(input.replacements)}::jsonb) x("variationId" uuid,qty numeric)
        JOIN catalog.variation v ON v.id=x."variationId" AND v.status='active'
        JOIN LATERAL (SELECT amount FROM catalog.price WHERE variation_id=v.id AND price_list='default'
          AND valid_from<=now() AND (valid_to IS NULL OR valid_to>now()) ORDER BY valid_from DESC LIMIT 1) p ON true
      ), totals AS (
        SELECT (SELECT sum(value) FROM returned) returned,
          (SELECT sum(net+sales.line_tax("variationId",net)) FROM replacements) replacement,
          i.payable_amount,
          coalesce((SELECT sum(CASE WHEN p.direction='in' THEN p.amount ELSE -p.amount END)
            FROM treasury.payment p JOIN treasury.payment_method m ON m.code=p.method_code
            WHERE p.invoice_id=i.id AND m.kind<>'credit' AND p.status IN ('succeeded','settled','reconciled')),0) received,
          coalesce((SELECT sum(refund_amount) FROM sales.sale_return WHERE invoice_id=i.id AND status='posted'),0) refunded,
          coalesce((SELECT sum(net_amount+tax_amount+shipping_amount) FROM sales.sale_return WHERE invoice_id=i.id AND status='posted'),0) previous,
          platform.setting_text('exchange.debt_policy','unset') policy
        FROM sales.invoice i WHERE i.id=${input.invoiceId}::uuid AND i.status IN ('finalized','paid','partially_returned')
          AND (SELECT count(*) FROM returned)=${input.lines.length}
          AND (SELECT count(DISTINCT id) FROM returned)=${input.lines.length}
          AND NOT EXISTS(SELECT 1 FROM returned WHERE qty<=0 OR qty>remaining)
          AND (SELECT count(*) FROM replacements)=${input.replacements.length}
          AND NOT EXISTS(SELECT 1 FROM replacements WHERE qty<=0)
      ), balances AS (
        SELECT *,greatest(payable_amount-previous-received+refunded+sales.exchange_out(${input.invoiceId}::uuid)
          -sales.exchange_in(${input.invoiceId}::uuid),0) debt,
          greatest(received-refunded+sales.exchange_funding(${input.invoiceId}::uuid),0) funds FROM totals
      ) SELECT returned::text "returnedValue", replacement::text "replacementValue",debt::text,funds::text,
        a.debt_applied::text "debtApplied",a.transfer_amount::text "transferAmount",a.funded_transfer::text "fundedTransfer",
        a.collect_amount::text "collectAmount",a.refund_amount::text "refundAmount",
        CASE WHEN policy='unset' THEN 'carry_debt' ELSE policy END policy
        FROM balances CROSS JOIN LATERAL sales.exchange_allocation(returned,replacement,debt,funds,policy) a
    `.execute(ex);
    const q = result.rows[0];
    if (!q) throw new ReturnError("exchange_not_available", "اقلام، تعداد باقی‌مانده یا قیمت معتبر تعویض تغییر کرده است", 409);
    return { ...q, token: createHash("sha256").update(canonicalJson({ input, quote: q })).digest("hex") };
  }

  async postIn(trx: Transaction<Database>, input: ExchangeInput & {
    token: string; actorId: string; shiftId: string;
    collectMethod?: string | undefined; collectReference?: string | undefined;
    refundMethod?: string | undefined; refundReference?: string | undefined; refundPaymentId?: string | undefined;
  }): Promise<string> {
    await setActor(trx, input.actorId);
    // فاکتور اصلی، سپس مشتری، سپس همه موجودی‌ها با ترتیب ثابت؛ همان قفل refund/finalize.
    const old = await trx.selectFrom("sales.invoice").selectAll().where("id", "=", input.invoiceId).forUpdate().executeTakeFirstOrThrow();
    const warehouse = await trx.selectFrom("inventory.warehouse").select(["kind", "branch_id"]).where("id", "=", input.warehouseId).executeTakeFirst();
    if (!warehouse || warehouse.branch_id !== old.branch_id || ["defective", "in_transit"].includes(warehouse.kind))
      throw new ReturnError("exchange_warehouse", "جایگزین باید از انبار قابل فروش همان شعبه خارج شود", 422);
    if (old.customer_id) await sql`SELECT id FROM sales.customer WHERE id=${old.customer_id}::uuid FOR NO KEY UPDATE`.execute(trx);
    const quoteInput: ExchangeInput = { invoiceId: input.invoiceId, warehouseId: input.warehouseId,
      returnWarehouseId: input.returnWarehouseId, lines: input.lines, replacements: input.replacements,
      reasonCode: input.reasonCode, ...(input.reasonNote === undefined ? {} : { reasonNote: input.reasonNote }) };
    const q = await this.quote(quoteInput, trx);
    if (q.token !== input.token) throw new ReturnError("exchange_quote_changed", "تسویه تعویض تغییر کرده؛ پیش‌نمایش تازه را تأیید کنید");
    await sql`SELECT inventory.lock_stock(v,w) FROM (
      SELECT DISTINCT il.variation_id v,CASE WHEN x.condition='defective' THEN
        (SELECT id FROM inventory.warehouse WHERE branch_id=${old.branch_id}::uuid AND kind='defective' LIMIT 1)
        ELSE ${input.returnWarehouseId}::uuid END w
      FROM jsonb_to_recordset(${JSON.stringify(input.lines)}::jsonb) x("invoiceLineId" uuid,condition text,restock boolean)
      JOIN sales.invoice_line il ON il.id=x."invoiceLineId" WHERE coalesce(x.restock,true)
      UNION SELECT x."variationId",${input.warehouseId}::uuid FROM
        jsonb_to_recordset(${JSON.stringify(input.replacements)}::jsonb) x("variationId" uuid)
    ) locks ORDER BY v,w`.execute(trx);
    const invoices = new InvoiceService(this.db);
    const returns = new ReturnService(this.db);
    const replacement = await invoices.createDraftIn(trx, { branchId: old.branch_id, warehouseId: input.warehouseId,
      shiftId: input.shiftId, customerId: old.customer_id ?? undefined, channel: "pos", actorId: input.actorId });
    const returnId = await returns.createDraftIn(trx, { invoiceId: input.invoiceId, lines: input.lines,
      refundAmount: BigInt(q.refundAmount), refundMethod: input.refundMethod, refundReference: input.refundReference,
      refundPaymentId: input.refundPaymentId, reasonCode: input.reasonCode, reasonNote: input.reasonNote,
      shiftId: input.shiftId, actorId: input.actorId });
    await sql`SELECT sales.set_return_warehouse(${returnId}::uuid,${input.returnWarehouseId}::uuid,${input.actorId}::uuid)`.execute(trx);
    await sql`UPDATE sales.sale_return SET kind='exchange' WHERE id=${returnId}::uuid`.execute(trx);
    const inserted = await sql<{ id: string }>`INSERT INTO sales.exchange
      (original_invoice_id,replacement_invoice_id,return_id,actor_id,policy,returned_value,replacement_value,
       debt_applied,transfer_amount,funded_transfer,collect_amount,refund_amount)
      VALUES (${input.invoiceId}::uuid,${replacement}::uuid,${returnId}::uuid,${input.actorId}::uuid,${q.policy},
        ${q.returnedValue}::numeric,${q.replacementValue}::numeric,${q.debtApplied}::numeric,${q.transferAmount}::numeric,
        ${q.fundedTransfer}::numeric,${q.collectAmount}::numeric,${q.refundAmount}::numeric) RETURNING id`.execute(trx);
    await returns.postIn(trx, returnId, input.actorId);
    // کالای سالمِ همان انبار اکنون قابل فروش است؛ معیوب/بدون بازگشت هرگز پشتوانه فروش نمی‌شود.
    for (const line of input.replacements) await invoices.addLineIn(trx, { invoiceId: replacement,
      variationId: line.variationId, qty: line.qty, actorId: input.actorId });
    if (BigInt(q.collectAmount)>0n) {
      if (!input.collectMethod) throw new ReturnError("payment_required", "روش دریافت اختلاف قیمت لازم است", 422);
      await invoices.addPaymentIn(trx, { invoiceId: replacement, methodCode: input.collectMethod,
        amount: BigInt(q.collectAmount), refNo: input.collectReference, actorId: input.actorId });
    }
    await invoices.finalizeIn(trx, replacement, input.actorId);
    return inserted.rows[0]!.id;
  }

  async byId(id: string) {
    const result = await sql<{ id: string; invoiceId: string; replacementInvoiceId: string; returnId: string;
      branchId: string; actorId: string; number: string; returnNumber: string; collectAmount: string; refundAmount: string;
      transferAmount: string; debtApplied: string; policy: string }>`
      SELECT e.id,e.original_invoice_id "invoiceId",e.replacement_invoice_id "replacementInvoiceId",e.return_id "returnId",
        i.branch_id "branchId",e.actor_id "actorId",i.number,r.number "returnNumber",e.collect_amount::text "collectAmount",
        e.refund_amount::text "refundAmount",e.transfer_amount::text "transferAmount",e.debt_applied::text "debtApplied",e.policy
      FROM sales.exchange e JOIN sales.invoice i ON i.id=e.replacement_invoice_id
      JOIN sales.sale_return r ON r.id=e.return_id WHERE e.id=${id}::uuid
    `.execute(this.db);
    return result.rows[0] ?? null;
  }
}
