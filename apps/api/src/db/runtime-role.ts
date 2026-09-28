import { sql } from "kysely";
import type { DbHandle } from "./client.ts";

/** فقط ورودی سرویس تولید؛ ابزار مهاجرت و داربست آزمون اتصال مالک جدا دارند. */
export async function assertRuntimeDatabaseRole(handle: DbHandle, production: boolean): Promise<void> {
  if (!production) return;
  try {
    // session_user با SET ROLE پنهان نمی‌شود؛ نقش قابل SET می‌تواند مالکیت را ارث ببرد.
    // ADMIN OPTION نیز اجازه می‌دهد عضویت قابل SET دوباره داده شود.
    // PostgreSQL 16: https://www.postgresql.org/docs/16/functions-info.html
    const result = await sql<{ unsafe: boolean }>`
      WITH RECURSIVE assumable(oid) AS (
        SELECT oid FROM pg_roles WHERE rolname IN (session_user,current_user)
        UNION
        SELECT r.oid FROM pg_roles r JOIN assumable a
          ON pg_has_role(a.oid,r.oid,'SET') OR pg_has_role(a.oid,r.oid,'MEMBER WITH ADMIN OPTION')
      ), reachable AS (
        SELECT r.oid,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls,r.rolreplication FROM pg_roles r
        WHERE EXISTS (SELECT 1 FROM assumable a WHERE pg_has_role(a.oid,r.oid,'USAGE'))
      )
      SELECT (
        EXISTS (SELECT 1 FROM reachable WHERE rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication)
        OR EXISTS (SELECT 1 FROM pg_database WHERE datname=current_database() AND datdba IN (SELECT oid FROM reachable))
        OR EXISTS (SELECT 1 FROM pg_namespace WHERE left(nspname,3)<>'pg_'
          AND nspname<>'information_schema' AND nspowner IN (SELECT oid FROM reachable))
        OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
            AND c.relowner IN (SELECT oid FROM reachable))
        OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
            AND p.proowner IN (SELECT oid FROM reachable))
      ) AS unsafe
    `.execute(handle.db);
    if (!result.rows[0] || result.rows[0].unsafe) throw new Error("unsafe_role");
  } catch {
    await handle.close().catch(() => {});
    // جزئیات خطای اتصال ممکن است راز داشته باشد؛ فقط نام ثابت و راه اصلاح چاپ شود.
    throw new Error("runtime_database_role_forbidden: اتصال تولید باید با نقش محدودِ مستقل از مالک باشد؛ تنظیمات اتصال و ops/deploy.sh roles را بررسی کنید.");
  }
}
