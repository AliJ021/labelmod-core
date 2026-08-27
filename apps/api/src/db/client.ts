/**
 * اتصال به پستگرس — Kysely روی pg.
 *
 * دو تنظیم اینجا از جنس «اگر اشتباه باشد، پول خراب می‌شود»‌اند و پیش از
 * ساخت هر Pool اعمال می‌شوند:
 *
 *   NUMERIC (OID 1700) و INT8 (OID 20) باید **رشته** بمانند.
 *   پیش‌فرض pg برای NUMERIC رشته است، ولی این پیش‌فرض یک تصمیم کتابخانه
 *   است نه یک تضمین. صریح ثبتش می‌کنیم تا اگر روزی عوض شد، اینجا
 *   بشکند نه در ترازنامه.
 */
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./types.ts";

const OID_NUMERIC = 1700;
const OID_INT8 = 20;

// یک بار برای کل فرایند، پیش از ساخت Pool.
pg.types.setTypeParser(OID_NUMERIC, (v) => v);
pg.types.setTypeParser(OID_INT8, (v) => v);

export type Db = Kysely<Database>;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function createDb(connectionString: string, poolMax = 10): DbHandle {
  const pool = new pg.Pool({
    connectionString,
    max: poolMax,
    // اتصال بی‌استفاده را زود رها کن: استقرار تک‌سروری است و پستگرس
    // سهم اتصالش محدود.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

  return {
    db,
    pool,
    async close() {
      await db.destroy();
    },
  };
}
