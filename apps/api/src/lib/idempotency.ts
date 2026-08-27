/**
 * Idempotency — قاعده صریح لایه API که تا امروز پیاده نشده بود.
 *
 * `.claude/rules/api.md` می‌گوید هر Endpoint تغییردهنده وضعیت باید:
 *   ۱. هدر Idempotency-Key بگیرد
 *   ۲. در platform.inbox_message با یکتایی (source, event_id) درج شود
 *   ۳. اثر و درج Inbox در **یک تراکنش** باشند
 *
 * چرا این برای صندوق حیاتی است: کلیک دوم روی «نهایی‌کردن» یا Retry
 * شبکه‌ی تبلت، بدون این، یک فاکتور دوم می‌سازد — کالا دو بار از انبار
 * کم می‌شود و مشتری یک بار پول داده. اینجا درج دوم روی قید یکتایی
 * می‌شکند و همان نتیجه قبلی برمی‌گردد.
 *
 * چرا در همان تراکنش: اگر Inbox جدا Commit شود، خرابی میان دو Commit
 * یا اثر بدون رد می‌گذارد یا رد بدون اثر — و هر دو بدتر از تکرارند.
 */
import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { Database } from "../db/types.ts";
import type { Db } from "../db/client.ts";

/** خطای درج تکراری در پستگرس. */
const UNIQUE_VIOLATION = "23505";

export interface IdempotentResult<T> {
  value: T;
  /** آیا این پاسخ از اجرای تازه آمد یا از تکرار یک درخواست قبلی؟ */
  replayed: boolean;
}

/**
 * عملیات را یک بار اجرا می‌کند، حتی اگر چند بار صدا زده شود.
 *
 * `fn` باید شناسه‌ی موجودیتی که ساخته را برگرداند؛ همان در
 * `result_ref` می‌نشیند و در تکرارِ بعدی به `replay` داده می‌شود تا
 * پاسخ دقیقاً همان چیزی باشد که بار اول برگشت.
 *
 * بدون کلید (`key` تهی) عملیات عادی اجرا می‌شود — چون اجبار کردنش روی
 * هر مسیر، مسیرهای داخلی و تست را هم می‌شکند. اجبارش کار لایه مسیر است.
 */
export async function runOnce<T>(
  db: Db,
  opts: {
    key: string | undefined;
    source: string;
    payload: unknown;
    run: (trx: Transaction<Database>) => Promise<{ value: T; ref: string }>;
    replay: (ref: string) => Promise<T>;
  },
): Promise<IdempotentResult<T>> {
  if (!opts.key) {
    const out = await db.transaction().execute((trx) => opts.run(trx));
    return { value: out.value, replayed: false };
  }

  const existing = await db
    .selectFrom("platform.inbox_message")
    .select("result_ref")
    .where("source", "=", opts.source)
    .where("event_id", "=", opts.key)
    .executeTakeFirst();

  if (existing?.result_ref) {
    return { value: await opts.replay(existing.result_ref), replayed: true };
  }

  try {
    const out = await db.transaction().execute(async (trx) => {
      // درج Inbox **پیش از** اثر: اگر دو درخواست هم‌زمان برسند، دومی
      // همین‌جا روی قید یکتایی می‌شکند و اثر را اصلاً شروع نمی‌کند.
      await trx
        .insertInto("platform.inbox_message")
        .values({
          source: opts.source,
          event_id: opts.key as string,
          payload: JSON.stringify(opts.payload ?? {}),
          result_ref: null,
        })
        .execute();

      const result = await opts.run(trx);

      await trx
        .updateTable("platform.inbox_message")
        .set({ result_ref: result.ref })
        .where("source", "=", opts.source)
        .where("event_id", "=", opts.key as string)
        .execute();

      return result;
    });
    return { value: out.value, replayed: false };
  } catch (err) {
    if ((err as { code?: string }).code !== UNIQUE_VIOLATION) throw err;

    // مسابقه: درخواست هم‌زمانِ دیگری زودتر رسید. منتظر نتیجه‌اش
    // می‌مانیم — نه اینکه خطا بدهیم، چون از دید فراخوان همان درخواست
    // است و باید همان پاسخ را بگیرد.
    const row = await db
      .selectFrom("platform.inbox_message")
      .select("result_ref")
      .where("source", "=", opts.source)
      .where("event_id", "=", opts.key as string)
      .executeTakeFirst();

    if (!row?.result_ref) {
      // درخواست همزمان هنوز تمام نشده. تکرار امن‌تر از حدس زدن است.
      throw new IdempotencyInFlightError();
    }
    return { value: await opts.replay(row.result_ref), replayed: true };
  }
}

export class IdempotencyInFlightError extends Error {
  readonly statusCode = 409;
  readonly code = "idempotency_in_flight";

  constructor() {
    super("همین درخواست هم‌اکنون در حال پردازش است. چند لحظه بعد دوباره تلاش کنید.");
    this.name = "IdempotencyInFlightError";
  }
}

/** کاربر عامل را داخل همان تراکنشِ اثر ست می‌کند. */
export async function setActor(
  trx: Transaction<Database>,
  userId: string,
  ip?: string | undefined,
  device?: string | undefined,
): Promise<void> {
  await sql`SELECT platform.set_actor(${userId}::uuid, ${ip ?? null}::inet, ${
    device ?? null
  }::text)`.execute(trx);
}
