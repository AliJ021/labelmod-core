import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { AuthError, type ResolvedSession } from "../auth/service.ts";
import { requireForSession } from "../auth/permission.ts";
import { branchesOf, ScopeError } from "../sales/scope.ts";
import { setActor } from "../lib/idempotency.ts";
import { InvoiceError } from "../sales/invoice.ts";

export function registerSnappayRoutes(app: FastifyInstance, db: Db): void {
  async function guard(raw: unknown, write = false) {
    const s = raw as ResolvedSession | null;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    await requireForSession(db, s, write ? "settings.security" : "settings.view");
    if (await branchesOf(db, s.userId) !== "all") throw new ScopeError("تنظیم حساب سراسری فقط برای مدیر همهٔ شعب است.");
    return s;
  }
  app.get("/snappay/config", async req => {
    await guard(req.session);
    const config = await sql<{ accountId: string; enabled: boolean }>`SELECT
      platform.setting_text('payment.snappay_account_id','') AS "accountId",
      (treasury.snappay_account() IS NOT NULL AND EXISTS(SELECT 1 FROM treasury.payment_method WHERE code='snappay' AND is_active)) AS enabled`.execute(db);
    const accounts = await sql`SELECT a.id,a.name,a.code,b.name AS "bankName" FROM treasury.account a
      JOIN treasury.account b ON b.id=a.settlement_account_id AND b.is_active AND b.kind='bank'
      JOIN ledger.account l ON l.code=a.ledger_account_code AND l.is_active AND l.is_postable
      WHERE a.is_active AND a.kind='gateway' AND (b.branch_id IS NULL OR b.branch_id=a.branch_id)
        AND EXISTS(SELECT 1 FROM ledger.posting_rule r WHERE r.event_type='sale_shift' AND r.leg='gateway_clearing'
          AND r.side='debit' AND r.is_active AND r.account_code=l.code) ORDER BY a.name,a.id`.execute(db);
    return { ...config.rows[0], accounts: accounts.rows };
  });
  app.put("/snappay/config", async req => {
    const s = await guard(req.session, true);
    const body = z.object({ accountId: z.union([z.string().uuid(), z.literal("")]) }).parse(req.body);
    await db.transaction().execute(async trx => {
      await setActor(trx, s.userId);
      await sql`SELECT platform.set_setting('payment.snappay_account_id',${JSON.stringify(body.accountId)}::jsonb,'تنظیم ثبت دستی اسنپ‌پی')`.execute(trx);
      if (body.accountId) {
        const valid = await sql<{ id: string | null }>`SELECT treasury.snappay_account() AS id`.execute(trx);
        if (!valid.rows[0]?.id) throw new InvoiceError("snappay_account_invalid", "حساب واسط فعال، بانک تسویه و نگاشت دفتر معتبر لازم است.", 422);
      }
      await trx.updateTable("treasury.payment_method").set({is_active: !!body.accountId}).where("code", "=", "snappay").execute();
    });
    return { ok: true };
  });
}
