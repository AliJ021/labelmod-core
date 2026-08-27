/**
 * کاربر عامل — قاعده‌ای که کل لاگ حسابرسی رویش بنا شده.
 *
 * توابع مالی دیتابیس بدون کاربر عامل خطا می‌دهند. مقدارها با
 * is_local = true ست می‌شوند، پس در پایان تراکنش خودبه‌خود پاک می‌شوند و
 * به درخواست بعدیِ همان اتصال نشت نمی‌کنند — که در یک Pool اشتراکی
 * دقیقاً همان چیزی است که باید تضمین شود.
 *
 * به همین دلیل set_actor فقط داخل یک تراکنش معنا دارد؛ این تابع اجازه
 * نمی‌دهد بیرون از تراکنش صدا زده شود.
 */
import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { Database } from "./types.ts";

export interface Actor {
  userId: string;
  ip?: string | undefined;
  device?: string | undefined;
}

export async function setActor(trx: Transaction<Database>, actor: Actor): Promise<void> {
  await sql`SELECT platform.set_actor(${actor.userId}::uuid, ${
    actor.ip ?? null
  }::inet, ${actor.device ?? null}::text)`.execute(trx);
}

/**
 * هر عملیات حساس از این مسیر می‌گذرد: یک تراکنش، با کاربر عامل ست‌شده
 * پیش از اولین کوئری.
 */
export async function withActor<T>(
  db: Database extends never ? never : import("./client.ts").Db,
  actor: Actor,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await setActor(trx, actor);
    return fn(trx);
  });
}
