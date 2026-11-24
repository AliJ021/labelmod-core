import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { AuthError, type ResolvedSession } from "../auth/service.ts";
import { can, requireForSession } from "../auth/permission.ts";
import { assertBranch, branchesOf } from "../sales/scope.ts";
import { requireInvoiceRead, requireInvoiceReadOf } from "../sales/invoice-access.ts";
import { InvoiceError, InvoiceService, invoiceToJson } from "../sales/invoice.ts";
import { invoicePage, INVOICE_PAGE_CSP, receiptFooterFromSettings, latinDigits } from "../sales/invoice-page.ts";
import { setActor } from "../lib/idempotency.ts";
import { parseMoney } from "../lib/money.ts";
import { STORE_BRAND } from "../lib/store-brand.ts";

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
      // طرح ۱۰: «تسویه‌شده»، «مانده‌دار» و «مرجوعی» (settled/open/returns) تراشه‌های فهرست‌اند؛
      // finalized و returned قدیمی برای پیوندهای ذخیره‌شده می‌مانند.
      status: z.enum(["all", "draft", "finalized", "cancelled", "returned", "settled", "open", "returns", "exchanged"]).default("all"),
      channel: z.enum(["pos", "web", "phone", "instagram"]).optional(),
      from: z.iso.date().optional(), to: z.iso.date().optional(),
      // تصمیم مالک (۲۰۲۶/۱۱/۰۷): فهرست با «امروز» باز می‌شود. «امروز» را سرور تعیین می‌کند
      // (`platform.business_date()`، منطقهٔ زمانی تنظیمات)، نه ساعت مرورگر؛ از/تا صریح بر آن مقدم است.
      mine: z.literal("1").optional(),
      day: z.enum(["today"]).optional(),
      branchId: z.string().uuid().optional(), search: z.string().trim().max(80).default("") }).parse(req.query);
    const businessDate = (await sql<{ d: string }>`SELECT platform.business_date()::text AS d`.execute(db)).rows[0]!.d;
    if (q.day === "today" && !q.from && !q.to) { q.from = businessDate; q.to = businessDate; }
    if (q.from && q.to && q.from > q.to) throw new InvoiceError("bad_period", "تاریخ پایان پیش از آغاز است.", 422);
    const numberSearch = latinDigits(q.search);
    const scope = await branchesOf(db, s.userId);
    if (q.branchId) await assertBranch(db, s.userId, q.branchId);
    const all = (await can(db, { userId: s.userId, operation: "report.view", viaPin: s.pinUnlocked })).verdict === "allow";
    // یک تعریف برای ردیف، فیلتر، شمارش تراشه و جمع (طرح ۱۰). پایه بدون وضعیت است تا شمارش هر تراشه
    // بگوید «اگر مرا بزنی چند تا می‌بینی».
    //   دریافتی  ورود موفق (succeeded/settled/reconciled).
    //   مانده    قابل پرداخت منهای دریافتی، هرگز منفی — همان ستون «مانده».
    //   تراشه    مرجوعی (partially_returned/returned) پیش از همه؛ بعد فاکتور قطعی با ماندهٔ بیش از صفر
    //            «مانده‌دار» و بی مانده «تسویه‌شده». ⚠️ وضعیت paid را هیچ تابع دیتابیس نمی‌نشاند، پس
    //            «تسویه‌شده» از وضعیت خوانده نمی‌شود؛ از مانده خوانده می‌شود. پیش‌نویس و لغوشده خودشان‌اند.
    const scoped = sql`SELECT i.*, c.full_name AS customer_name,
        CASE WHEN length(c.mobile_normalized) >= 8 THEN left(c.mobile_normalized, 4) || ' *** ' || right(c.mobile_normalized, 4) END AS customer_mobile_masked,
        coalesce(pay.amount,0) AS received,
        concat_ws('، ', NULLIF(pay.methods,''), CASE WHEN ex.transfer_amount>0 THEN 'انتقال از تعویض' END) AS methods,
        greatest(i.payable_amount-(CASE WHEN i.status='draft' THEN coalesce(pay.amount,0) ELSE i.paid_amount END)-coalesce(ex.transfer_amount,0)-ret.debt,0) AS remaining,
        CASE WHEN ret.exchanged THEN 'exchanged'
             WHEN i.status IN ('partially_returned','returned') THEN 'returns'
             WHEN i.status IN ('finalized','paid') THEN CASE WHEN i.payable_amount-(CASE WHEN i.status='draft' THEN coalesce(pay.amount,0) ELSE i.paid_amount END)-coalesce(ex.transfer_amount,0)-ret.debt > 0 THEN 'open' ELSE 'settled' END
             ELSE i.status END AS chip
      FROM sales.invoice i LEFT JOIN sales.customer c ON c.id=i.customer_id
      LEFT JOIN sales.exchange ex ON ex.replacement_invoice_id=i.id
      LEFT JOIN LATERAL (SELECT coalesce(sum(r.receivable_applied),0) AS debt,
        bool_and(r.kind='exchange') AS exchanged FROM sales.sale_return r WHERE r.invoice_id=i.id AND r.status='posted') ret ON true
      LEFT JOIN LATERAL (SELECT sum(p.amount) AS amount,string_agg(DISTINCT m.name,'، ') AS methods
        FROM treasury.payment p JOIN treasury.payment_method m ON m.code=p.method_code
        WHERE p.invoice_id=i.id AND p.direction='in' AND p.status IN ('succeeded','settled','reconciled')) pay ON true
      WHERE NOT EXISTS (SELECT 1 FROM sales.invoice_archive a WHERE a.invoice_id=i.id)
      AND (${scope === "all"} OR i.branch_id=ANY(${scope === "all" ? [] : scope}::uuid[]))
      AND (${q.branchId ?? null}::uuid IS NULL OR i.branch_id=${q.branchId ?? null}::uuid)
      AND (${q.channel ?? null}::text IS NULL OR i.channel=${q.channel ?? null}::text)
      AND (${q.from ?? null}::date IS NULL OR platform.business_date(i.occurred_at)>=${q.from ?? null}::date)
      AND (${q.to ?? null}::date IS NULL OR platform.business_date(i.occurred_at)<=${q.to ?? null}::date)
      AND (${!q.mine} OR coalesce(i.seller_id,i.created_by)=${s.userId}::uuid)
      AND (${all} OR coalesce(i.seller_id,i.created_by)=${s.userId}::uuid OR (i.status='draft' AND i.created_by=${s.userId}::uuid))
      AND (${q.search}='' OR strpos(coalesce(sales.invoice_display_number(i.id),''),${numberSearch})>0 OR strpos(coalesce(i.number,''),${numberSearch})>0 OR strpos(coalesce(c.full_name,''),${q.search})>0)`;
    const filter = sql`(${q.status}='all' OR i.status=${q.status} OR i.chip=${q.status}
      OR (${q.status}='finalized' AND i.status IN ('paid','partially_returned')))`;
    const result = await sql`WITH i AS (${scoped})
      SELECT i.id,sales.invoice_display_number(i.id) AS number,i.status,i.chip,i.channel,i.branch_id AS "branchId",b.name AS "branchName",
      i.shift_id AS "shiftId",i.created_by AS "createdBy",creator.full_name AS "creatorName",
      i.finalized_by AS "finalizedBy",finisher.full_name AS "finalizerName",i.customer_name AS "customerName",
      i.customer_mobile_masked AS "customerMobile",
      i.occurred_at AS "occurredAt",i.last_activity_at AS "lastActivityAt",i.payable_amount::text AS "payableAmount",
      i.received::text AS "receivedAmount",i.methods AS "paymentMethods",
      i.remaining::text AS "remainingAmount",
      (i.status='draft' AND i.created_by=${s.userId}::uuid AND sh.user_id=${s.userId}::uuid AND sh.status='open') AS "canResume",
      (EXISTS(SELECT 1 FROM sales.invoice_review r WHERE r.invoice_id=i.id) OR i.status='draft' AND i.last_activity_at < now()-make_interval(hours=>
        (SELECT value::text::int FROM platform.setting WHERE key='sale.draft_attention_hours'))) AS "needsReview"
      FROM i JOIN platform.branch b ON b.id=i.branch_id
      LEFT JOIN identity.app_user creator ON creator.id=coalesce(i.seller_id,i.created_by) LEFT JOIN identity.app_user finisher ON finisher.id=i.finalized_by
      LEFT JOIN sales.cash_shift sh ON sh.id=i.shift_id
      WHERE ${filter} ORDER BY i.occurred_at DESC,i.id DESC LIMIT 50 OFFSET ${(q.page-1)*50}`.execute(db);
    const count = await sql<{ total: string }>`WITH i AS (${scoped}) SELECT count(*)::text AS total FROM i WHERE ${filter}`.execute(db);
    // جمع‌های همین فیلتر (طرح ۱۰). پول در SQL جمع می‌شود، نه در مرورگر. فقط «فاکتور واقعی»
    // (finalized، paid، partially_returned، returned) شمرده می‌شود: پیش‌نویس و لغوشده فروش نیستند.
    const summary = await sql<{ count: string; payable: string; received: string; remaining: string }>`WITH i AS (${scoped})
      SELECT count(*)::text AS count, coalesce(sum(i.payable_amount),0)::text AS payable,
        coalesce(sum(i.received),0)::text AS received, coalesce(sum(i.remaining),0)::text AS remaining
      FROM i WHERE ${filter} AND i.status IN ('finalized','paid','partially_returned','returned')`.execute(db);
    const buckets = await sql<{ bucket: string; chip: string; n: string }>`WITH i AS (${scoped})
      SELECT CASE WHEN i.status IN ('paid','partially_returned') THEN 'finalized' ELSE i.status END AS bucket, i.chip, count(*)::text AS n
      FROM i GROUP BY 1, 2`.execute(db);
    // کلیدهای قدیمی (all، draft، finalized، cancelled، returned) همان افراز پیشین‌اند؛ تراشه‌های طرح ۱۰
    // (settled، open، returns) کلید جدا دارند و در «all» دوباره شمرده نمی‌شوند.
    const statusCounts: Record<string, number> = { all: 0, draft: 0, finalized: 0, cancelled: 0, returned: 0, settled: 0, open: 0, returns: 0 };
    for (const b of buckets.rows) {
      statusCounts[b.bucket] = (statusCounts[b.bucket] ?? 0) + Number(b.n);
      statusCounts.all = (statusCounts.all ?? 0) + Number(b.n);
      if (b.chip === "settled" || b.chip === "open" || b.chip === "returns" || b.chip === "exchanged") statusCounts[b.chip] = (statusCounts[b.chip] ?? 0) + Number(b.n);
    }
    const sum = summary.rows[0]!;
    return { rows: result.rows, total: Number(count.rows[0]?.total ?? 0), page: q.page, pageSize: 50,
      summary: { count: Number(sum.count), payableAmount: sum.payable, receivedAmount: sum.received, remainingAmount: sum.remaining },
      statusCounts,
      // بازهٔ واقعیِ اعمال‌شده و «امروز» سرور، تا صفحه عنوان را از پاسخ بسازد نه از ساعت مرورگر.
      businessDate, range: { from: q.from ?? null, to: q.to ?? null } };
  });

  app.get("/invoices/:id/refund-sources", async req => {
    const s = session(req.session);
    await requireInvoiceRead(db, s);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const inv = await invoices.byId(id);
    if (!inv) throw new InvoiceError("invoice_not_found", "فاکتور یافت نشد", 404);
    await assertBranch(db, s.userId, inv.branchId);
    const rows = await sql`SELECT p.id,p.method_code AS "methodCode",p.ref_no AS reference,(p.amount-coalesce(refunded.amount,0))::text AS remaining
      FROM treasury.payment p LEFT JOIN LATERAL (
        SELECT sum(out.amount) AS amount FROM treasury.payment out JOIN sales.sale_return r ON r.id=out.return_id
        WHERE coalesce(out.refund_origin_id,r.refund_payment_id)=p.id AND out.method_code=p.method_code AND out.direction='out' AND out.status IN ('succeeded','settled','reconciled')
      ) refunded ON true WHERE p.invoice_id IN (SELECT invoice_id FROM sales.exchange_ancestors(${id}::uuid)) AND p.method_code IN ('snappay','digipay') AND p.direction='in'
        AND p.status IN ('succeeded','settled','reconciled') AND p.amount>coalesce(refunded.amount,0)
      ORDER BY p.occurred_at,p.id`.execute(db);
    const received = await sql<{method: string}>`SELECT DISTINCT p.method_code AS method
      FROM treasury.payment p JOIN sales.exchange_ancestors(${id}::uuid) a ON a.invoice_id=p.invoice_id
      WHERE p.direction='in' AND p.status IN ('succeeded','settled','reconciled') ORDER BY method`.execute(db);
    return { payments: rows.rows, receivedMethods: received.rows.map(row => row.method) };
  });

  for (const documentKind of ["sale", "proforma"] as const) app.get(`/invoices/:id/${documentKind === "sale" ? "print" : "proforma-print"}`, async (req, reply) => {
    const s = session(req.session);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (documentKind === "proforma") await requireForSession(db, s, "sale.create");
    else await requireInvoiceReadOf(db, s, () => invoices.byId(id));
    const html = await db.transaction().setIsolationLevel("repeatable read").execute(async trx => {
      // Totals and draft lines must describe the same snapshot even if another till edits them.
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      const inv = await invoices.byId(id, trx);
      if (!inv) throw new InvoiceError("invoice_not_found", "فاکتور یافت نشد", 404);
      await assertBranch(trx, s.userId, inv.branchId);
      if (documentKind === "proforma") {
        if (inv.createdBy !== s.userId) await requireForSession(trx, s, "report.view");
        if (inv.channel !== "pos" || inv.status !== "draft" || inv.lines.length === 0)
          throw new InvoiceError("invoice_not_draft", "پیش‌فاکتور فقط برای سبد ذخیره‌شده و دارای کالا ممکن است.");
      } else if (!["finalized", "paid", "partially_returned", "returned"].includes(inv.status))
        throw new InvoiceError("invoice_not_finalized", "چاپ رسید فقط برای فاکتور قطعی ممکن است.");
      const meta = await sql<{ shop: string; customer: string | null; zone: string; return_hours: string | null; site_url: string | null }>`
        SELECT b.name AS shop,CASE WHEN i.number IS NULL THEN sales.customer_print_name(c.full_name,c.salutation) ELSE coalesce(i.receipt_customer_name,c.full_name) END AS customer,platform.setting_text('platform.timezone','Asia/Tehran') AS zone,
          (SELECT value::text FROM platform.setting WHERE key='return.window_hours') AS return_hours,
          platform.setting_text('web.site_url','') AS site_url
        FROM sales.invoice i JOIN platform.branch b ON b.id=i.branch_id LEFT JOIN sales.customer c ON c.id=i.customer_id WHERE i.id=${id}::uuid`.execute(trx);
      // ستون paid_amount پیش‌نویس تا نهایی‌سازی صفر است. پیش‌فاکتورِ پس از پرداخت جزئی
      // باید همان دریافتی را نشان دهد، وگرنه کل مبلغ «مانده» چاپ و دوباره مطالبه می‌شد.
      // فرمول عیناً همان v_paid در sales.finalize_invoice است، در همین snapshot.
      const paidAmount = documentKind === "proforma"
        ? parseMoney((await sql<{ paid: string }>`
            SELECT coalesce(sum(CASE WHEN p.direction='in' THEN p.amount ELSE -p.amount END),0)::text AS paid
              FROM treasury.payment p JOIN treasury.payment_method m ON m.code=p.method_code
             WHERE p.invoice_id=${id}::uuid AND m.kind<>'credit'
               AND p.status IN ('succeeded','settled','reconciled')`.execute(trx)).rows[0]!.paid)
        : inv.paidAmount;
      const variants = await trx.selectFrom("catalog.variation").select(["id", "color", "size"])
        .where("id", "in", inv.lines.map(l => l.variationId)).execute();
      return invoicePage({ ...inv, paidAmount, documentKind, number: documentKind === "proforma" ? BigInt(`0x${inv.id.replaceAll("-", "")}`).toString(10) : inv.number ?? "", shopName: STORE_BRAND, customerName: meta.rows[0]?.customer ?? null,
        ...receiptFooterFromSettings({ return_hours: meta.rows[0]?.return_hours ?? null, site_url: meta.rows[0]?.site_url ?? null }),
        lines: inv.lines.map(l => { const v = variants.find(x => x.id === l.variationId); return { ...l, color: v?.color ?? null, size: v?.size ?? null }; }) }, meta.rows[0]?.zone ?? "Asia/Tehran");
    });
    return reply.header("content-type", "text/html; charset=utf-8").header("cache-control", "no-store")
      .header("content-security-policy", INVOICE_PAGE_CSP).header("x-robots-tag", "noindex, nofollow").send(html);
  });

  app.patch("/invoices/:id/review", async req => {
    const s = session(req.session);
    const { id } = z.object({id:z.uuid()}).parse(req.params);
    const body = z.object({hold:z.boolean(), reason:z.string().trim().min(1).max(200)}).parse(req.body);
    await db.transaction().execute(async trx => {
      const inv = await trx.selectFrom("sales.invoice").select(["branch_id","status","created_by","channel","shift_id"])
        .where("id","=",id).forUpdate().executeTakeFirst();
      if (!inv) throw new InvoiceError("invoice_not_found","فاکتور یافت نشد",404);
      await assertBranch(trx,s.userId,inv.branch_id);
      if (inv.status === "draft" && inv.created_by === s.userId) {
        await requireForSession(trx,s,inv.channel === "instagram" ? "instagram.pos.sell" : "sale.create");
      } else await requireForSession(trx,s,"invoice.cancel");
      if (body.hold && !["draft","finalized","paid","partially_returned"].includes(inv.status)) throw new InvoiceError("invalid_state","این سند قابل تعلیق نیست.");
      if (body.hold && inv.status === "draft") {
        const uncertain = await trx.selectFrom("treasury.payment").select("id").where("invoice_id","=",id)
          .where("status","in",["initiated","pending","unknown"]).executeTakeFirst();
        if (uncertain) throw new InvoiceError("payment_review_required","ابتدا نتیجهٔ دریافت وجه روشن شود.");
      }
      await setActor(trx,s.userId);
      const change = body.hold ? await sql`INSERT INTO sales.invoice_review(invoice_id,reason,actor_id)
        VALUES(${id}::uuid,${body.reason},${s.userId}::uuid) ON CONFLICT DO NOTHING RETURNING invoice_id`.execute(trx)
        : await sql`DELETE FROM sales.invoice_review WHERE invoice_id=${id}::uuid RETURNING invoice_id`.execute(trx);
      if (change.rows.length) await sql`SELECT platform.audit(${body.hold ? "invoice.hold" : "invoice.resume"},'invoice',${id},
        jsonb_build_object('reason',${body.reason}::text),${s.userId}::uuid)`.execute(trx);
    });
    return {held: body.hold};
  });

  app.get("/invoices/:id/overview", async req => {
    const s = session(req.session);
    await requireInvoiceRead(db, s);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const inv = await invoices.byId(id);
    if (!inv) throw new InvoiceError("invoice_not_found", "فاکتور یافت نشد", 404);
    await assertBranch(db, s.userId, inv.branchId);
    if (inv.createdBy !== s.userId && inv.sellerId !== s.userId) await requireForSession(db, s, "report.view");
    const exchanges = await sql<{ id: string; number: string; source: boolean; transfer: string }>`
      SELECT other.id,sales.invoice_display_number(other.id) AS number,e.original_invoice_id=${id}::uuid AS source,
        e.transfer_amount::text AS transfer FROM sales.exchange e JOIN sales.invoice other ON
        other.id=CASE WHEN e.original_invoice_id=${id}::uuid THEN e.replacement_invoice_id ELSE e.original_invoice_id END
      WHERE e.original_invoice_id=${id}::uuid OR e.replacement_invoice_id=${id}::uuid ORDER BY e.created_at,e.id`.execute(db);
    const canManage = (await can(db,{userId:s.userId,operation:"invoice.cancel",viaPin:s.pinUnlocked})).verdict === "allow";
    const canEditLines = inv.status === "draft" && (inv.createdBy === s.userId || canManage)
      && (inv.channel === "pos" || inv.channel === "instagram");
    const accounting = (await sql<{remaining:string; exchanged:boolean}>`
      SELECT greatest(i.payable_amount-i.paid_amount-sales.exchange_in(i.id)-coalesce(sum(r.receivable_applied),0),0)::text AS remaining,
        coalesce(bool_and(r.kind='exchange') FILTER (WHERE r.id IS NOT NULL),false) AS exchanged
      FROM sales.invoice i LEFT JOIN sales.sale_return r ON r.invoice_id=i.id AND r.status='posted'
      WHERE i.id=${id}::uuid GROUP BY i.id`.execute(db)).rows[0]!;
    return { invoice: invoiceToJson(inv), payments: await invoices.draftPayments(id), exchanges: exchanges.rows,
      remaining: accounting.remaining, exchangesOnly: accounting.exchanged, canManage, canEditLines };

  });
}
