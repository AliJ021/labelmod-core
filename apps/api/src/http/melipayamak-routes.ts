import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { withActor } from "../db/actor.ts";
import { AuthError } from "../auth/service.ts";
import { can, requireForSession } from "../auth/permission.ts";
import { SettingError } from "../platform/settings.ts";
import { otpText, invoiceText } from "../worker/sms-copy.ts";
import { digestContent } from "../worker/digest.ts";
import { meliCredit, SmsError } from "../worker/sms.ts";
import { readNotifySettings } from "../worker/settings.ts";
import { encryptMeliKey, readMeliConnection } from "../platform/melipayamak-credential.ts";

const bodySchema = z.object({
  revision: z.number().int().nonnegative(),
  accountName: z.string().trim().max(100),
  apiKey: z.string().trim().min(1).max(2048).optional(),
  clearKey: z.boolean().optional(),
  digestEnabled: z.boolean().optional(),
  digestPattern: z.number().int().positive().max(2147483647).nullable().optional(),
  digestCopy: z.string().trim().min(1).max(750).optional(),
  transport: z.enum(["console", "panel"]).optional(),
  otpPattern: z.number().int().positive().max(2147483647).nullable().optional(),
  invoicePattern: z.number().int().positive().max(2147483647).nullable().optional(),
  otpCopy: z.string().trim().max(750).optional(),
  invoiceCopy: z.string().trim().max(750).optional(),
}).strict().refine((b) => !(b.clearKey && b.apiKey), { message: "حذف و جایگزینی هم‌زمان کلید مجاز نیست" });

export function registerMeliPayamakRoutes(app: FastifyInstance, db: Db, master: string | undefined): void {
  async function status() {
    const r = await sql<{ accountName: string; hasKey: boolean; revision: number; updatedAt: Date }>`
      SELECT account_name AS "accountName",encrypted_key IS NOT NULL AS "hasKey",revision,updated_at AS "updatedAt",
        transport, otp_pattern AS "otpPattern", invoice_pattern AS "invoicePattern",
        digest_enabled AS "digestEnabled", digest_pattern AS "digestPattern",digest_copy AS "digestCopy",
        otp_copy AS "otpCopy", invoice_copy AS "invoiceCopy"
      FROM platform.melipayamak_credential WHERE singleton`.execute(db);
    if (!r.rows[0]) throw new SettingError("credential_missing", "تنظیم اتصال ملی‌پیامک آماده نیست", 503);
    const settings = await readNotifySettings(db);
    return { ...r.rows[0], storageReady: Boolean(master), examples: {
      otp: otpText("123456"), invoice: invoiceText("فروشگاه نمونه", "۱۴۰۵", "۵۰٬۰۰۰", settings.webSiteUrl ? settings.webSiteUrl+"/?labelmod_receipts=1" : (settings.publicUrl||"https://example.com")+"/customer-receipts"),
    }, routing: {
      enabled: settings.smsEnabled, provider: settings.provider, sender: settings.sender,
      invoiceEnabled: settings.invoiceSms, receiptConsentRequired: settings.invoiceSmsRequiresConsent,
      hasPublicUrl: Boolean(settings.publicUrl), chequeEnabled: settings.chequeDueSms,
    } };
  }

  app.get("/settings/melipayamak-credential", async (req) => {
    if (!req.session) throw new AuthError("no_session", "وارد نشده‌اید");
    await requireForSession(db, req.session, "settings.view");
    const permission = await can(db, { userId: req.session.userId, viaPin: req.session.pinUnlocked, operation: "settings.security" });
    return { ...await status(), canEdit: permission.verdict === "allow" };
  });

  app.post("/settings/melipayamak-credit", async req => {
    if (!req.session) throw new AuthError("no_session", "وارد نشده‌اید");
    await requireForSession(db, req.session, "settings.security");
    const connection = await readMeliConnection(db, master);
    try { return { credit: await meliCredit(connection) }; }
    catch (error) {
      if (error instanceof SmsError) throw new SettingError("sms_credit_unavailable", error.message, 422);
      throw error;
    }
  });

  app.put("/settings/melipayamak-credential", async (req) => {
    if (!req.session) throw new AuthError("no_session", "وارد نشده‌اید");
    await requireForSession(db, req.session, "settings.security");
    const input = bodySchema.parse(req.body);
    if (input.transport === "panel" && !input.accountName)
      throw new SettingError("missing_panel_user", "نام کاربری وب‌سرویس پنل لازم است", 422);
    if (input.digestCopy) {
      try { digestContent(input.digestCopy, {"حضوری":"۱","سایت":"۲","اینستاگرام":"۳","جمع":"۶"}); }
      catch { throw new SettingError("digest_template","قالب گزارش باید حداقل یک عدد از فهرست مجاز داشته باشد",422); }
    }
    if (input.invoicePattern && input.invoiceCopy && (!input.invoiceCopy.includes("{0}") || !input.invoiceCopy.includes("{1}") || /\{(?![01]\})/.test(input.invoiceCopy)))
      throw new SettingError("invoice_pattern","برای پترن رسید فقط {0} و {1} و نشانی ثابت فروشگاه را وارد کنید",422);
    const encrypted = input.apiKey ? encryptMeliKey(input.apiKey, master) : undefined;
    await withActor(db, { userId: req.session.userId, ip: req.ip }, async (trx) => {
      const r = await sql<{ revision: number; hasKey: boolean }>`
        UPDATE platform.melipayamak_credential
        SET account_name=${input.accountName},
            encrypted_key=CASE WHEN ${Boolean(input.clearKey)} THEN NULL
              WHEN ${encrypted !== undefined} THEN ${encrypted ? JSON.stringify(encrypted) : null}::jsonb ELSE encrypted_key END,
            transport=coalesce(${input.transport ?? null}::text,transport),
            otp_pattern=CASE WHEN ${input.otpPattern !== undefined} THEN ${input.otpPattern ?? null}::int ELSE otp_pattern END,
            invoice_pattern=CASE WHEN ${input.invoicePattern !== undefined} THEN ${input.invoicePattern ?? null}::int ELSE invoice_pattern END,
            digest_enabled=coalesce(${input.digestEnabled ?? null}::boolean,digest_enabled),
            digest_pattern=CASE WHEN ${input.digestPattern !== undefined} THEN ${input.digestPattern ?? null}::int ELSE digest_pattern END,
            digest_copy=coalesce(${input.digestCopy ?? null}::text,digest_copy),
            otp_copy=coalesce(${input.otpCopy ?? null}::text,otp_copy),
            invoice_copy=coalesce(${input.invoiceCopy ?? null}::text,invoice_copy),
            revision=revision+1,updated_at=now(),updated_by=${req.session!.userId}::uuid
        WHERE singleton AND revision=${input.revision}
        RETURNING revision, encrypted_key IS NOT NULL AS "hasKey"`.execute(trx);
      if (!r.rows[0]) throw new SettingError("credential_conflict", "تنظیم اتصال هم‌زمان تغییر کرده؛ صفحه را تازه کنید", 409);
      await sql`INSERT INTO platform.audit_log(actor_id,action,entity,entity_id,"after",ip)
        VALUES(${req.session!.userId}::uuid,'credential.update','melipayamak','singleton',
          ${JSON.stringify({ revision: r.rows[0].revision, hasKey: r.rows[0].hasKey,
            keyChanged: encrypted !== undefined || Boolean(input.clearKey) })}::jsonb,${req.ip}::inet)`.execute(trx);
    });
    return { ...await status(), canEdit: true };
  });
}
