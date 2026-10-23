import type { Db } from "../db/client.ts";

/**
 * تنظیمات سایت ووکامرس در Core — تنها تعریف، برای تست اتصال و «سفارش‌های سایت».
 * `web.stock_warehouse` کد انبار است (همان که Worker Push می‌خواند)؛ شناسه و شعبه از خود انبار می‌آیند.
 */
export async function readWooSite(db: Db, secret: string | undefined) {
  const rows = await db.selectFrom("platform.setting").select(["key", "value"])
    .where("key", "in", ["web.site_url", "web.push_enabled", "web.stock_warehouse", "web.price_list"]).execute();
  const values = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const warehouseCode = typeof values["web.stock_warehouse"] === "string" ? values["web.stock_warehouse"] : "";
  const warehouse = warehouseCode ? await db.selectFrom("inventory.warehouse").select(["id", "branch_id"])
    .where("code", "=", warehouseCode).executeTakeFirst() : undefined;
  return { siteUrl: typeof values["web.site_url"] === "string" ? values["web.site_url"] : "",
    pushEnabled: values["web.push_enabled"] === true,
    warehouseCode, warehouseId: warehouse?.id ?? "", branchId: warehouse?.branch_id ?? "",
    priceList: typeof values["web.price_list"] === "string" ? values["web.price_list"] : "",
    signingConfigured: !!secret,
  };
}
