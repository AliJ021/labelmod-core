/**
 * WebAuthn / Passkey — عامل دومی که در برابر فیشینگ مقاوم است.
 *
 * `docs/SECURITY.md` بند ۱ این را **اولویت اول** گذاشته و دلیلش یک
 * جمله است: کلید به **دامنه** گره خورده، پس صفحه جعلی نمی‌تواند از آن
 * استفاده کند. TOTP این را ندارد — کاربری که کد شش‌رقمی را در یک
 * صفحه جعلی تایپ کند، همان لحظه لو رفته.
 *
 * ── چرا اینجا کتابخانه هست ولی برای TOTP نبود ─────────────────────
 *
 * TOTP سی خط HMAC است. WebAuthn یعنی تجزیه CBOR، کلید COSE، زنجیره
 * گواهی Attestation و شش خانواده الگوریتم امضا. نوشتن دوباره‌اش
 * «کمتر وابستگی» نیست — «رمزنگاری خانگی» است، و آن بدترین گزینه است.
 *
 * `@simplewebauthn/server` مرجع عملی این کار است و مجوزش MIT.
 *
 * ── چه چیزی اینجا سنجیده نشده، و صریح می‌گوییم ────────────────────
 *
 * ⚠️ مراسم واقعی ثبت و ورود به یک **دامنه واقعی و یک Authenticator
 *    واقعی** نیاز دارد. آنچه در این مخزن سنجیده می‌شود: چرخه چالش،
 *    یک‌بارمصرف بودنش، رد شمارنده نزولی، دامنه و مجوز. خودِ مراسم
 *    `EXTERNAL VERIFICATION REQUIRED` است و پیش از بهره‌برداری باید
 *    یک بار با کلید واقعی آزموده شود.
 *
 * ── شمارنده نزولی یعنی کلید Clone شده ────────────────────────────
 *
 * استاندارد می‌گوید شمارنده هر کلید باید صعودی بماند. نزولش یعنی همان
 * کلید جای دیگری هم هست. بعضی Authenticatorها (از جمله اکثر
 * Passkeyهای همگام‌شونده) شمارنده را همیشه صفر می‌گذارند — آن حالت
 * عادی است و رد نمی‌شود؛ فقط **کاهش واقعی** رد می‌شود.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { sql } from "kysely";
import type { Db } from "../db/client.ts";
import { lockEnrollment, proveEnrollment } from "./enrollment.ts";
import { AuthError } from "./service.ts";

export interface WebauthnConfig {
  /** دامنه — همان که کلید به آن گره می‌خورد. بدون پورت و بدون طرح. */
  rpId: string;
  /** آدرس کامل صفحه‌ای که مراسم از آن شروع می‌شود. */
  origin: string;
  rpName: string;
}

/**
 * دامنه از `platform.public_url` می‌آید — **یک تعریف، نه دو تا**.
 *
 * همان تنظیمی که لینک فاکتور پیامکی از آن ساخته می‌شود. اگر WebAuthn
 * دامنه جدا داشت، روزی یکی‌شان عوض می‌شد و آن یکی نه — و آن روز
 * کلیدها بی‌صدا از کار می‌افتادند، با پیامی که هیچ‌کس نمی‌فهمد.
 *
 * ⚠️ عمداً از هدر `Host` **خوانده نمی‌شود**: هدر را کلاینت می‌فرستد،
 *    و WebAuthn دقیقاً برای این وجود دارد که دامنه قابل جعل نباشد.
 *    همان درسی که لینک فاکتور داد.
 */
export async function webauthnConfigFrom(db: Db): Promise<WebauthnConfig> {
  const r = await sql<{ url: string | null }>`
    SELECT nullif(platform.setting_text('platform.public_url', ''), '') AS url
  `.execute(db);
  const raw = r.rows[0]?.url;
  if (!raw) {
    throw new AuthError(
      "totp_not_enabled",
      "برای کلید امنیتی، ابتدا «آدرس عمومی سامانه» را در تنظیمات پر کنید.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AuthError(
      "totp_not_enabled",
      "«آدرس عمومی سامانه» یک نشانی معتبر نیست؛ در تنظیمات درستش کنید.",
    );
  }
  return {
    // `hostname` نه `host`: پورت نباید در rpId بیاید.
    rpId: parsed.hostname,
    origin: parsed.origin,
    rpName: "Label Mod",
  };
}

/**
 * آیا شمارنده عقب رفته است؟ — قاعده استاندارد، به‌شکل یک تابع خالص.
 *
 * WebAuthn می‌گوید شمارنده هر کلید باید **صعودی** بماند. نزول یا
 * درجازدنش یعنی همان کلید جای دیگری هم هست، یا یک پاسخ قدیمی دوباره
 * فرستاده شده.
 *
 * استثنا: Authenticatorهایی که اصلاً نمی‌شمارند (اکثر Passkeyهای
 * همگام‌شونده) همیشه صفر می‌دهند. صفر پس از صفر عادی است — ولی صفر
 * پس از یک عدد مثبت نه: آن کلید **می‌شمرد** و حالا نمی‌شمارد.
 *
 * ⚠️ این سنجش عمداً اینجاست و نه در کتابخانه: کتابخانه برای همین
 *    حالت `throw` می‌کند و پیامش انگلیسی است، پس در لایه خطا ۵۰۰
 *    می‌شد — یعنی یک دفاع امنیتی که شبیه خرابی سرور گزارش می‌شود و
 *    در عمل خاموش است. به کتابخانه شمارنده صفر داده می‌شود تا سنجش
 *    شمارنده **فقط** اینجا انجام شود؛ امضا، دامنه، rpId و چالش را
 *    همچنان خودِ کتابخانه می‌سنجد.
 */
export function counterRegressed(previous: number, next: number): boolean {
  return (next > 0 || previous > 0) && next <= previous;
}

export interface StoredCredential {
  id: string;
  credentialId: string;
  name: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  deviceType: string | null;
  backedUp: boolean;
}

/** عمر چالش — کوتاه، چون تنها کارش یک رفت‌وبرگشت است. */
const CHALLENGE_SECONDS = 300;

export class WebauthnService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** پیکربندی در **لحظه هر مراسم** خوانده می‌شود، نه در راه‌اندازی. */
  async #cfg(): Promise<WebauthnConfig> {
    return await webauthnConfigFrom(this.#db);
  }

  async list(userId: string): Promise<StoredCredential[]> {
    const rows = await this.#db
      .selectFrom("identity.webauthn_credential")
      .select([
        "id",
        "credential_id",
        "name",
        "created_at",
        "last_used_at",
        "device_type",
        "backed_up",
      ])
      .where("user_id", "=", userId)
      .orderBy("created_at", "desc")
      .execute();

    return rows.map((r) => ({
      id: r.id,
      credentialId: r.credential_id,
      name: r.name,
      createdAt: r.created_at.toISOString(),
      lastUsedAt: r.last_used_at === null ? null : r.last_used_at.toISOString(),
      deviceType: r.device_type,
      backedUp: r.backed_up,
    }));
  }

  /**
   * گزینه‌های ثبت یک کلید تازه.
   *
   * کلیدهای موجود در `excludeCredentials` می‌روند تا کاربر همان کلید
   * را دو بار ثبت نکند — Authenticator خودش جلویش را می‌گیرد و پیام
   * روشنی می‌دهد.
   */
  async beginRegistration(input: {
    userId: string;
    username: string;
    fullName: string;
  }): Promise<Record<string, unknown>> {
    const cfg = await this.#cfg();
    const existing = await this.list(input.userId);

    const options = await generateRegistrationOptions({
      rpName: cfg.rpName,
      rpID: cfg.rpId,
      userID: Buffer.from(input.userId, "utf8"),
      userName: input.username,
      userDisplayName: input.fullName,
      // «کلید باید بماند» — Passkey، نه یک تأیید یک‌بارمصرف.
      attestationType: "none",
      excludeCredentials: existing.map((c) => ({ id: c.credentialId })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
    });

    await this.#storeChallenge(input.userId, options.challenge, "register");
    return options as unknown as Record<string, unknown>;
  }

  async finishRegistration(input: {
    userId: string;
    sessionId: string;
    response: Record<string, unknown>;
    name?: string | undefined;
  }): Promise<{ id: string }> {
    const cfg = await this.#cfg();
    const challenge = await this.#takeChallenge(input.userId, "register");

    // کتابخانه برای پاسخ خراب `throw` می‌کند، نه `verified: false`.
    // بدون این try، هر پاسخ ناقص یک ۵۰۰ انگلیسی می‌شد.
    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        // شکل پاسخ را خودِ کتابخانه می‌سنجد؛ اینجا فقط عبور می‌دهیم.
        response: input.response as never,
        expectedChallenge: challenge,
        expectedOrigin: cfg.origin,
        expectedRPID: cfg.rpId,
      });
    } catch {
      throw new AuthError("bad_totp_setup", "ثبت کلید تأیید نشد. دوباره تلاش کنید.");
    }

    if (!verification.verified || !verification.registrationInfo) {
      // ۴۲۲ نه ۴۰۱: کاربر **وارد شده** است و فقط مراسم ثبت شکست
      // خورده. ۴۰۱ یعنی کلاینت او را از صفحه بیرون بیندازد — همان
      // اشتباهی که یک بار برای تأیید TOTP گرفته شد.
      throw new AuthError("bad_totp_setup", "ثبت کلید تأیید نشد. دوباره تلاش کنید.");
    }

    const info = verification.registrationInfo;
    return await this.#db.transaction().execute(async (trx) => {
    await lockEnrollment(trx, input.userId, input.sessionId);
    const row = await trx
      .insertInto("identity.webauthn_credential")
      .values({
        user_id: input.userId,
        credential_id: info.credential.id,
        public_key: Buffer.from(info.credential.publicKey).toString("base64url"),
        counter: String(info.credential.counter),
        transports: info.credential.transports ?? null,
        device_type: info.credentialDeviceType,
        backed_up: info.credentialBackedUp,
        name: input.name ?? null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await sql`
      SELECT platform.audit('auth.webauthn_register', 'app_user', ${input.userId}::text,
        ${JSON.stringify({ credentialId: info.credential.id })}::jsonb,
        ${input.userId}::uuid)
    `.execute(trx);

    await proveEnrollment(trx, input.userId, input.sessionId, "webauthn");
    return { id: row.id };
    });
  }

  async beginAuthentication(userId: string): Promise<Record<string, unknown>> {
    const cfg = await this.#cfg();
    const creds = await this.list(userId);
    if (creds.length === 0) {
      throw new AuthError("totp_not_enabled", "کلیدی برای این حساب ثبت نشده است");
    }

    const options = await generateAuthenticationOptions({
      rpID: cfg.rpId,
      allowCredentials: creds.map((c) => ({ id: c.credentialId })),
      userVerification: "preferred",
    });

    await this.#storeChallenge(userId, options.challenge, "login");
    return options as unknown as Record<string, unknown>;
  }

  /**
   * سنجش پاسخ ورود — و **رد شمارنده نزولی**.
   *
   * نزول شمارنده یعنی همان کلید جای دیگری هم هست. Passkeyهای
   * همگام‌شونده شمارنده را همیشه صفر می‌گذارند و آن عادی است؛ فقط
   * کاهش واقعی رد می‌شود.
   */
  async finishAuthentication(input: {
    userId: string;
    response: Record<string, unknown>;
  }): Promise<boolean> {
    const cfg = await this.#cfg();
    const challenge = await this.#takeChallenge(input.userId, "login");
    const rawId = (input.response as { id?: string }).id;
    if (typeof rawId !== "string") return false;

    const cred = await this.#db
      .selectFrom("identity.webauthn_credential")
      .select(["id", "credential_id", "public_key", "counter", "transports"])
      .where("user_id", "=", input.userId)
      .where("credential_id", "=", rawId)
      .executeTakeFirst();
    if (!cred) return false;

    const previous = Number(cred.counter);

    // پاسخ خراب یا امضای غلط `throw` می‌کند، نه `verified: false` —
    // و آن یک شکست احراز هویت است، نه خرابی سرور.
    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response: input.response as never,
        expectedChallenge: challenge,
        expectedOrigin: cfg.origin,
        expectedRPID: cfg.rpId,
        credential: {
          id: cred.credential_id,
          publicKey: new Uint8Array(Buffer.from(cred.public_key, "base64url")),
          // عمداً صفر: سنجش شمارنده **زیر** انجام می‌شود، با
          // `counterRegressed`. اگر اینجا مقدار واقعی می‌رفت،
          // کتابخانه خودش `throw` می‌کرد و پیام انگلیسی‌اش ۵۰۰
          // می‌شد — یعنی نشانه Clone شدن کلید، شبیه خرابی سرور.
          counter: 0,
          ...(cred.transports === null ? {} : { transports: cred.transports as never }),
        },
      });
    } catch {
      return false;
    }

    if (!verification.verified) return false;

    const next = verification.authenticationInfo.newCounter;
    if (counterRegressed(previous, next)) {
      // این یک شکست احراز هویت نیست، یک **هشدار امنیتی** است.
      await sql`
        SELECT platform.audit('auth.webauthn_counter_regression', 'app_user',
          ${input.userId}::text,
          ${JSON.stringify({ credentialId: rawId, previous, next })}::jsonb,
          ${input.userId}::uuid,
          'شمارنده کلید عقب رفت — نشانه Clone شدن کلید')
      `.execute(this.#db);
      throw new AuthError(
        "bad_code",
        "این کلید نشانه کپی‌شدن دارد و پذیرفته نشد. با مدیر تماس بگیرید.",
      );
    }

    await this.#db
      .updateTable("identity.webauthn_credential")
      .set({ counter: String(next), last_used_at: sql<Date>`now()` })
      .where("id", "=", cred.id)
      .execute();

    return true;
  }

  async remove(userId: string, credentialRowId: string, actorId: string): Promise<void> {
    const r = await this.#db
      .deleteFrom("identity.webauthn_credential")
      .where("id", "=", credentialRowId)
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (!r.numDeletedRows) {
      throw new AuthError("user_not_found", "این کلید برای شما ثبت نشده است");
    }
    await sql`
      SELECT platform.audit('auth.webauthn_remove', 'app_user', ${userId}::text,
        ${JSON.stringify({ id: credentialRowId })}::jsonb, ${actorId}::uuid)
    `.execute(this.#db);
  }

  /**
   * چالش سمت سرور ذخیره می‌شود، نه در حافظه.
   *
   * حافظه یعنی با هر Restart همه مراسم‌های باز بمیرند، و در دو نمونه
   * اصلاً کار نکند. چالش قبلیِ همان نوع پاک می‌شود: هر بار شروع
   * دوباره، مراسم تازه است.
   */
  async #storeChallenge(userId: string, challenge: string, kind: "register" | "login") {
    await this.#db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom("identity.webauthn_challenge")
        .where("user_id", "=", userId)
        .where("kind", "=", kind)
        .execute();
      await sql`
        INSERT INTO identity.webauthn_challenge (user_id, challenge, kind, expires_at)
        VALUES (${userId}::uuid, ${challenge}, ${kind},
                now() + make_interval(secs => ${CHALLENGE_SECONDS}))
      `.execute(trx);
    });
  }

  /** چالش را می‌خواند و **همان‌جا** پاکش می‌کند — یک بار و تمام. */
  async #takeChallenge(userId: string, kind: "register" | "login"): Promise<string> {
    const r = await sql<{ challenge: string }>`
      DELETE FROM identity.webauthn_challenge
       WHERE user_id = ${userId}::uuid AND kind = ${kind} AND expires_at > now()
       RETURNING challenge
    `.execute(this.#db);
    const row = r.rows[0];
    if (!row) {
      throw new AuthError("pending_expired", "مهلت این مرحله تمام شده. دوباره شروع کنید.");
    }
    return row.challenge;
  }
}
