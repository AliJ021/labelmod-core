/**
 * بارکد یا شناسه → شناسه تنوع.
 *
 * ── چرا یک فایل جدا، برای بیست خط ─────────────────────────────────
 *
 * این منطق از قبل در `purchasing-routes.ts` بود و مسیر انتقال هم
 * دقیقاً همان را می‌خواست. کپی‌کردنش یعنی دو تعریف از یک قاعده — و
 * آنکه عقب می‌ماند همان است که دور زده می‌شود. قاعده‌اش هم بی‌اهمیت
 * نیست: **کالای بایگانی‌شده اسکن نمی‌شود.** اگر یک مسیر آن را
 * فراموش کند، کالایی که عمداً از چرخه خارج شده دوباره وارد انبار و
 * فاکتور می‌شود.
 *
 * کلاس خطا از فراخوان می‌آید، چون هر دامنه خطای خودش را دارد و
 * `errors.ts` بر اساس همان کلاس، کد و وضعیت را ترجمه می‌کند.
 */
import type { Db } from "../db/client.ts";

export interface DomainError extends Error {
  readonly code: string;
  readonly statusCode: number;
}

export type ErrorFactory = (code: string, message: string, status: number) => DomainError;

export async function resolveVariationId(
  db: Db,
  input: { variationId?: string | undefined; barcode?: string | undefined },
  fail: ErrorFactory,
): Promise<string> {
  const row = await db
    .selectFrom("catalog.variation")
    .select(["id", "status"])
    .$if(input.variationId !== undefined, (q) =>
      q.where("id", "=", input.variationId as string),
    )
    .$if(input.variationId === undefined, (q) =>
      q.where("barcode", "=", input.barcode as string),
    )
    .executeTakeFirst();

  if (!row) throw fail("variation_not_found", "کالا یافت نشد", 404);
  if (row.status === "archived") {
    throw fail("variation_archived", "این کالا بایگانی شده است", 409);
  }
  return row.id;
}
