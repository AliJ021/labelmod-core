import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { AuthError, type ResolvedSession } from "../auth/service.ts";
import { can, requireForSession } from "../auth/permission.ts";
import { assertBranch, branchesOf } from "../sales/scope.ts";
import { requireInvoiceRead } from "../sales/invoice-access.ts";
import { InvoiceError, InvoiceService, invoiceToJson } from "../sales/invoice.ts";
import { invoicePage, INVOICE_PAGE_CSP } from "../sales/invoice-page.ts";

export function registerInvoiceWorkspaceRoutes(app: FastifyInstance, db: Db): void {
  const invoices = new InvoiceService(db);
  function session(raw: unknown) {
    const s = raw as ResolvedSession | null;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    return s;
  }
  app.get("/invoices", async req => {
    const s = session(req.session);
    await requireInvoiceRead(db, s);
    const q = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1),
      status: z.enum(["all", "draft", "finalized", "cancelled", "returned"]).default("all"),
      from: z.iso.date().optional(), to: z.iso.date().optional(),
      branchId: z.string().uuid().optional(), search: z.string().trim().max(80).default("") }).parse(req.query);
    if (q.from && q.to && q.from > q.to) throw new InvoiceError("bad_period", "تاریخ پایان پیش از آغاز است.", 422);
    const scope = await branchesOf(db, s.userId);
    if (q.branchId) await assertBranch(db, s.userId, q.branchId);
    const all = (await can(db, { userId: s.userId, operation: "report.view", viaPin: s.pinUnlocked })).verdict === "allow";
    const filter = sql`(${scope === "all"} OR i.branch_id=ANY(${scope === "all" ? [] : scope}::uuid[]))
      AND (${q.branchId ?? null}::uuid IS NULL OR i.branch_id=${q.branchId ?? null}::uuid)
      AND (${q.from ?? null}::date IS NULL OR platform.business_date(i.occurred_at)>=${q.from ?? null}::date)
      AND (${q.to ?? null}::date IS NULL OR platform.business_date(i.occurred_at)<=${q.to ?? null}::date)
      AND (${all} OR i.created_by=${s.userId}::uuid)
      AND (${q.status}='all' OR i.status=${q.status} OR (${q.status}='finalized' AND i.status IN ('paid','partially_returned')))
      AND (${q.search}='' OR strpos(coalesce(i.number,''),${q.search})>0 OR strpos(coalesce(c.full_name,''),${q.search})>0)`;
    const result = await sql`SELECT i.id,i.number,i.status,i.channel,i.branch_id AS "branchId",b.name AS "branchName",
      i.shift_id AS "shiftId",i.created_by AS "createdBy",creator.full_name AS "creatorName",
      i.finalized_by AS "finalizedBy",finisher.full_name AS "finalizerName",c.full_name AS "customerName",
      i.occurred_at AS "occurredAt",i.last_activity_at AS "lastActivityAt",i.payable_amount::text AS "payableAmount",
      coalesce(pay.amount,0)::text AS "receivedAmount",coalesce(pay.methods,'') AS "paymentMethods",
      (i.status='draft' AND i.created_by=${s.userId}::uuid AND sh.user_id=${s.userId}::uuid AND sh.status='open') AS "canResume",
      (i.status='draft' AND i.last_activity_at < now()-make_interval(hours=>
        (SELECT value::text::int FROM platform.setting WHERE key='sale.draft_attention_hours'))) AS "needsReview"
      FROM sales.invoice i JOIN platform.branch b ON b.id=i.branch_id
      LEFT JOIN identity.app_user creator ON creator.id=i.created_by LEFT JOIN identity.app_user finisher ON finisher.id=i.finalized_by
      LEFT JOIN sales.customer c ON c.id=i.customer_id LEFT JOIN sales.cash_shift sh ON sh.id=i.shift_id
      LEFT JOIN LATERAL (SELECT sum(p.amount) AS amount,string_agg(DISTINCT m.name,'، ') AS methods
        FROM treasury.payment p JOIN treasury.payment_method m ON m.code=p.method_code
        WHERE p.invoice_id=i.id AND p.direction='in' AND p.status IN ('succeeded','settled','reconciled')) pay ON true
      WHERE ${filter} ORDER BY i.occurred_at DESC,i.id DESC LIMIT 50 OFFSET ${(q.page-1)*50}`.execute(db);
    const count = await sql<{ total: string }>`SELECT count(*)::text AS total FROM sales.invoice i
      LEFT JOIN sales.customer c ON c.id=i.customer_id WHERE ${filter}`.execute(db);
    return { rows: result.rows, total: Number(count.rows[0]?.total ?? 0), page: q.page, pageSize: 50 };
  });

  app.get("/invoices/:id/refund-sources", async req => {
    const s = session(req.session);
    await requireInvoiceRead(db, s);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const inv = await invoices.byId(id);
    if (!inv) throw new InvoiceError("invoice_not_found", "فاکتور یافت نشد", 404);
    await assertBranch(db, s.userId, inv.branchId);
    const rows = await sql`SELECT p.id,p.ref_no AS reference,(p.amount-coalesce(refunded.amount,0))::text AS remaining
      FROM treasury.payment p LEFT JOIN LATERAL (
        SELECT sum(out.amount) AS amount FROM treasury.payment out JOIN sales.sale_return r ON r.id=out.return_id
        WHERE r.refund_payment_id=p.id AND out.direction='out' AND out.status IN ('succeeded','settled','reconciled')
      ) refunded ON true WHERE p.invoice_id=${id}::uuid AND p.method_code='snappay' AND p.direction='in'
        AND p.status IN ('succeeded','settled','reconciled') AND p.amount>coalesce(refunded.amount,0)
      ORDER BY p.occurred_at,p.id`.execute(db);
    return { payments: rows.rows };
  });

  app.get("/invoices/:id/print", async (req, reply) => {
    const s = session(req.session);
    await requireInvoiceRead(db, s);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const inv = await invoices.byId(id);
    if (!inv) throw new InvoiceError("invoice_not_found", "فاکتور یافت نشد", 404);
    await assertBranch(db, s.userId, inv.branchId);
    if (!["finalized", "paid", "partially_returned", "returned"].includes(inv.status))
      throw new InvoiceError("invoice_not_finalized", "چاپ رسید فقط برای فاکتور قطعی ممکن است.");
    const meta = await sql<{ shop: string; customer: string | null; zone: string }>`
      SELECT b.name AS shop,c.full_name AS customer,platform.setting_text('platform.timezone','Asia/Tehran') AS zone
      FROM sales.invoice i JOIN platform.branch b ON b.id=i.branch_id LEFT JOIN sales.customer c ON c.id=i.customer_id WHERE i.id=${id}::uuid`.execute(db);
    const variants = await db.selectFrom("catalog.variation").select(["id", "color", "size"])
      .where("id", "in", inv.lines.map(l => l.variationId)).execute();
    const html = invoicePage({ ...inv, number: inv.number ?? "", shopName: meta.rows[0]?.shop ?? "", customerName: meta.rows[0]?.customer ?? null,
      lines: inv.lines.map(l => { const v = variants.find(x => x.id === l.variationId); return { ...l, color: v?.color ?? null, size: v?.size ?? null }; }) }, meta.rows[0]?.zone ?? "Asia/Tehran");
    return reply.header("content-type", "text/html; charset=utf-8").header("cache-control", "no-store")
      .header("content-security-policy", INVOICE_PAGE_CSP).header("x-robots-tag", "noindex, nofollow").send(html);
  });

  app.get("/invoices/:id/overview", async req => {
    const s = session(req.session);
    await requireInvoiceRead(db, s);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const inv = await invoices.byId(id);
    if (!inv) throw new InvoiceError("invoice_not_found", "فاکتور یافت نشد", 404);
    await assertBranch(db, s.userId, inv.branchId);
    if (inv.createdBy !== s.userId) await requireForSession(db, s, "report.view");
    return { invoice: invoiceToJson(inv), payments: await invoices.draftPayments(id) };
  });
}
