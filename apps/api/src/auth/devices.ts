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
import { sql, type Transaction } from "kysely";
import type { Db } from "../db/client.ts";
import type { Database } from "../db/types.ts";
import { setActor } from "../lib/idempotency.ts";
import { requireForSession } from "./permission.ts";
import { branchesOf, ScopeError } from "../sales/scope.ts";

type DeviceActor = { userId: string; pinUnlocked: boolean };

function deviceInScope(actorId: string, branchColumn: string) {
  return sql<boolean>`EXISTS (SELECT 1 FROM identity.user_role ar WHERE ar.user_id=${actorId}::uuid
    AND (ar.branch_id IS NULL OR ar.branch_id=${sql.ref(branchColumn)}))`;
}

/** همان قاعده مدیریت کاربر: همه نقش‌های هدف باید در دامنه عامل باشند. */
function userInScope(actorId: string, target: ReturnType<typeof sql.ref>) {
  return sql<boolean>`(EXISTS (SELECT 1 FROM identity.user_role ar
    WHERE ar.user_id=${actorId}::uuid AND ar.branch_id IS NULL)
    OR (EXISTS (SELECT 1 FROM identity.user_role tr WHERE tr.user_id=${target})
      AND NOT EXISTS (SELECT 1 FROM identity.user_role tr WHERE tr.user_id=${target}
        AND (tr.branch_id IS NULL OR NOT EXISTS (SELECT 1 FROM identity.user_role ar
          WHERE ar.user_id=${actorId}::uuid AND ar.branch_id=tr.branch_id)))))`;
}

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
  async list(actorId: string, opts: { pending?: boolean | undefined } = {}): Promise<DeviceRow[]> {
    let q = this.#db
      .selectFrom("identity.device_overview as d")
      .selectAll()
      .where(deviceInScope(actorId, "d.branch_id"))
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
    actor: DeviceActor,
    label?: string | undefined,
    branchId?: string | undefined,
  ): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      const device = await this.#lockDeviceInScope(trx, deviceId, actor);
      const destination = (branchId ?? device.branch_id)?.toLowerCase() ?? null;
      if (destination === null) {
        throw new DeviceError("device_branch_required", "برای تأیید اولیه، شعبه دستگاه را انتخاب کنید", 400);
      }
      const scope = await branchesOf(trx, actor.userId);
      if (scope !== "all" && !scope.includes(destination)) throw new ScopeError("شعبه مقصد خارج از دامنه شماست");
      const branch = await trx.selectFrom("platform.branch").select("id")
        .where("id", "=", destination).forShare().executeTakeFirst();
      if (!branch) throw new DeviceError("branch_not_found", "شعبه یافت نشد", 404);
      await setActor(trx, actor.userId);

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
        SELECT identity.approve_device(${deviceId}::uuid, ${actor.userId}::uuid)
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
    actor: DeviceActor,
    reason: string,
  ): Promise<{ sessionsRevoked: number }> {
    return this.#db.transaction().execute(async (trx) => {
      await this.#lockDeviceInScope(trx, deviceId, actor);
      await setActor(trx, actor.userId);

      const r = await sql<{ revoke_device: number }>`
        SELECT identity.revoke_device(${deviceId}::uuid, ${actor.userId}::uuid, ${reason})
      `.execute(trx);
      return { sessionsRevoked: Number(r.rows[0]?.revoke_device ?? 0) };
    });
  }

  /** نشست‌های زنده — برای دیدن «چه کسی الان کجا وارد است». */
  async sessions(actorId: string, opts: { userId?: string | undefined } = {}): Promise<SessionRow[]> {
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
      .where(userInScope(actorId, sql.ref("s.user_id")))
      .where(sql<boolean>`(s.device_id IS NULL OR ${deviceInScope(actorId, "d.branch_id")})`)
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
    actor: DeviceActor,
    reason: string,
  ): Promise<number> {
    const targetId = userId.toLowerCase();
    return this.#db.transaction().execute(async (trx) => {
      // ترتیب قفل با UserService یکسان است تا تغییر نقش هدف/عامل مسابقه نداشته باشد.
      const users = await trx.selectFrom("identity.app_user").select(["id", "is_active"])
        .where("id", "in", [targetId, actor.userId]).orderBy("id").forUpdate().execute();
      if (!users.some(u => u.id === actor.userId && u.is_active)) throw new ScopeError("کاربر عامل فعال نیست");
      await requireForSession(trx, actor, "user.manage");
      if (!users.some(u => u.id === targetId)) throw new DeviceError("user_not_found", "کاربر یافت نشد", 404);
      const permitted = await trx.selectFrom("identity.app_user as target").select("target.id")
        .where("target.id", "=", targetId).where(userInScope(actor.userId, sql.ref("target.id"))).executeTakeFirst();
      if (!permitted) throw new ScopeError("این کاربر خارج از دامنه شعبه شماست");
      await setActor(trx, actor.userId);
      const r = await sql<{ revoke_user_access: number }>`
        SELECT identity.revoke_user_access(${targetId}::uuid, ${reason})
      `.execute(trx);
      return Number(r.rows[0]?.revoke_user_access ?? 0);
    });
  }

  async #lockDeviceInScope(trx: Transaction<Database>, deviceId: string, actor: DeviceActor) {
    const user = await trx.selectFrom("identity.app_user").select("is_active")
      .where("id", "=", actor.userId).forShare().executeTakeFirst();
    if (!user?.is_active) throw new ScopeError("کاربر عامل فعال نیست");
    await requireForSession(trx, actor, "device.manage");
    const device = await trx.selectFrom("identity.device").select(["id", "branch_id"])
      .where("id", "=", deviceId).forUpdate().executeTakeFirst();
    if (!device) throw new DeviceError("device_not_found", "دستگاه یافت نشد", 404);
    const scope = await branchesOf(trx, actor.userId);
    if (scope !== "all" && (device.branch_id === null || !scope.includes(device.branch_id))) {
      throw new ScopeError("دستگاه خارج از دامنه شعبه شماست؛ تأیید اولیه با مدیر همه شعب است");
    }
    return device;
  }
}
