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
import type { Db } from "../db/client.ts";
import { hashSecret, verifySecret } from "./password.ts";
import { hashToken, newToken } from "./token.ts";

export type AuthFailure =
  | "bad_credentials"
  | "locked"
  | "inactive"
  | "pin_not_allowed"
  | "no_session";

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
   * تأییدشده توسط مدیر. **فقط این** یعنی PIN روی این دستگاه کار می‌کند.
   * «ردیف دارد» با «تأیید شده» یکی نیست؛ یکی‌گرفتنشان صندوق‌دار را به
   * مسیری می‌فرستد که همیشه شکست می‌خورد.
   */
  approved: boolean;
}

export interface Session {
  token: string;
  sessionId: string;
  userId: string;
  fullName: string;
  roles: string[];
  expiresAt: Date;
  device: DeviceState | null;
}

export class AuthService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async login(input: LoginInput): Promise<Session> {
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
    return this.openSession(user.id, user.full_name, "password", device, input);
  }

  /**
   * باز کردن قفل صفحه با PIN.
   *
   * PIN نشست **جدید** نمی‌سازد. سه شرط ساختاری‌اش در
   * identity.pin_allowed سنجیده می‌شوند و شرط چهارم — «PIN هرگز عملیات
   * حساس را مجاز نمی‌کند» — در identity.can اعمال می‌شود.
   */
  async unlockWithPin(token: string, pin: string, deviceFingerprint: string): Promise<void> {
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

    await this.#db.transaction().execute(async (trx) => {
      await sql`SELECT platform.set_actor(${row.user_id}::uuid)`.execute(trx);
      const unlocked = await sql<{ unlock_session: boolean }>`
        SELECT identity.unlock_session(${tokenHash}, ${row.user_id}::uuid)
      `.execute(trx);
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
  async resolve(token: string): Promise<Omit<Session, "token"> | null> {
    const result = await sql<{
      session_id: string;
      user_id: string;
      device_id: string | null;
      expires_at: Date;
    }>`SELECT * FROM identity.session_from_token(${hashToken(token)})`.execute(this.#db);

    const row = result.rows[0];
    if (!row) return null;

    const user = await this.#db
      .selectFrom("identity.app_user")
      .select(["full_name", "is_active"])
      .where("id", "=", row.user_id)
      .executeTakeFirst();
    if (!user?.is_active) return null;

    return {
      sessionId: row.session_id,
      userId: row.user_id,
      fullName: user.full_name,
      roles: await this.rolesOf(row.user_id),
      expiresAt: row.expires_at,
      device: row.device_id ? await this.deviceState(row.device_id) : null,
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

  /** رمز تازه — پس از تغییر، همه نشست‌های قبلی می‌میرند. */
  async setPassword(userId: string, plain: string, actorId: string): Promise<void> {
    const min = await this.settingNumber("auth.min_password_length", 12);
    if (plain.length < min) {
      throw new AuthError("bad_credentials", `رمز باید حداقل ${min} کاراکتر باشد`);
    }
    const hash = await hashSecret(plain);
    await this.#db.transaction().execute(async (trx) => {
      await sql`SELECT platform.set_actor(${actorId}::uuid)`.execute(trx);
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
      await sql`SELECT platform.set_actor(${actorId}::uuid)`.execute(trx);
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
  ): Promise<Session> {
    const deviceId = device?.id ?? null;
    const token = newToken();
    const tokenHash = hashToken(token);

    const { sessionId, expiresAt } = await this.#db.transaction().execute(async (trx) => {
      await sql`SELECT platform.set_actor(${userId}::uuid, ${input.ip ?? null}::inet, ${
        input.deviceFingerprint ?? null
      }::text)`.execute(trx);

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
      sessionId,
      userId,
      fullName,
      roles: await this.rolesOf(userId),
      expiresAt,
      device,
    };
  }

  private async deviceState(deviceId: string): Promise<DeviceState | null> {
    const d = await this.#db
      .selectFrom("identity.device")
      .select(["id", "is_approved"])
      .where("id", "=", deviceId)
      .executeTakeFirst();
    return d ? { id: d.id, registered: true, approved: d.is_approved } : null;
  }

  private async resolveDevice(fingerprint: string): Promise<DeviceState> {
    const existing = await this.#db
      .selectFrom("identity.device")
      .select(["id", "is_approved"])
      .where("fingerprint", "=", fingerprint)
      .executeTakeFirst();
    if (existing) {
      await this.#db
        .updateTable("identity.device")
        .set({ last_seen_at: sql<Date>`now()` })
        .where("id", "=", existing.id)
        .execute();
      return { id: existing.id, registered: true, approved: existing.is_approved };
    }

    // دستگاه ناشناس ثبت می‌شود ولی **تأیید نمی‌شود**. ورود کامل رویش
    // کار می‌کند؛ PIN تا تأیید مدیر نه.
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
    // ثبت شد، ولی تأیید نشد. ورود کامل رویش کار می‌کند؛ PIN تا تأیید
    // مدیر نه.
    return { id: created.id, registered: true, approved: false };
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
