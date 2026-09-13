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
import type { Transaction } from "kysely";
import type { Database } from "./types.ts";
import { setActor as setActorIn } from "../lib/idempotency.ts";

export interface Actor {
  userId: string;
  ip?: string | undefined;
  device?: string | undefined;
}

/**
 * ⚠️ **یک تعریف، نه دو تا.** این تابع خودش SQL نمی‌زند و به
 * `lib/idempotency.ts` تکیه می‌کند. پیش از این هر دو نسخهٔ خودشان را
 * داشتند و همان شد که قاعدهٔ «دروازه یک تعریف دارد» درباره‌اش هشدار
 * می‌دهد: نسخهٔ پرکاربردتر `ip` و `device` را اختیاری داشت و ~۷۰
 * فراخوان ندادنشان، پس لاگ حسابرسی هر دو را NULL می‌نوشت.
 */
export async function setActor(trx: Transaction<Database>, actor: Actor): Promise<void> {
  await setActorIn(trx, actor.userId, actor.ip, actor.device);
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
