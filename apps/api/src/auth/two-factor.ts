/**
 * عامل دوم — TOTP و کد بازیابی.
 *
 * بند ۱ `docs/SECURITY.md` این را از روز اول الزام کرده بود و ستون
 * `app_user.totp_secret` هم از روز اول بود — **خالی**. یعنی الزامی که
 * در سند نوشته شده بود، در محصول وجود نداشت.
 *
 * ── سه قاعده‌ای که این فایل نگه می‌دارد ────────────────────────────
 *
 * **راز تأییدنشده، راز نیست.** تا وقتی کاربر یک کد درست نداده،
 * `app_user.totp_secret` دست نمی‌خورد. اگر راز در همان لحظه ساخت
 * می‌نشست، کاربری که وسط ثبت‌نام رها می‌کرد دفعه بعد پشت کدی قفل
 * می‌شد که هرگز اسکن نکرده.
 *
 * **کد بازیابی یک بار.** مصرفش در همان تراکنشی است که سنجیده می‌شود،
 * با `FOR UPDATE`. بدون قفل، دو درخواست هم‌زمان هر دو همان کد را
 * خرج می‌کردند.
 *
 * **کد بازیابی با SHA-256، نه Argon2id.** استثنا نیست: یک راز
 * تصادفی ۲۰ کاراکتری است، نه رمز انسانی. حمله فرهنگ‌لغت رویش بی‌معنا
 * است — همان استدلالی که برای توکن نشست هست.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { sql } from "kysely";
import { setActor } from "../lib/idempotency.ts";
import type { Db } from "../db/client.ts";
import { newTotpSecret, otpauthUri, verifyTotp } from "./totp.ts";
import { lockEnrollment, proveEnrollment } from "./enrollment.ts";
import { AuthError } from "./service.ts";

/** بدون کاراکتر مبهم — کد بازیابی روی کاغذ نوشته می‌شود. */
const ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";

function hashCode(code: string): string {
  // نرمال‌سازی پیش از هش: کاربر کد را با خط تیره و حروف بزرگ
  // می‌نویسد، چون همان‌طور نشانش داده‌ایم.
  return createHash("sha256").update(code.replace(/[\s-]/g, "").toLowerCase()).digest("hex");
}

/** ده کد، هرکدام ۲۰ کاراکتر — با خط تیره برای خواندن روی کاغذ. */
function generateRecoveryCodes(count = 10): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let raw = "";
    for (let j = 0; j < 20; j++) raw += ALPHABET[randomInt(ALPHABET.length)];
    out.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15)}`);
  }
  return out;
}

export interface TotpStatus {
  enabled: boolean;
  /** ثبت‌نامی در جریان هست که هنوز تأیید نشده؟ */
  pending: boolean;
  recoveryCodesLeft: number;
  webauthnKeys: number;
  /** نقش این کاربر در فهرست الزام است؟ — هشدار، نه قفل. */
  shouldHave: boolean;
}

export class TwoFactorService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async status(userId: string): Promise<TotpStatus> {
    const r = await sql<{
      enabled: boolean;
      pending: boolean;
      codes_left: string;
      keys: string;
      should_have: boolean;
    }>`
      SELECT (u.totp_secret IS NOT NULL) AS enabled,
             EXISTS (SELECT 1 FROM identity.totp_enrollment e WHERE e.user_id = u.id)
               AS pending,
             (SELECT count(*) FROM identity.recovery_code c
               WHERE c.user_id = u.id AND c.used_at IS NULL)::text AS codes_left,
             (SELECT count(*) FROM identity.webauthn_credential w
               WHERE w.user_id = u.id)::text AS keys,
             identity.should_have_second_factor(u.id) AS should_have
        FROM identity.app_user u
       WHERE u.id = ${userId}::uuid
    `.execute(this.#db);

    const row = r.rows[0];
    if (!row) throw new AuthError("user_not_found", "کاربر یافت نشد");
    return {
      enabled: row.enabled,
      pending: row.pending,
      recoveryCodesLeft: Number(row.codes_left),
      webauthnKeys: Number(row.keys),
      shouldHave: row.should_have,
    };
  }

  /**
   * شروع ثبت‌نام — راز تازه و URI برای QR.
   *
   * راز در `totp_enrollment` می‌نشیند، نه در `app_user`. شروع دوباره،
   * قبلی را جایگزین می‌کند: کاربری که QR را گم کرده باید بتواند از
   * نو شروع کند.
   */
  async beginTotp(input: {
    userId: string;
    username: string;
    issuer: string;
  }): Promise<{ secret: string; uri: string }> {
    const current = await this.status(input.userId);
    if (current.enabled) {
      throw new AuthError(
        "totp_already_enabled",
        "برای این حساب کد دومرحله‌ای فعال است. اول آن را بردارید.",
      );
    }

    const secret = newTotpSecret();
    await this.#db
      .insertInto("identity.totp_enrollment")
      .values({ user_id: input.userId, secret })
      .onConflict((oc) => oc.column("user_id").doUpdateSet({ secret }))
      .execute();

    return {
      secret,
      uri: otpauthUri({ secret, account: input.username, issuer: input.issuer }),
    };
  }

  /**
   * تأیید ثبت‌نام — و همان لحظه، ده کد بازیابی.
   *
   * کدها **فقط همین یک بار** برمی‌گردند. اگر کاربر گمشان کند، تنها
   * راه ساخت فهرست تازه است — و همان درست است.
   */
  async confirmTotp(userId: string, code: string, sessionId: string): Promise<string[]> {
    return await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, userId);
      await lockEnrollment(trx, userId, sessionId);
      const enrollment = await trx
        .selectFrom("identity.totp_enrollment")
        .select("secret")
        .where("user_id", "=", userId)
        .executeTakeFirst();
      if (!enrollment) {
        throw new AuthError("no_enrollment", "ثبت‌نامی در جریان نیست. از نو شروع کنید.");
      }
      if (!verifyTotp(enrollment.secret, code)) {
        throw new AuthError(
          "bad_totp_setup",
          "کد وارد‌شده درست نیست. ساعت گوشی را هم بررسی کنید.",
        );
      }

      const codes = generateRecoveryCodes();

      await trx
        .updateTable("identity.app_user")
        .set({ totp_secret: enrollment.secret })
        .where("id", "=", userId)
        .execute();
      await trx.deleteFrom("identity.totp_enrollment").where("user_id", "=", userId).execute();
      // فهرست تازه، جای هر فهرست قبلی.
      await trx.deleteFrom("identity.recovery_code").where("user_id", "=", userId).execute();
      await trx
        .insertInto("identity.recovery_code")
        .values(codes.map((c) => ({ user_id: userId, code_hash: hashCode(c) })))
        .execute();
      await sql`
        SELECT platform.audit('auth.totp_enable', 'app_user', ${userId}::text,
          NULL, ${userId}::uuid)
      `.execute(trx);
      await proveEnrollment(trx, userId, sessionId, "totp");
      return codes;
    });
  }

  /**
   * برداشتن عامل دوم.
   *
   * کدهای بازیابی هم می‌روند: نگه‌داشتنشان یعنی راهی باز بماند که
   * کاربر فکر می‌کند بسته است.
   */
  async disableTotp(userId: string, actorId: string): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, actorId);
      await trx
        .updateTable("identity.app_user")
        .set({ totp_secret: null })
        .where("id", "=", userId)
        .execute();
      await trx.deleteFrom("identity.totp_enrollment").where("user_id", "=", userId).execute();
      await trx.deleteFrom("identity.recovery_code").where("user_id", "=", userId).execute();
      await sql`
        SELECT platform.audit('auth.totp_disable', 'app_user', ${userId}::text,
          NULL, ${actorId}::uuid)
      `.execute(trx);
    });
  }

  /** فهرست تازه کدهای بازیابی — قبلی‌ها همان لحظه بی‌اعتبار می‌شوند. */
  async regenerateRecoveryCodes(userId: string): Promise<string[]> {
    const st = await this.status(userId);
    if (!st.enabled) {
      throw new AuthError("totp_not_enabled", "کد دومرحته‌ای برای این حساب فعال نیست");
    }
    const codes = generateRecoveryCodes();
    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, userId);
      await trx.deleteFrom("identity.recovery_code").where("user_id", "=", userId).execute();
      await trx
        .insertInto("identity.recovery_code")
        .values(codes.map((c) => ({ user_id: userId, code_hash: hashCode(c) })))
        .execute();
      await sql`
        SELECT platform.audit('auth.recovery_regenerate', 'app_user', ${userId}::text,
          NULL, ${userId}::uuid)
      `.execute(trx);
    });
    return codes;
  }

  /** سنجش کد TOTP در مرحله دوم ورود. */
  async verifyTotpFor(userId: string, code: string): Promise<boolean> {
    const u = await this.#db
      .selectFrom("identity.app_user")
      .select("totp_secret")
      .where("id", "=", userId)
      .executeTakeFirst();
    if (!u?.totp_secret) return false;
    return verifyTotp(u.totp_secret, code);
  }

  /**
   * مصرف یک کد بازیابی — **یک بار**، زیر قفل.
   *
   * بدون `FOR UPDATE`، دو درخواست هم‌زمان هر دو همان کد را می‌پذیرفتند
   * و یکی‌شان یک ورود اضافه می‌گرفت.
   */
  async consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
    const hash = hashCode(code);
    return await this.#db.transaction().execute(async (trx) => {
      const row = await sql<{ id: string; code_hash: string }>`
        SELECT id, code_hash FROM identity.recovery_code
         WHERE user_id = ${userId}::uuid AND used_at IS NULL
         FOR UPDATE
      `.execute(trx);

      // مقایسه زمان‌ثابت روی **همه** کدها، بی‌آنکه حلقه زودتر تمام
      // شود: تعداد تکرار نباید به درست‌بودن کد وابسته باشد.
      const given = Buffer.from(hash, "utf8");
      let matched: string | null = null;
      for (const r of row.rows) {
        const expected = Buffer.from(r.code_hash, "utf8");
        if (expected.length === given.length && timingSafeEqual(expected, given)) {
          matched = r.id;
        }
      }
      if (matched === null) return false;

      await setActor(trx, userId);
      await sql`
        UPDATE identity.recovery_code SET used_at = now() WHERE id = ${matched}::uuid
      `.execute(trx);
      await sql`
        SELECT platform.audit('auth.recovery_used', 'app_user', ${userId}::text,
          NULL, ${userId}::uuid)
      `.execute(trx);
      return true;
    });
  }
}

/** توکن مرحله دوم — همان الگوی توکن نشست: تصادفی، و فقط هشش ذخیره. */
export function newPendingToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashPendingToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
