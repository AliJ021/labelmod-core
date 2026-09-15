/**
 * مدیریت پرسنل — ساخت، ویرایش، نقش، رمز، PIN.
 *
 * تا امروز تنها راه ساختن کاربر، `cli/create-user.ts` بود: یعنی مالک
 * برای افزودن یک صندوق‌دار تازه باید به سرور SSH می‌زد. آن ابزار
 * می‌ماند — اولین مدیر را باید بدون هیچ کاربری ساخت — ولی بقیه کار از
 * محصول انجام می‌شود.
 *
 * ── چهار قاعده‌ای که این فایل نگه می‌دارد ──────────────────────────
 *
 * **راز از هیچ خواندنی بیرون نمی‌رود.** `password_hash`، `pin_hash` و
 * `totp_secret` در هیچ `select` این فایل نیستند — نه اینکه بعداً حذف
 * شوند. همان الگوی `identity.device_overview` که اصلاً ستون راز را
 * ندارد.
 *
 * **رمز یک بار دیده می‌شود و تمام.** رمز ساخت اولیه را سرور می‌سازد؛
 * در تغییر رمز، مدیر می‌تواند مقدار دلخواه بدهد یا پیشنهاد سرور را
 * بخواهد. فقط هش Argon2id ذخیره می‌شود و متن خام فقط در همان پاسخ است.
 *
 * **غیرفعال‌کردن، حذف نیست.** فاکتور پارسال به `created_by` ارجاع
 * می‌دهد. `is_active = false` یعنی نمی‌تواند وارد شود؛ ردّ حسابرسی‌اش
 * سر جایش می‌ماند.
 *
 * **هیچ شرط دسترسی اینجا نیست.** مجوز کار `identity.can()` است. تنها
 * چیزی که این لایه می‌سنجد، **قفل‌شدن خودِ کاربر** است — و آن یک قاعده
 * ایمنی است، نه یک قاعده دسترسی: کسی که آخرین مدیر است نباید بتواند
 * خودش را از سیستم بیرون بیندازد.
 */
import { randomInt } from "node:crypto";
import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { Db } from "../db/client.ts";
import type { Database } from "../db/types.ts";
import { hashSecret } from "../auth/password.ts";
import { setActor } from "../lib/idempotency.ts";

export class UserError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode = 409) {
    super(message);
    this.name = "UserError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * بدون کاراکتر مبهم — همان الفبای `cli/create-user.ts`.
 *
 * این رمز روی کاغذ نوشته و دستی تایپ می‌شود؛ `O` در برابر `0` و `l`
 * در برابر `1` یعنی یک تماس با پشتیبانی.
 */
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePassword(length = 20): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export interface UserRole {
  roleCode: string;
  roleName: string;
  branchId: string | null;
  branchName: string | null;
}

export interface AppUser {
  id: string;
  username: string;
  fullName: string;
  mobile: string | null;
  isActive: boolean;
  createdAt: string;
  /** فقط «دارد یا ندارد» — خودِ مقدار هرگز. */
  hasPin: boolean;
  hasTotp: boolean;
  roles: UserRole[];
  activeSessions: number;
}

export class UserService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async list(includeInactive: boolean): Promise<AppUser[]> {
    const rows = await sql<{
      id: string;
      username: string;
      full_name: string;
      mobile: string | null;
      is_active: boolean;
      created_at: Date;
      has_pin: boolean;
      has_totp: boolean;
      active_sessions: string;
      roles: UserRole[] | null;
    }>`
      SELECT u.id, u.username, u.full_name, u.mobile, u.is_active, u.created_at,
             -- ⚠️ **بودنِ** راز، نه خودش. اگر روزی کسی این را به
             --    ستون واقعی عوض کند، هش رمز از API بیرون می‌رود.
             (u.pin_hash    IS NOT NULL) AS has_pin,
             (u.totp_secret IS NOT NULL) AS has_totp,
             (SELECT count(*) FROM identity.session s
               WHERE s.user_id = u.id AND s.expires_at > now())::text AS active_sessions,
             (SELECT jsonb_agg(jsonb_build_object(
                       'roleCode', r.role_code, 'roleName', ro.name,
                       'branchId', r.branch_id, 'branchName', b.name)
                     ORDER BY r.role_code)
                FROM identity.user_role r
                JOIN identity.role ro ON ro.code = r.role_code
                LEFT JOIN platform.branch b ON b.id = r.branch_id
               WHERE r.user_id = u.id) AS roles
        FROM identity.app_user u
       WHERE ${includeInactive ? sql`true` : sql`u.is_active`}
       ORDER BY u.is_active DESC, u.full_name
    `.execute(this.#db);

    return rows.rows.map((r) => ({
      id: r.id,
      username: r.username,
      fullName: r.full_name,
      mobile: r.mobile,
      isActive: r.is_active,
      createdAt: r.created_at.toISOString(),
      hasPin: r.has_pin,
      hasTotp: r.has_totp,
      roles: r.roles ?? [],
      activeSessions: Number(r.active_sessions),
    }));
  }

  async byId(id: string): Promise<AppUser | null> {
    const all = await this.list(true);
    return all.find((u) => u.id === id) ?? null;
  }

  /**
   * کاربر تازه — رمز را **سرور** می‌سازد.
   *
   * گرفتن رمز از فرم یعنی همان رمزی که مدیر برای همه انتخاب می‌کند،
   * و بند ۸ SECURITY.md دقیقاً همین را ممنوع کرده. متن خام یک بار
   * برمی‌گردد و هیچ‌جا نمی‌ماند.
   */
  async create(input: {
    username: string;
    fullName: string;
    mobile?: string | undefined;
    roles: Array<{ roleCode: string; branchId: string | null }>;
    actorId: string;
  }): Promise<{ id: string; password: string }> {
    if (input.roles.length === 0) {
      throw new UserError("no_role", "کاربر بدون نقش ساخته نمی‌شود", 422);
    }
    const password = generatePassword();
    const hash = await hashSecret(password);

    const id = await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, input.actorId);

      const dup = await trx
        .selectFrom("identity.app_user")
        .select("id")
        .where("username", "=", input.username)
        .executeTakeFirst();
      if (dup) {
        throw new UserError("username_taken", `نام کاربری «${input.username}» گرفته شده است`);
      }

      const u = await trx
        .insertInto("identity.app_user")
        .values({
          username: input.username,
          full_name: input.fullName,
          mobile: input.mobile ?? null,
          password_hash: hash,
          pin_hash: null,
          totp_secret: null,
          is_active: true,
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      await this.#writeRoles(trx, u.id, input.roles);

      await sql`
        SELECT platform.audit('user.create', 'app_user', ${u.id}::text,
          ${JSON.stringify({ username: input.username, roles: input.roles })}::jsonb,
          ${input.actorId}::uuid)
      `.execute(trx);

      return u.id;
    });

    return { id, password };
  }

  async update(input: {
    id: string;
    fullName?: string | undefined;
    mobile?: string | null | undefined;
    isActive?: boolean | undefined;
    actorId: string;
  }): Promise<void> {
    const before = await this.byId(input.id);
    if (!before) throw new UserError("user_not_found", "کاربر یافت نشد", 404);

    // **قفل‌شدن خودِ کاربر.** این یک قاعده ایمنی است نه دسترسی: مدیری
    // که خودش را غیرفعال کند، دیگر نمی‌تواند برش گرداند و سیستم بدون
    // مدیر می‌ماند. تنها راهش آن‌وقت CLI روی سرور بود.
    if (input.isActive === false && input.id === input.actorId) {
      throw new UserError(
        "self_deactivate",
        "حساب خودتان را نمی‌توانید غیرفعال کنید. از کاربر مدیر دیگری استفاده کنید.",
      );
    }

    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, input.actorId);
      await trx
        .updateTable("identity.app_user")
        .set({
          ...(input.fullName === undefined ? {} : { full_name: input.fullName }),
          ...(input.mobile === undefined ? {} : { mobile: input.mobile }),
          ...(input.isActive === undefined ? {} : { is_active: input.isActive }),
        })
        .where("id", "=", input.id)
        .execute();

      await sql`
        SELECT platform.audit('user.update', 'app_user', ${input.id}::text,
          ${JSON.stringify({
            fullName: input.fullName ?? null,
            isActive: input.isActive ?? null,
          })}::jsonb,
          ${input.actorId}::uuid, NULL,
          ${JSON.stringify({ fullName: before.fullName, isActive: before.isActive })}::jsonb)
      `.execute(trx);
    });

    // غیرفعال‌کردن باید **همین حالا** اثر کند، نه پس از انقضای نشست.
    // بند ۶ سند اصلی: «خروج اجباری همه نشست‌ها». بدون این، کسی که
    // اخراج شده تا ۱۲ ساعت دیگر داخل سیستم است.
    if (input.isActive === false) {
      await this.#db.deleteFrom("identity.session").where("user_id", "=", input.id).execute();
    }
  }

  /**
   * نقش‌ها — **مطلق**، نه افزایشی.
   *
   * فهرستی که می‌آید، فهرست نهایی است. افزایشی‌بودن یعنی برداشتن یک
   * نقش، مسیر جدا و فراموش‌شدنی خودش را لازم داشته باشد.
   */
  async setRoles(input: {
    id: string;
    roles: Array<{ roleCode: string; branchId: string | null }>;
    actorId: string;
  }): Promise<void> {
    const before = await this.byId(input.id);
    if (!before) throw new UserError("user_not_found", "کاربر یافت نشد", 404);
    if (input.roles.length === 0) {
      throw new UserError("no_role", "کاربر بدون نقش نمی‌ماند", 422);
    }

    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, input.actorId);
      await trx.deleteFrom("identity.user_role").where("user_id", "=", input.id).execute();
      await this.#writeRoles(trx, input.id, input.roles);
      await sql`
        SELECT platform.audit('user.roles', 'app_user', ${input.id}::text,
          ${JSON.stringify(input.roles)}::jsonb, ${input.actorId}::uuid, NULL,
          ${JSON.stringify(before.roles)}::jsonb)
      `.execute(trx);
    });

    // نقش که عوض شود، مجوزهای نشست باز هم باید عوض شوند. نشست‌ها
    // مجوز را در لحظه می‌خوانند (`identity.can`)، پس ابطال لازم
    // نیست — ولی اگر روزی Cache اضافه شد، این کامنت جای درستش است.
  }

  /** رمز تازه — انتخاب مدیر یا پیشنهاد امن سرور؛ هیچ‌جا خام ذخیره نمی‌شود. */
  async resetPassword(id: string, actorId: string, chosenPassword?: string): Promise<string> {
    const user = await this.byId(id);
    if (!user) throw new UserError("user_not_found", "کاربر یافت نشد", 404);

    const password = chosenPassword ?? generatePassword();
    const hash = await hashSecret(password);

    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, actorId);
      await trx
        .updateTable("identity.app_user")
        .set({ password_hash: hash })
        .where("id", "=", id)
        .execute();
      await sql`
        SELECT platform.audit('user.reset_password', 'app_user', ${id}::text,
          NULL, ${actorId}::uuid)
      `.execute(trx);
    });

    // رمز عوض شد، پس هر نشست بازِ قبلی باید برود. اگر دلیل تغییر
    // رمز نشت بوده، نگه‌داشتن نشست‌ها یعنی اصلاح بی‌اثر است.
    await this.#db.deleteFrom("identity.session").where("user_id", "=", id).execute();

    return password;
  }

  /**
   * PIN — تعیین یا برداشتن.
   *
   * `null` یعنی «PIN را بردار». خودِ PIN با همان Argon2id هش می‌شود؛
   * چهار رقم ۱۰٬۰۰۰ حالت دارد و هیچ الگوریتمی نجاتش نمی‌دهد — دفاع
   * واقعی در `docs/SECURITY.md` بند ۱ است: دستگاه ثبت‌شده، ورود کامل
   * پیشین، قفل پس از ۵ تلاش، و ممنوع‌بودن عملیات حساس.
   */
  async setPin(id: string, pin: string | null, actorId: string): Promise<void> {
    const user = await this.byId(id);
    if (!user) throw new UserError("user_not_found", "کاربر یافت نشد", 404);

    const hash = pin === null ? null : await hashSecret(pin);
    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, actorId);
      await trx
        .updateTable("identity.app_user")
        .set({ pin_hash: hash })
        .where("id", "=", id)
        .execute();
      await sql`
        SELECT platform.audit(${pin === null ? "user.pin_clear" : "user.pin_set"},
          'app_user', ${id}::text, NULL, ${actorId}::uuid)
      `.execute(trx);
    });
  }

  /** نقش ناموجود باید پیش از درج بشکند، نه با خطای کلید خارجی انگلیسی. */
  async #writeRoles(
    trx: Transaction<Database>,
    userId: string,
    roles: Array<{ roleCode: string; branchId: string | null }>,
  ): Promise<void> {
    for (const r of roles) {
      const role = await trx
        .selectFrom("identity.role")
        .select("code")
        .where("code", "=", r.roleCode)
        .executeTakeFirst();
      if (!role) {
        throw new UserError("role_not_found", `نقش «${r.roleCode}» وجود ندارد`, 422);
      }
    }
    await trx
      .insertInto("identity.user_role")
      .values(
        roles.map((r) => ({
          user_id: userId,
          role_code: r.roleCode,
          branch_id: r.branchId,
        })),
      )
      .execute();
  }
}
