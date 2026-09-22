/**
 * کلید API — احراز هویت ماشینی، برای افزونه ووکامرس و مانند آن.
 *
 * ── چرا این مسیر جداست و چرا همه‌چیز دیگر یکی می‌ماند ──────────────
 *
 * سایت یک مرورگر نیست: نه کوکی نشست دارد، نه صفحه ورود، نه کسی پشتش
 * نشسته که رمز بزند. پس **راه ورودش** جداست.
 *
 * ولی از آن به بعد هیچ‌چیز جدا نیست: هر کلاینت یک **کاربر واقعی**
 * پشتش دارد و از همان‌جا مجوز می‌گیرد. `identity.can()` همان
 * `user_role` را می‌خواند و `platform.audit()` همان کاربر را
 * می‌نویسد — پس در لاگ حسابرسی معلوم است «سایت این را ثبت کرده».
 *
 * وسوسه اول یک سیستم Scope جدا روی خودِ کلاینت بود. رد شد: دو تعریف
 * از دسترسی، و قاعده «هیچ شرط دسترسی در کد نیست» فقط برای یکی‌شان
 * برقرار می‌ماند.
 *
 * ── چرا SHA-256 و نه Argon2 ────────────────────────────────────────
 *
 * کلید ۳۲ بایت تصادفی است، نه رمزی که آدم انتخاب کرده: حمله
 * فرهنگ‌لغتی رویش معنا ندارد. Argon2 اینجا فقط هزینه‌ای است که روی
 * **هر درخواست** سایت می‌نشیند. همان قاعده توکن نشست.
 *
 * ── نشست ساختگی، نه یک راه دور زدن ─────────────────────────────────
 *
 * کلید یک `ResolvedSession` می‌سازد که `pinUnlocked: false` دارد و
 * `sessionId` ندارد. یعنی از دید بقیه کد یک نشست کامل است و همه
 * دفاع‌ها رویش کار می‌کنند — ولی چون نشست واقعی نیست، در
 * `identity.session` ردیفی ندارد و «ابطال همه نشست‌های کاربر» رویش
 * اثر ندارد. ابطالش یک `UPDATE is_active = false` روی خودِ کلید است.
 */
import { createHash, randomBytes } from "node:crypto";
import { sql } from "kysely";
import type { Db } from "../db/client.ts";
import type { ResolvedSession } from "./service.ts";

/** پیشوند تا کلیدِ لو رفته در لاگ یا مخزن، قابل تشخیص باشد. */
const KEY_PREFIX = "lmk_";
const KEY_BYTES = 32;

/** کلید تازه. یک بار چاپ می‌شود و از آن به بعد فقط هشش می‌ماند. */
export function newApiKey(): string {
  return KEY_PREFIX + randomBytes(KEY_BYTES).toString("base64url");
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/**
 * کلید را از هدر `Authorization` بیرون می‌کشد.
 *
 * فقط `Bearer` و فقط با پیشوند خودمان. بدون بررسی پیشوند، هر رشته‌ای
 * یک رفت‌وبرگشت دیتابیس می‌خورد — و مسیر ورود سایت باید ارزان بماند.
 */
export function apiKeyFrom(header: unknown): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const key = match?.[1];
  if (!key || !key.startsWith(KEY_PREFIX)) return null;
  return key;
}

export interface ApiClientSession extends ResolvedSession {
  /** شناسه کلاینت — برای پیام خطا و ردیابی، نه برای مجوز. */
  apiClientId: string;
}

/**
 * کلید → نشست ساختگی. `null` یعنی کلید نامعتبر، باطل، یا ناشناخته —
 * و هر سه یک پاسخ می‌گیرند: هیچ پیامی نمی‌گوید کدام.
 */
export async function resolveApiKey(
  db: Db,
  key: string,
): Promise<ApiClientSession | null> {
  const r = await sql<{ client_id: string; user_id: string; client_name: string }>`
    SELECT * FROM identity.api_client_from_key(${hashApiKey(key)})
  `.execute(db);

  const row = r.rows[0];
  if (!row) return null;

  const roles = await db
    .selectFrom("identity.user_role")
    .select("role_code")
    .where("user_id", "=", row.user_id)
    .execute();

  return {
    apiClientId: row.client_id,
    sessionId: row.client_id,
    userId: row.user_id,
    fullName: row.client_name,
    roles: roles.map((x) => x.role_code),
    // کلید API عمر ندارد؛ ابطالش یک UPDATE است، نه انقضا.
    expiresAt: new Date(Date.now() + 60_000),
    device: null,
    // کلید API با PIN باز نشده — عملیات حساس از این مسیر بسته
    // نیستند، ولی مجوزشان همچنان از `permission_rule` می‌آید.
    pinUnlocked: false,
    // سیاست ورود تعاملی کارکنان به کلیدهای ماشین اعمال نمی‌شود.
    enrollmentOnly: false,
  };
}
