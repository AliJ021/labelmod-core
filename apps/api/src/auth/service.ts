/**
 * سرویس احراز هویت.
 *
 * قاعده حاکم این فایل: **هیچ تصمیم امنیتی اینجا گرفته نمی‌شود که
 * دیتابیس هم نتواند بگیرد.** قفل، مجاز بودن PIN و مجوز، همه از توابع
 * identity خوانده می‌شوند. اگر روزی کسی این لایه را دور بزند و مستقیم
 * به دیتابیس وصل شود، همان قواعد سر جایشان‌اند.
 *
 * چیزی که فقط اینجا انجام می‌شود، Argon2id است — چون pgcrypto آن را
 * ندارد و MD5/SHA خام برای رمز ممنوع است.
 */
import { sql } from "kysely";
import { setActor } from "../lib/idempotency.ts";
import { hashPendingToken, newPendingToken } from "./two-factor.ts";
import type { Db } from "../db/client.ts";
import { hashSecret, verifySecret } from "./password.ts";
import { hashToken, newToken } from "./token.ts";

export type AuthFailure =
  | "bad_credentials"
  | "locked"
  | "inactive"
  | "pin_not_allowed"
  | "no_session"
  // ── عامل دوم (مهاجرت ۰۳۷) ────────────────────────────────────────
  //
  // این‌ها عمداً از `bad_credentials` جدا هستند و مبهم‌بودن را نقض
  // نمی‌کنند: تا اینجا رمز **درست** بوده و مهاجم قبلاً می‌داند حساب
  // وجود دارد. پیام دقیق‌تر فقط به کسی می‌رسد که از مرحله اول گذشته.
  | "user_not_found"
  | "totp_already_enabled"
  | "totp_not_enabled"
  | "no_enrollment"
  | "bad_code"
  | "bad_totp_setup"
  | "pending_expired";

export class AuthError extends Error {
  readonly code: AuthFailure;

  /** پیام فارسی برای کاربر — عمداً مبهم برای شکست اعتبارسنجی. */
  constructor(code: AuthFailure, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

/**
 * پیام واحد برای هر شکست اعتبارسنجی. بند ۶ SECURITY.md: «هرگز مشخص
 * نشود کدام‌یک». اگر پیام «کاربر یافت نشد» و «رمز غلط» فرق کند، فهرست
 * نام‌های کاربری با نرخ آزاد قابل ساختن است.
 */
const VAGUE = "نام کاربری یا رمز اشتباه است";

export interface LoginInput {
  username: string;
  password: string;
  deviceFingerprint?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface DeviceState {
  id: string;
  /** ثبت شده — یعنی ردیفی دارد. هر دستگاهی که یک بار دیده شود ثبت می‌شود. */
  registered: true;
  /**
   * تأییدشده توسط مدیر. «ردیف دارد» با «تأیید شده» یکی نیست؛
   * یکی‌گرفتنشان صندوق‌دار را به مسیری می‌فرستد که همیشه شکست می‌خورد.
   */
  approved: boolean;
  /**
   * راز ثبت‌نام گرفته است. **فقط این** یعنی PIN روی این دستگاه کار
   * می‌کند — تأیید به‌تنهایی کافی نیست، چون fingerprint یک شناسه است
   * نه یک راز و هر کسی می‌تواند تکرارش کند.
   */
  enrolled: boolean;
  /**
   * راز تازه‌صادرشده. فقط در همان پاسخی که ثبت‌نام رخ می‌دهد پر است و
   * هرگز ذخیره نمی‌شود — مثل خودِ توکن نشست.
   */
  issuedSecret?: string | undefined;
}

/**
 * نشستی که از توکن حل شده — بدون خودِ توکن و بدون توکن CSRF، چون
 * هیچ‌کدام حالت نشست نیستند: توکن فقط در کوکی است و توکن CSRF فقط در
 * لحظه ورود ساخته می‌شود.
 */
export interface ResolvedSession {
  sessionId: string;
  userId: string;
  fullName: string;
  roles: string[];
  expiresAt: Date;
  device: DeviceState | null;
  /** نشست با PIN باز شده و عملیات حساس رویش بسته است. */
  pinUnlocked: boolean;
  /** نشست فقط برای راه‌اندازی عامل دوم معتبر است. */
  enrollmentOnly: boolean;
}

export interface Session extends ResolvedSession {
  token: string;
  /** توکن Double-Submit برای دفاع CSRF. در کوکی خواندنی می‌نشیند. */
  csrfToken: string;
}

/**
 * نتیجه مرحله اول ورود — نشست، یا بلیت مرحله دوم.
 *
 * هرگز هر دو، و هرگز هیچ‌کدام.
 */
export type LoginOutcome =
  | { kind: "session"; session: Session }
  | {
      kind: "second_factor";
      userId: string;
      fullName: string;
      pendingToken: string;
      expiresAt: Date;
      methods: Array<"totp" | "webauthn" | "recovery">;
    };

export class AuthService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * نتیجه مرحله اول ورود.
   *
   * **اتحاد تفکیک‌شده، نه یک `Session` با یک پرچم.** اگر نتیجه همیشه
   * `Session` بود، هر مسیری که فراموش می‌کرد پرچم را بسنجد، عامل دوم
   * را بی‌صدا دور می‌زد. با این شکل، کامپایلر مجبورت می‌کند هر دو
   * حالت را بنویسی.
   */
  async login(input: LoginInput): Promise<LoginOutcome> {
    const device = input.deviceFingerprint
      ? await this.resolveDevice(input.deviceFingerprint)
      : null;
    const deviceId = device?.id ?? null;

    const user = await this.#db
      .selectFrom("identity.app_user")
      .select(["id", "full_name", "password_hash", "is_active"])
      .where("username", "=", input.username)
      .executeTakeFirst();

    // کاربر ناموجود هم همان هزینه Argon2id را می‌پردازد تا زمان پاسخ،
    // وجود یا نبود نام کاربری را لو ندهد.
    const ok = await verifySecret(user?.password_hash ?? null, input.password);

    if (!user || !ok || !user.is_active) {
      await this.record(
        "password",
        input,
        user?.id ?? null,
        deviceId,
        false,
        !user ? "no_user" : !ok ? "bad_password" : "inactive",
      );
      throw new AuthError("bad_credentials", VAGUE);
    }

    // قفل *پس از* تطبیق رمز سنجیده می‌شود، نه پیش از آن.
    //
    // نسخه اول برعکس بود و یک اوراکل شمارش نام کاربری می‌ساخت: تلاش
    // ششم برای کاربر موجود ۴۲۹ و «قفل است» می‌گرفت و برای نام ناموجود
    // ۴۰۱ و «نام کاربری یا رمز اشتباه است» — با ۱۰ برابر اختلاف زمان،
    // چون مسیر قفل اصلاً Argon2id را اجرا نمی‌کرد. و چون قفل روی
    // «کاربر + دستگاه» است و fingerprint را خود مهاجم می‌فرستد، این
    // شمارش کاملاً بی‌صدا بود: کاربر واقعی هیچ اختلالی نمی‌دید.
    //
    // حالا هر تلاش با رمز غلط — چه کاربر باشد چه نباشد — دقیقاً یک
    // پاسخ و یک هزینه دارد. «قفل است» فقط به کسی گفته می‌شود که رمز
    // درست را دارد، و قفل همچنان ورودش را می‌بندد.
    if (await this.isLocked(user.id, deviceId, "password")) {
      await this.record("password", input, user.id, deviceId, false, "locked");
      throw new AuthError(
        "locked",
        "این حساب موقتاً قفل است. چند دقیقه دیگر دوباره تلاش کنید.",
      );
    }

    await this.record("password", input, user.id, deviceId, true, null);

    // ── عامل دوم ──────────────────────────────────────────────────
    //
    // رمز درست بود. اگر این کاربر عامل دومی راه انداخته باشد، اینجا
    // **هیچ نشستی ساخته نمی‌شود** — فقط یک بلیت کوتاه‌عمر که
    // می‌گوید «رمزش را داده است».
    //
    // ⚠️ راز ثبت‌نام دستگاه هم اینجا صادر **نمی‌شود**. بند ۱
    //    SECURITY.md می‌گوید راز فقط پس از یک ورود **کامل** صادر
    //    شود؛ ورودی که هنوز عامل دومش نیامده کامل نیست.
    const needsSecondFactor = await this.needsSecondFactor(user.id);
    if (needsSecondFactor) {
      const pending = await this.startPendingLogin(user.id, deviceId, input.ip ?? null);
      return {
        kind: "second_factor",
        userId: user.id,
        fullName: user.full_name,
        pendingToken: pending.token,
        expiresAt: pending.expiresAt,
        methods: await this.secondFactorMethods(user.id),
      };
    }

    // ثبت‌نام دستگاه: راز فقط پس از یک ورود **کامل** روی دستگاه
    // تأییدشده صادر می‌شود، و فقط یک بار.
    const enrollmentOnly = await this.shouldHaveSecondFactor(user.id);
    // نشست راه‌اندازی نباید دستگاه را ثبت کند؛ ورود تا تأیید عامل دوم
    // کامل نشده است.
    const enrolled = device && !enrollmentOnly ? await this.enrollIfDue(device, user.id) : device;

    return {
      kind: "session",
      session: await this.openSession(
        user.id, user.full_name, "password", enrolled, input, enrollmentOnly,
      ),
    };
  }

  /** آیا این کاربر عامل دومی راه انداخته؟ — از دیتابیس، نه از کد. */
  async needsSecondFactor(userId: string): Promise<boolean> {
    const r = await sql<{ needs: boolean }>`
      SELECT identity.needs_second_factor(${userId}::uuid) AS needs
    `.execute(this.#db);
    return r.rows[0]?.needs === true;
  }

  /** آیا سیاست نقش، راه‌اندازی عامل دوم را برای این کاربر اجباری کرده؟ */
  async shouldHaveSecondFactor(userId: string): Promise<boolean> {
    const r = await sql<{ required: boolean }>`
      SELECT identity.should_have_second_factor(${userId}::uuid) AS required
    `.execute(this.#db);
    return r.rows[0]?.required === true;
  }

  async secondFactorMethods(userId: string): Promise<Array<"totp" | "webauthn" | "recovery">> {
    const r = await sql<{ totp: boolean; webauthn: boolean; recovery: boolean }>`
      SELECT (u.totp_secret IS NOT NULL) AS totp,
             EXISTS (SELECT 1 FROM identity.webauthn_credential w WHERE w.user_id = u.id)
               AS webauthn,
             EXISTS (SELECT 1 FROM identity.recovery_code c
                      WHERE c.user_id = u.id AND c.used_at IS NULL) AS recovery
        FROM identity.app_user u WHERE u.id = ${userId}::uuid
    `.execute(this.#db);
    const row = r.rows[0];
    const out: Array<"totp" | "webauthn" | "recovery"> = [];
    if (row?.totp) out.push("totp");
    if (row?.webauthn) out.push("webauthn");
    if (row?.recovery) out.push("recovery");
    return out;
  }

  /**
   * بلیت مرحله دوم.
   *
   * عمرش از `auth.pending_login_seconds` می‌آید — داده، نه ثابت. تنها
   * کارش رساندن کاربر به مرحله دوم است، پس کوتاه.
   */
  private async startPendingLogin(
    userId: string,
    deviceId: string | null,
    ip: string | null,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = newPendingToken();
    const r = await sql<{ expires_at: Date }>`
      INSERT INTO identity.pending_login (token_hash, user_id, device_id, ip, expires_at)
      VALUES (${hashPendingToken(token)}, ${userId}::uuid, ${deviceId}::uuid,
              ${ip}::inet,
              now() + make_interval(secs =>
                platform.setting_num('auth.pending_login_seconds', 300)))
      RETURNING expires_at
    `.execute(this.#db);
    return { token, expiresAt: r.rows[0]!.expires_at };
  }

  /**
   * تمام‌کردن ورود پس از عامل دوم.
   *
   * بلیت **همان‌جا مصرف می‌شود** — چه ورود موفق باشد چه نه، بلیتی که
   * یک بار به مرحله دوم رسیده دیگر نباید تلاش دوم بدهد. تلاش دوباره
   * یعنی ورود از اول.
   */
  async completeSecondFactor(input: {
    pendingToken: string;
    method: "totp" | "webauthn" | "otp";
    deviceFingerprint?: string | undefined;
    ip?: string | undefined;
    userAgent?: string | undefined;
  }): Promise<Session> {
    const hash = hashPendingToken(input.pendingToken);
    const row = await this.#db
      .selectFrom("identity.pending_login as p")
      .innerJoin("identity.app_user as u", "u.id", "p.user_id")
      .select(["p.id", "p.user_id", "p.device_id", "u.full_name", "u.is_active"])
      .where("p.token_hash", "=", hash)
      .where("p.expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();

    if (!row || !row.is_active) {
      throw new AuthError("pending_expired", "مهلت این ورود تمام شده. دوباره وارد شوید.");
    }

    await this.#db.deleteFrom("identity.pending_login").where("id", "=", row.id).execute();

    const device = input.deviceFingerprint
      ? await this.resolveDevice(input.deviceFingerprint)
      : null;
    // حالا ورود **کامل** است، پس راز ثبت‌نام دستگاه می‌تواند صادر شود.
    const enrolled = device ? await this.enrollIfDue(device, row.user_id) : null;

    return this.openSession(row.user_id, row.full_name, input.method, enrolled, {
      username: "",
      password: "",
      ...(input.deviceFingerprint === undefined
        ? {}
        : { deviceFingerprint: input.deviceFingerprint }),
      ...(input.ip === undefined ? {} : { ip: input.ip }),
      ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
    });
  }

  /** کاربر پشت یک بلیت مرحله دوم — بدون مصرف‌کردنش. */
  async pendingUser(pendingToken: string): Promise<{ userId: string; username: string } | null> {
    const r = await this.#db
      .selectFrom("identity.pending_login as p")
      .innerJoin("identity.app_user as u", "u.id", "p.user_id")
      .select(["p.user_id", "u.username"])
      .where("p.token_hash", "=", hashPendingToken(pendingToken))
      .where("p.expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();
    return r === undefined ? null : { userId: r.user_id, username: r.username };
  }

  /**
   * احراز هویت کامل مجدد روی نشست موجود.
   *
   * تنها راه درآوردن نشست از حالت PIN. بند ۱ SECURITY.md: عملیات حساس
   * پس از باز شدن با PIN نیازمند احراز کامل مجدد است — و بدون این
   * تابع، آن الزام هیچ مسیری نداشت.
   */
  async reauthenticate(token: string, password: string): Promise<void> {
    const tokenHash = hashToken(token);
    const row = await this.#db
      .selectFrom("identity.session as s")
      .innerJoin("identity.app_user as u", "u.id", "s.user_id")
      .select(["s.user_id", "s.device_id", "u.password_hash", "u.is_active"])
      .where("s.token_hash", "=", tokenHash)
      .where("s.revoked_at", "is", null)
      .where("s.expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();

    if (!row) throw new AuthError("no_session", "نشستی برای احراز مجدد وجود ندارد");

    const ok = await verifySecret(row.password_hash, password);
    await this.#db
      .insertInto("identity.auth_attempt")
      .values({
        kind: "password",
        user_id: row.user_id,
        device_id: row.device_id,
        succeeded: ok,
        failure_code: ok ? null : "bad_password",
        username: null,
        ip: null,
      })
      .execute();

    if (!ok || !row.is_active) throw new AuthError("bad_credentials", VAGUE);

    // قفل *پس از* تطبیق رمز — همان قاعده مسیر ورود
    if (await this.isLocked(row.user_id, row.device_id, "password")) {
      throw new AuthError("locked", "این حساب موقتاً قفل است.");
    }

    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, row.user_id);
      await sql`SELECT identity.reauth_session(${tokenHash}, ${row.user_id}::uuid)`
        .execute(trx);
    });
  }

  /** راز ثبت‌نام دستگاه، اگر تأییدشده و هنوز ثبت‌نام‌نشده باشد. */
  private async enrollIfDue(device: DeviceState, userId: string): Promise<DeviceState> {
    if (!device.approved || device.enrolled) return device;

    const secret = newToken();
    const done = await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, userId);
      const r = await sql<{ enroll_device: boolean }>`
        SELECT identity.enroll_device(
          ${device.id}::uuid, ${hashToken(secret)}, ${userId}::uuid)
      `.execute(trx);
      return r.rows[0]?.enroll_device ?? false;
    });

    return done
      ? { ...device, enrolled: true, issuedSecret: secret }
      : { ...device, enrolled: true };
  }

  /**
   * باز کردن قفل صفحه با PIN.
   *
   * PIN نشست **جدید** نمی‌سازد. سه شرط ساختاری‌اش در
   * identity.pin_allowed سنجیده می‌شوند و شرط چهارم — «PIN هرگز عملیات
   * حساس را مجاز نمی‌کند» — در identity.can اعمال می‌شود.
   */
  async unlockWithPin(
    token: string,
    pin: string,
    deviceFingerprint: string,
    deviceSecret: string | undefined,
  ): Promise<void> {
    const tokenHash = hashToken(token);
    const row = await this.#db
      .selectFrom("identity.session as s")
      .innerJoin("identity.app_user as u", "u.id", "s.user_id")
      .select(["s.id as session_id", "s.user_id", "s.device_id", "u.pin_hash"])
      .where("s.token_hash", "=", tokenHash)
      .where("s.revoked_at", "is", null)
      .where("s.expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();

    if (!row) throw new AuthError("no_session", "نشستی برای باز کردن وجود ندارد");

    const { id: deviceId } = await this.resolveDevice(deviceFingerprint);
    if (deviceId !== row.device_id) {
      throw new AuthError("pin_not_allowed", "این نشست متعلق به دستگاه دیگری است");
    }

    // راز ثبت‌نام دستگاه. بدون آن، هویت دستگاه فقط یک رشته‌ی
    // fingerprint بود که هر کسی می‌توانست تکرارش کند — و «PIN فقط روی
    // دستگاه تأییدشده» به «PIN برای هر کسی که رشته را می‌داند» تنزل
    // می‌کرد.
    if (!deviceSecret) {
      throw new AuthError(
        "pin_not_allowed",
        "این دستگاه برای ورود با PIN ثبت‌نام نشده است. یک بار با رمز کامل وارد شوید.",
      );
    }

    if (await this.isLocked(row.user_id, deviceId, "pin")) {
      throw new AuthError("locked", "ورود با PIN موقتاً قفل است.");
    }

    const ok = await verifySecret(row.pin_hash, pin);
    if (!ok) {
      await this.#db
        .insertInto("identity.auth_attempt")
        .values({
          kind: "pin",
          user_id: row.user_id,
          device_id: deviceId,
          succeeded: false,
          failure_code: "bad_pin",
          username: null,
          ip: null,
        })
        .execute();
      throw new AuthError("bad_credentials", "PIN اشتباه است");
    }

    // نگهبان unlock_session با RAISE EXCEPTION رد می‌کند (SQLSTATE
    // P0001). آن خطا اینجا به AuthError ترجمه می‌شود تا مسیر PIN یک
    // ۴۰۳ روشن بدهد، نه یک ۵۰۰ که شبیه خرابی سرور است.
    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, row.user_id);
      const unlocked = await sql<{ unlock_session: boolean }>`
        SELECT identity.unlock_session(
          ${tokenHash}, ${row.user_id}::uuid, ${hashToken(deviceSecret)})
      `.execute(trx).catch((e: { code?: string; message?: string }) => {
        if (e.code === "P0001") {
          throw new AuthError("pin_not_allowed", e.message ?? "باز کردن قفل مجاز نیست");
        }
        throw e;
      });
      if (!unlocked.rows[0]?.unlock_session) {
        throw new AuthError("pin_not_allowed", "باز کردن قفل ممکن نشد");
      }
      await trx
        .insertInto("identity.auth_attempt")
        .values({
          kind: "pin",
          user_id: row.user_id,
          device_id: deviceId,
          succeeded: true,
          username: null,
          ip: null,
          failure_code: null,
        })
        .execute();
    });
  }

  /** نشست معتبر از توکن. نشست منقضی، باطل یا قفل هیچ‌چیز برنمی‌گرداند. */
  async resolve(token: string): Promise<ResolvedSession | null> {
    const result = await sql<{
      session_id: string;
      auth_method: string;
      user_id: string;
      device_id: string | null;
      expires_at: Date;
      pin_unlocked: boolean;
    }>`SELECT * FROM identity.session_from_token(${hashToken(token)})`.execute(this.#db);

    const row = result.rows[0];
    if (!row) return null;

    const user = await this.#db
      .selectFrom("identity.app_user")
      .select(["full_name", "is_active"])
      .where("id", "=", row.user_id)
      .executeTakeFirst();
    if (!user?.is_active) return null;
    // داشتن عامل دوم در حساب، اثبات احراز آن در این نشست نیست.
    const needsSecondFactor = await this.needsSecondFactor(row.user_id);
    if (row.auth_method === "password" && needsSecondFactor) return null;

    return {
      sessionId: row.session_id,
      userId: row.user_id,
      fullName: user.full_name,
      roles: await this.rolesOf(row.user_id),
      expiresAt: row.expires_at,
      device: row.device_id ? await this.deviceState(row.device_id) : null,
      pinUnlocked: row.pin_unlocked,
      enrollmentOnly:
        (await this.shouldHaveSecondFactor(row.user_id)) &&
        !needsSecondFactor,
    };
  }

  async lock(token: string): Promise<boolean> {
    const r = await sql<{ lock_session: boolean }>`
      SELECT identity.lock_session(${hashToken(token)})
    `.execute(this.#db);
    return r.rows[0]?.lock_session ?? false;
  }

  async logout(token: string): Promise<boolean> {
    const r = await sql<{ revoke_session: boolean }>`
      SELECT identity.revoke_session(${hashToken(token)}, 'logout')
    `.execute(this.#db);
    return r.rows[0]?.revoke_session ?? false;
  }

  /** «گوشی‌ام گم شد» — یک UPDATE، همه نشست‌ها. */
  async revokeAll(userId: string, reason: string, actorId: string): Promise<number> {
    const r = await sql<{ revoke_all_sessions: number }>`
      SELECT identity.revoke_all_sessions(${userId}::uuid, ${reason}, ${actorId}::uuid)
    `.execute(this.#db);
    return r.rows[0]?.revoke_all_sessions ?? 0;
  }

  /** تغییر رمز خود کاربر؛ تأیید رمز فعلی و ابطال نشست‌ها اتمیک‌اند. */
  async changePassword(token: string, currentPassword: string, plain: string): Promise<void> {
    const min = await this.settingNumber("auth.min_password_length", 12);
    if (plain.length < min || plain.length > 256 || plain === currentPassword) {
      throw new AuthError("bad_credentials", `رمز تازه باید متفاوت و بین ${min} تا ۲۵۶ کاراکتر باشد`);
    }
    const session = await this.resolve(token);
    if (!session) throw new AuthError("no_session", "نشستی وجود ندارد");
    // شمارش تلاش ناموفق و قفل حساب، همان مسیر احراز مجدد است.
    await this.reauthenticate(token, currentPassword);
    const hash = await hashSecret(plain);
    await this.#db.transaction().execute(async (trx) => {
      const user = await trx.selectFrom("identity.app_user")
        .select(["password_hash", "is_active"]).where("id", "=", session.userId)
        .forUpdate().executeTakeFirst();
      const live = await trx.selectFrom("identity.session").select("id")
        .where("token_hash", "=", hashToken(token)).where("user_id", "=", session.userId)
        .where("revoked_at", "is", null).where("locked_at", "is", null)
        .where("expires_at", ">", sql<Date>`clock_timestamp()`)
        .forUpdate().executeTakeFirst();
      if (!live || !user?.is_active) throw new AuthError("no_session", "نشست پایان یافته است");
      // بازنشانی هم‌زمان مدیر نباید با رمز قدیمی بازنویسی شود.
      if (!await verifySecret(user.password_hash, currentPassword)) {
        throw new AuthError("bad_credentials", VAGUE);
      }
      await setActor(trx, session.userId);
      await trx.updateTable("identity.app_user").set({ password_hash: hash })
        .where("id", "=", session.userId).execute();
      await sql`SELECT identity.revoke_all_sessions(${session.userId}::uuid, 'password_changed', ${session.userId}::uuid)`.execute(trx);
      await sql`SELECT platform.audit('user.change_password', 'app_user', ${session.userId}::text, NULL, ${session.userId}::uuid)`.execute(trx);
    });
  }

  /** رمز تازه — پس از تغییر، همه نشست‌های قبلی می‌میرند. */
  async setPassword(userId: string, plain: string, actorId: string): Promise<void> {
    const min = await this.settingNumber("auth.min_password_length", 12);
    if (plain.length < min) {
      throw new AuthError("bad_credentials", `رمز باید حداقل ${min} کاراکتر باشد`);
    }
    const hash = await hashSecret(plain);
    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, actorId);
      await trx
        .updateTable("identity.app_user")
        .set({ password_hash: hash })
        .where("id", "=", userId)
        .execute();
      await sql`SELECT identity.revoke_all_sessions(${userId}::uuid, 'password_changed', ${actorId}::uuid)`
        .execute(trx);
    });
  }

  async setPin(userId: string, pin: string, actorId: string): Promise<void> {
    const len = await this.settingNumber("auth.pin_length", 4);
    if (!new RegExp(`^\\d{${len}}$`).test(pin)) {
      throw new AuthError("bad_credentials", `PIN باید دقیقاً ${len} رقم باشد`);
    }
    const hash = await hashSecret(pin);
    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, actorId);
      await trx
        .updateTable("identity.app_user")
        .set({ pin_hash: hash })
        .where("id", "=", userId)
        .execute();
    });
  }

  // ------------------------------------------------------------------

  private async openSession(
    userId: string,
    fullName: string,
    method: "password" | "totp" | "webauthn" | "otp",
    device: DeviceState | null,
    input: LoginInput,
    enrollmentOnly = false,
  ): Promise<Session> {
    const deviceId = device?.id ?? null;
    const token = newToken();
    const tokenHash = hashToken(token);

    const { sessionId, expiresAt } = await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, userId, input.ip, input.deviceFingerprint);

      const r = await sql<{ open_session: string }>`
        SELECT identity.open_session(
          ${userId}::uuid, ${tokenHash}, ${method}, ${deviceId}::uuid,
          ${input.ip ?? null}::inet, ${input.userAgent ?? null}::text)
      `.execute(trx);
      const id = r.rows[0]?.open_session;
      if (!id) throw new AuthError("inactive", "ساخت نشست ممکن نشد");

      const s = await trx
        .selectFrom("identity.session")
        .select("expires_at")
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      return { sessionId: id, expiresAt: s.expires_at };
    });

    return {
      token,
      csrfToken: newToken(),
      sessionId,
      userId,
      fullName,
      roles: await this.rolesOf(userId),
      expiresAt,
      device,
      // نشست تازه با رمز ساخته شده، پس ارتقایافته است
      pinUnlocked: false,
      enrollmentOnly,
    };
  }

  private async deviceState(deviceId: string): Promise<DeviceState | null> {
    const d = await this.#db
      .selectFrom("identity.device")
      .select(["id", "is_approved", "secret_hash"])
      .where("id", "=", deviceId)
      .executeTakeFirst();
    return d
      ? {
          id: d.id,
          registered: true,
          approved: d.is_approved,
          enrolled: d.secret_hash !== null,
        }
      : null;
  }

  private async resolveDevice(fingerprint: string): Promise<DeviceState> {
    const existing = await this.#db
      .selectFrom("identity.device")
      .select(["id", "is_approved", "secret_hash"])
      .where("fingerprint", "=", fingerprint)
      .executeTakeFirst();
    if (existing) {
      await this.#db
        .updateTable("identity.device")
        .set({ last_seen_at: sql<Date>`now()` })
        .where("id", "=", existing.id)
        .execute();
      return {
        id: existing.id,
        registered: true,
        approved: existing.is_approved,
        enrolled: existing.secret_hash !== null,
      };
    }

    // دستگاه ناشناس ثبت می‌شود ولی **تأیید نمی‌شود**. ورود کامل رویش
    // کار می‌کند؛ PIN تا تأیید مدیر و ثبت‌نام نه.
    const created = await this.#db
      .insertInto("identity.device")
      .values({
        fingerprint,
        label: `دستگاه ثبت‌نشده ${fingerprint.slice(0, 8)}`,
        kind: "other",
        is_approved: false,
        branch_id: null,
        approved_by: null,
        approved_at: null,
        last_seen_at: sql<Date>`now()`,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { id: created.id, registered: true, approved: false, enrolled: false };
  }

  private async isLocked(
    userId: string,
    deviceId: string | null,
    kind: "password" | "pin",
  ): Promise<boolean> {
    const r = await sql<{ is_locked: boolean }>`
      SELECT identity.is_locked(${userId}::uuid, ${deviceId}::uuid, ${kind})
    `.execute(this.#db);
    return r.rows[0]?.is_locked ?? false;
  }

  private async record(
    kind: "password" | "pin",
    input: LoginInput,
    userId: string | null,
    deviceId: string | null,
    succeeded: boolean,
    failureCode: string | null,
  ): Promise<void> {
    await this.#db
      .insertInto("identity.auth_attempt")
      .values({
        kind,
        username: input.username,
        user_id: userId,
        device_id: deviceId,
        ip: input.ip ?? null,
        succeeded,
        failure_code: failureCode,
      })
      .execute();
  }

  private async rolesOf(userId: string): Promise<string[]> {
    const rows = await this.#db
      .selectFrom("identity.user_role")
      .select("role_code")
      .where("user_id", "=", userId)
      .execute();
    return rows.map((r) => r.role_code);
  }

  private async settingNumber(key: string, fallback: number): Promise<number> {
    const row = await this.#db
      .selectFrom("platform.setting")
      .select("value")
      .where("key", "=", key)
      .executeTakeFirst();
    const n = Number(row?.value);
    return Number.isFinite(n) ? n : fallback;
  }
}
