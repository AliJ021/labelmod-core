import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { Db } from "../db/client.ts";
import type { Database } from "../db/types.ts";
import { AuthError } from "./service.ts";
import { lockEnrollment, proveEnrollment } from "./enrollment.ts";
import { verifySecret } from "./password.ts";
import { setActor } from "../lib/idempotency.ts";
import { readNotifySettings } from "../worker/settings.ts";
import { readMeliKey } from "../platform/melipayamak-credential.ts";
import { toLocalMobile, SmsError, type SmsSender } from "../worker/sms.ts";
import type { Config } from "../lib/config.ts";

type Ex = Db | Transaction<Database>;
type Envelope = { nonce: string; tag: string; ciphertext: string };
const AAD = Buffer.from("labelmod.sms-mfa.v1");
const binding = (value: string) => createHash("sha256").update(value).digest("hex");
function key(master: string | undefined): Buffer {
  if (!master || !/^[a-fA-F0-9]{64}$/.test(master)) throw new AuthError("sms_unavailable", "کلید امن پیامک روی API و Worker تنظیم نشده است.");
  return createHmac("sha256", Buffer.from(master, "hex")).update(AAD).digest();
}
function digest(code: string, master: string | undefined, scope: string): string {
  return createHmac("sha256", key(master)).update(scope + ":" + code).digest("hex");
}
function encrypt(code: string, master: string | undefined): Envelope {
  const nonce = randomBytes(12), c = createCipheriv("aes-256-gcm", key(master), nonce); c.setAAD(AAD);
  const ciphertext = Buffer.concat([c.update(code, "utf8"), c.final()]);
  return { nonce: nonce.toString("hex"), tag: c.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("hex") };
}

async function lockSmsEnrollment(trx: Transaction<Database>, userId: string, sessionId: string, password?: string) {
  await lockEnrollment(trx, userId, sessionId);
  const r = await sql<{ password_hash: string }>`SELECT u.password_hash FROM identity.app_user u
    JOIN identity.session s ON s.user_id=u.id WHERE u.id=${userId}::uuid AND s.id=${sessionId}::uuid
      AND u.is_active AND s.locked_at IS NULL AND NOT s.pin_unlocked
      AND s.expires_at>clock_timestamp() AND s.revoked_at IS NULL`.execute(trx);
  if (!r.rows[0]) throw new AuthError("no_session","نشست پایان یافته است؛ دوباره وارد شوید.");
  if (password !== undefined && !await verifySecret(r.rows[0].password_hash,password)) {
    throw new AuthError("bad_credentials","رمز فعلی معتبر نیست.");
  }
}

export class SmsFactorService {
  private readonly db: Db;
  private readonly config: Config;
  constructor(db: Db, config: Config) { this.db = db; this.config = config; }

  async status(userId: string) {
    const r = await sql<{ mobile: string }>`SELECT mobile FROM identity.sms_factor WHERE user_id=${userId}::uuid`.execute(this.db);
    const mobile = r.rows[0]?.mobile;
    return { enabled: !!mobile, maskedMobile: mobile ? mobile.slice(0, 4) + "••••" + mobile.slice(-3) : null };
  }

  async request(input: { userId: string; purpose: "enroll" | "login"; binding: string; mobile?: string; ip: string; sessionId?: string; currentPassword?: string }) {
    // حالت log برای OTP هیچ‌گاه معتبر نیست؛ کد نه در لاگ است نه در outbox.
    const settings = await readNotifySettings(this.db);
    key(this.config.SMS_CREDENTIAL_KEY);
    const apiKey = settings.provider === "melipayamak" ? await readMeliKey(this.db, this.config.SMS_CREDENTIAL_KEY) : this.config.SMS_API_KEY;
    if (!settings.smsEnabled || !["melipayamak", "smsir", "kavenegar"].includes(settings.provider) || !apiKey || !settings.sender) {
      throw new AuthError("sms_unavailable", "ارسال پیامک واقعی هنوز در تنظیمات آماده نیست؛ از روش دیگر ورود استفاده کنید.");
    }
    return this.db.transaction().execute(async (trx) => {
      const user = await trx.selectFrom("identity.app_user").select(["id", "is_active"]).where("id", "=", input.userId).forUpdate().executeTakeFirst();
      if (!user?.is_active) throw new AuthError("no_session", "ورود معتبر نیست.");
      if (input.purpose === "enroll") {
        if (!input.sessionId) throw new AuthError("no_session", "دوباره وارد شوید.");
        if (!input.currentPassword) throw new AuthError("bad_credentials","رمز فعلی لازم است.");
        await lockSmsEnrollment(trx, input.userId, input.sessionId, input.currentPassword);
      }
      const factor = await sql<{ mobile: string }>`SELECT mobile FROM identity.sms_factor WHERE user_id=${input.userId}::uuid`.execute(trx);
      const mobile = input.purpose === "enroll" ? toLocalMobile(input.mobile ?? "") : factor.rows[0]?.mobile;
      if (!mobile || !/^09\d{9}$/.test(mobile)) throw new AuthError("bad_totp_setup", "شماره موبایل معتبر لازم است.");
      // قفل‌های مشترک سهمیه از دورزدن با درخواست هم‌زمان یا چند حساب جلوگیری می‌کنند.
      for (const value of [`mobile:${mobile}`, `ip:${input.ip}`].sort()) {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${"sms-mfa:" + value},0))`.execute(trx);
      }
      const counts = await sql<{ limited: boolean }>`SELECT
        (count(*) FILTER (WHERE mobile=${mobile}) >= 3 OR count(*) FILTER (WHERE ip=${input.ip}::inet) >= 3
          OR count(*) FILTER (WHERE user_id=${input.userId}::uuid) >= 3) AS limited
        FROM identity.sms_challenge WHERE created_at>now()-interval '15 minutes'
          AND (mobile=${mobile} OR ip=${input.ip}::inet OR user_id=${input.userId}::uuid)`.execute(trx);
      if (counts.rows[0]?.limited) throw new AuthError("locked", "حداکثر سه پیامک در پانزده دقیقه؛ کمی بعد تلاش کنید.");
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const bh = binding(input.binding);
      await sql`UPDATE identity.sms_challenge SET used_at=now(), encrypted_code=NULL
        WHERE user_id=${input.userId}::uuid AND purpose=${input.purpose} AND used_at IS NULL`.execute(trx);
      const challenge = await sql<{ id: string }>`INSERT INTO identity.sms_challenge(user_id,purpose,binding_hash,mobile,ip,code_hash,encrypted_code)
        VALUES (${input.userId}::uuid,${input.purpose},${bh},${mobile},${input.ip}::inet,
          ${digest(code,this.config.SMS_CREDENTIAL_KEY,bh)},${JSON.stringify(encrypt(code,this.config.SMS_CREDENTIAL_KEY))}::jsonb) RETURNING id`.execute(trx);
      await sql`INSERT INTO platform.outbox_message(topic,payload)
        VALUES ('auth.sms_otp', jsonb_build_object('challengeId',${challenge.rows[0]!.id}::text))`.execute(trx);
      return { queued: true, expiresIn: 120, maskedMobile: mobile.slice(0,4) + "••••" + mobile.slice(-3) };
    });
  }

  private async consume(trx: Ex, userId: string, purpose: string, bind: string, code: string): Promise<string | null> {
    const bh = binding(bind);
    const r = await sql<{ id: string; mobile: string; code_hash: string }>`SELECT id,mobile,code_hash FROM identity.sms_challenge
      WHERE user_id=${userId}::uuid AND purpose=${purpose} AND binding_hash=${bh} AND used_at IS NULL
        AND expires_at>clock_timestamp() AND attempts<3 AND sent_at IS NOT NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE`.execute(trx);
    const row = r.rows[0]; if (!row) return null;
    const expected = Buffer.from(row.code_hash,"hex"), given = Buffer.from(digest(code,this.config.SMS_CREDENTIAL_KEY,bh),"hex");
    const ok = /^\d{6}$/.test(code) && timingSafeEqual(expected,given);
    await sql`UPDATE identity.sms_challenge SET attempts=attempts+1,
      used_at=CASE WHEN ${ok} OR attempts>=2 THEN now() ELSE used_at END,
      encrypted_code=CASE WHEN ${ok} OR attempts>=2 THEN NULL ELSE encrypted_code END WHERE id=${row.id}::uuid`.execute(trx);
    return ok ? row.mobile : null;
  }

  async confirmEnrollment(userId: string, sessionId: string, code: string): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      await lockSmsEnrollment(trx,userId,sessionId);
      const mobile = await this.consume(trx,userId,"enroll",sessionId,code);
      if (!mobile) return false; // تلاش ناموفق هم باید Commit شود.
      await setActor(trx,userId);
      await sql`INSERT INTO identity.sms_factor(user_id,mobile) VALUES (${userId}::uuid,${mobile})
        ON CONFLICT(user_id) DO UPDATE SET mobile=excluded.mobile,verified_at=now()`.execute(trx);
      await sql`DELETE FROM identity.pending_login WHERE user_id=${userId}::uuid`.execute(trx);
      await sql`UPDATE identity.sms_challenge SET used_at=now(),encrypted_code=NULL WHERE user_id=${userId}::uuid AND used_at IS NULL`.execute(trx);
      await proveEnrollment(trx,userId,sessionId,"otp");
      await sql`SELECT platform.audit('auth.sms_enable','app_user',${userId}::text,NULL,${userId}::uuid)`.execute(trx);
      return true;
    });
  }

  async verifyLogin(userId: string, pendingToken: string, code: string): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx.selectFrom("identity.app_user").select("is_active").where("id","=",userId).forUpdate().executeTakeFirst();
      if (!row?.is_active) return false;
      const mobile = await this.consume(trx,userId,"login",pendingToken,code);
      if (!mobile) return false;
      const factor = await sql`SELECT 1 FROM identity.sms_factor WHERE user_id=${userId}::uuid AND mobile=${mobile}`.execute(trx);
      return factor.rows.length === 1;
    });
  }

  async disable(userId: string, sessionId: string, password: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await lockSmsEnrollment(trx,userId,sessionId,password); await setActor(trx,userId);
      await sql`DELETE FROM identity.sms_factor WHERE user_id=${userId}::uuid`.execute(trx);
      await sql`DELETE FROM identity.pending_login WHERE user_id=${userId}::uuid`.execute(trx);
      await sql`UPDATE identity.sms_challenge SET used_at=now(),encrypted_code=NULL WHERE user_id=${userId}::uuid AND used_at IS NULL`.execute(trx);
      await sql`SELECT platform.audit('auth.sms_disable','app_user',${userId}::text,NULL,${userId}::uuid)`.execute(trx);
    });
  }
}

/** Worker فقط شناسه را از outbox می‌گیرد؛ کد رمز‌شده پس از ارسال پاک می‌شود. */
export async function deliverSmsChallenge(db: Db, id: string, sender: SmsSender, master: string | undefined): Promise<void> {
  await sql`UPDATE identity.sms_challenge SET encrypted_code=NULL
    WHERE encrypted_code IS NOT NULL AND (expires_at<=clock_timestamp() OR used_at IS NOT NULL)`.execute(db);
  const r = await sql<{ mobile: string; encrypted_code: Envelope }>`SELECT c.mobile,c.encrypted_code FROM identity.sms_challenge c
    JOIN identity.app_user u ON u.id=c.user_id WHERE c.id=${id}::uuid AND c.used_at IS NULL
      AND c.expires_at>clock_timestamp() AND c.attempts<3 AND c.encrypted_code IS NOT NULL AND u.is_active`.execute(db);
  const row = r.rows[0]; if (!row) return;
  try {
    const e = row.encrypted_code, d = createDecipheriv("aes-256-gcm",key(master),Buffer.from(e.nonce,"hex"));
    d.setAAD(AAD); d.setAuthTag(Buffer.from(e.tag,"hex"));
    const code = Buffer.concat([d.update(Buffer.from(e.ciphertext,"hex")),d.final()]).toString("utf8");
    await sender.send(row.mobile,`کد ورود لیبل مد: ${code}\nاعتبار: دو دقیقه. کد را در اختیار دیگران نگذارید.`);
  } catch { throw new SmsError("ارسال کد ورود انجام نشد؛ تنظیمات و سرویس پیامک بررسی شود."); }
  await sql`UPDATE identity.sms_challenge SET sent_at=now(),encrypted_code=NULL WHERE id=${id}::uuid`.execute(db);
}
