import { api } from "./api.ts";
export interface WooConfig { siteUrl: string; warehouseId: string; pushEnabled: boolean; signingConfigured: boolean; priceList: string }
export interface WooResult {
  ok: boolean; message: string;
  remote: null | { pluginVersion: string; wooVersion: string; siteUrl: string; apiKeyConfigured: boolean;
    stockPolling: boolean; pricePolling: boolean; cronDisabled: boolean; stockScheduled: boolean;
    mapping: { linkedProducts: number | null }; order: null | { found: boolean; status: string; paymentConfirmed: boolean;
      eligible: boolean; recorded: boolean; scheduled: boolean; attempts: number; hasError: boolean; missingSku: number; missingMapping: number } };
}
export const woo = {
  config: (signal: AbortSignal) => api.get<WooConfig>("/settings/woocommerce", { signal }),
  test: (orderId: number | undefined, signal: AbortSignal) => api.post<WooResult>("/settings/woocommerce/test", orderId === undefined ? {} : { orderId }, { signal }),
};
export interface PluginPackage { version: string; filename: string; sha256: string; bytes: number }
export async function pluginPackage(signal: AbortSignal): Promise<PluginPackage> {
  const response = await fetch("/downloads/labelmod-connector.json", { signal, cache: "no-store" });
  if (!response.ok) throw new Error("بستهٔ افزونه در این ساخت موجود نیست.");
  const value = await response.json() as PluginPackage;
  if (!/^\d+\.\d+\.\d+$/.test(value.version) || value.filename !== `labelmod-connector-${value.version}.zip`
      || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.bytes) || value.bytes <= 0) {
    throw new Error("اطلاعات بسته معتبر نیست.");
  }
  return value;
}
