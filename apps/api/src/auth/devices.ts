/**
 * مدیریت دستگاه و نشست — گامی که در ADR-005 بود و در محصول نبود.
 *
 * `identity.approve_device()` و `identity.revoke_device()` از مهاجرت
 * ۰۰۷ وجود داشتند، تست هم داشتند، ولی **هیچ فراخوان تولیدی**
 * نداشتند — تنها صداکننده‌هایشان فایل‌های تست بودند.
 *
 * نتیجه‌اش این بود که زنجیره ADR-005 روی کاغذ درست بود و در عمل نه:
 *
 *     ثبت‌نشده ──تأیید مدیر──→ تأییدشده ──ورود کامل──→ ثبت‌نام‌شده
 *                  ▲
 *                  └── این گام در محصول وجود نداشت
 *
 * یعنی هیچ دستگاهی هرگز تأیید نمی‌شد و **PIN صندوق‌دار هیچ‌وقت باز
 * نمی‌شد**: هر بار قفل صفحه، ورود کامل با رمز.
 *
 * ── راز دستگاه از اینجا رد نمی‌شود ──────────────────────────────────
 *
 * `identity.device.secret_hash` حتی به‌شکل هش هم به لایه API نمی‌آید.
 * نمای `identity.device_overview` فقط `enrolled` می‌دهد: هست یا نه.
 * راز فقط یک بار، در اولین ورود کامل پس از تأیید، صادر می‌شود و در
 * کوکی HttpOnly می‌نشیند — `AuthService.enrollIfDue`.
 */
import { sql } from "kysely";
import type { Db } from "../db/client.ts";
import { setActor } from "../lib/idempotency.ts";

export class DeviceError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode = 409) {
    super(message);
    this.name = "DeviceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface DeviceRow {
  id: string;
  fingerprint: string;
  label: string;
  kind: string;
  branchId: string | null;
  branchName: string | null;
  isApproved: boolean;
  approvedAt: string | null;
  approvedByName: string | null;
  /** فقط «راز دارد یا نه» — خودِ راز و هشش هرگز از اینجا رد نمی‌شوند. */
  enrolled: boolean;
  enrolledAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  activeSessions: number;
}

export interface SessionRow {
  id: string;
  userId: string;
  username: string;
  fullName: string;
  deviceId: string | null;
  deviceLabel: string | null;
  authMethod: string;
  pinUnlocked: boolean;
  ip: string | null;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
}

const iso = (v: Date | string | null): string | null =>
  v === null ? null : new Date(v).toISOString();

export class DeviceService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * فهرست دستگاه‌ها.
   *
   * تازه‌ترین «دیده‌شده» اول: دستگاهی که همین حالا سر صندوق کار
   * می‌کند، بالای فهرست است. دستگاهی که هرگز دیده نشده — یعنی فقط
   * یک بار Fingerprint فرستاده — آخر می‌آید.
   */
  async list(opts: { pending?: boolean | undefined } = {}): Promise<DeviceRow[]> {
    let q = this.#db
      .selectFrom("identity.device_overview")
      .selectAll()
      .orderBy("last_seen_at", "desc")
      .orderBy("created_at", "desc")
      .limit(500);

    if (opts.pending === true) q = q.where("is_approved", "=", false);

    const rows = await q.execute();
    return rows.map((r) => ({
      id: r.id,
      fingerprint: r.fingerprint,
      label: r.label,
      kind: r.kind,
      branchId: r.branch_id,
      branchName: r.branch_name,
      isApproved: r.is_approved,
      approvedAt: iso(r.approved_at),
      approvedByName: r.approved_by_name,
      enrolled: r.enrolled,
      enrolledAt: iso(r.enrolled_at),
      lastSeenAt: iso(r.last_seen_at),
      createdAt: iso(r.created_at) as string,
      activeSessions: Number(r.active_sessions),
    }));
  }

  /**
   * تأیید دستگاه.
   *
   * ⚠️ تأیید، ثبت‌نام قبلی را **پاک می‌کند** (`identity.approve_device`
   *    خودش `secret_hash = NULL` می‌گذارد). یعنی دستگاهی که یک بار
   *    باطل و دوباره تأیید شود، باید یک ورود کامل تازه بکند تا رازِ
   *    تازه بگیرد. رازِ قدیمی که شاید جای دیگری کپی شده باشد، دیگر
   *    کار نمی‌کند.
   */
  async approve(
    deviceId: string,
    actorId: string,
    label?: string | undefined,
    branchId?: string | undefined,
  ): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, actorId);

      // برچسب و شعبه پیش از تأیید ست می‌شوند: مدیر باید بتواند
      // «تبلت صندوق ۱» را نام‌گذاری کند، نه اینکه یک Fingerprint
      // خام را تأیید کند و بعد نداند کدام دستگاه بود.
      if (label !== undefined || branchId !== undefined) {
        await trx
          .updateTable("identity.device")
          .set({
            ...(label === undefined ? {} : { label }),
            ...(branchId === undefined ? {} : { branch_id: branchId }),
          })
          .where("id", "=", deviceId)
          .execute();
      }

      const r = await sql<{ approve_device: boolean }>`
        SELECT identity.approve_device(${deviceId}::uuid, ${actorId}::uuid)
      `.execute(trx);

      if (r.rows[0]?.approve_device !== true) {
        throw new DeviceError("device_not_found", "دستگاه یافت نشد", 404);
      }
    });
  }

  /**
   * ابطال دستگاه — «تبلت گم شد».
   *
   * سه کار با هم: اعتماد برداشته می‌شود، راز ثبت‌نام پاک می‌شود، و
   * **همه نشست‌های زنده روی آن دستگاه بسته می‌شوند**. هر سه در یک
   * تراکنش، وگرنه یک پنجره باقی می‌ماند که دستگاه دیگر مورد اعتماد
   * نیست ولی نشستش هنوز کار می‌کند.
   */
  async revoke(
    deviceId: string,
    actorId: string,
    reason: string,
  ): Promise<{ sessionsRevoked: number }> {
    return this.#db.transaction().execute(async (trx) => {
      await setActor(trx, actorId);

      const exists = await trx
        .selectFrom("identity.device")
        .select("id")
        .where("id", "=", deviceId)
        .executeTakeFirst();
      if (!exists) throw new DeviceError("device_not_found", "دستگاه یافت نشد", 404);

      const r = await sql<{ revoke_device: number }>`
        SELECT identity.revoke_device(${deviceId}::uuid, ${actorId}::uuid, ${reason})
      `.execute(trx);
      return { sessionsRevoked: Number(r.rows[0]?.revoke_device ?? 0) };
    });
  }

  /** نشست‌های زنده — برای دیدن «چه کسی الان کجا وارد است». */
  async sessions(opts: { userId?: string | undefined } = {}): Promise<SessionRow[]> {
    let q = this.#db
      .selectFrom("identity.session as s")
      .innerJoin("identity.app_user as u", "u.id", "s.user_id")
      .leftJoin("identity.device as d", "d.id", "s.device_id")
      .select([
        "s.id",
        "s.user_id",
        "u.username",
        "u.full_name",
        "s.device_id",
        "d.label as device_label",
        "s.auth_method",
        "s.pin_unlocked",
        "s.ip",
        "s.issued_at",
        "s.expires_at",
        "s.last_seen_at",
      ])
      .where("s.revoked_at", "is", null)
      .where("s.expires_at", ">", sql<Date>`now()`)
      .orderBy("s.last_seen_at", "desc")
      .limit(500);

    if (opts.userId !== undefined) q = q.where("s.user_id", "=", opts.userId);

    const rows = await q.execute();
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      fullName: r.full_name,
      deviceId: r.device_id,
      deviceLabel: r.device_label,
      authMethod: r.auth_method,
      pinUnlocked: r.pin_unlocked,
      ip: r.ip === null ? null : String(r.ip),
      createdAt: iso(r.issued_at) as string,
      expiresAt: iso(r.expires_at) as string,
      lastSeenAt: iso(r.last_seen_at),
    }));
  }

  /**
   * «گوشیِ فلانی گم شد» — همه نشست‌های یک کاربرِ دیگر.
   *
   * `/auth/revoke-all` فقط نشست‌های خودِ کاربر را می‌بندد و برای این
   * حالت بی‌فایده است: گوشی دست صاحبش نیست.
   */
  async revokeUserAccess(
    userId: string,
    actorId: string,
    reason: string,
  ): Promise<number> {
    return this.#db.transaction().execute(async (trx) => {
      await setActor(trx, actorId);
      const r = await sql<{ revoke_user_access: number }>`
        SELECT identity.revoke_user_access(${userId}::uuid, ${reason})
      `.execute(trx);
      return Number(r.rows[0]?.revoke_user_access ?? 0);
    });
  }
}
