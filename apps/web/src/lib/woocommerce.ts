import { api } from "./api.ts";
export interface WooConfig { siteUrl: string; warehouseId: string; pushEnabled: boolean; signingConfigured: boolean; priceList: string }
export interface WooResult {
  ok: boolean; message: string;
  remote: null | { pluginVersion: string; wooVersion: string; siteUrl: string; apiKeyConfigured: boolean; pushConfigured?: boolean;
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

/**
 * راه‌اندازی هفت‌مرحله‌ای اتصال (طرح ۱۰، R05). هر مرحله منبع حقیقت خودش را دارد:
 * تنظیمات سرور از GET، وضعیت افزونه فقط از آخرین «تست اتصال». پیش از تست، آنچه
 * فقط وردپرس می‌داند «نامعلوم» است — هرگز «انجام‌شده».
 */
export type SetupState = "done" | "todo" | "unknown";
export interface SetupStep { key: string; title: string; state: SetupState; detail: string }

export function setupSteps(config: WooConfig, result: WooResult | null): SetupStep[] {
  const remote = result?.remote ?? null;
  const untested = "تا «تست اتصال» نامعلوم است.";
  const linked = remote?.mapping.linkedProducts;
  return [
    { key: "site", title: "نشانی سایت", ...(config.siteUrl
      ? { state: "done", detail: "در تنظیمات اتصال لیبل مد ثبت شده است." }
      : { state: "todo", detail: "نشانی HTTPS سایت هنوز ثبت نشده است." }) },
    { key: "plugin", title: "افزونهٔ لیبل مد در وردپرس", ...(remote
      ? { state: "done", detail: `نسخهٔ ${remote.pluginVersion} پاسخ داد.` }
      : { state: "unknown", detail: untested }) },
    { key: "api-key", title: "کلید API سایت در افزونه", ...(!remote
      ? { state: "unknown", detail: untested }
      : remote.apiKeyConfigured
        ? { state: "done", detail: "افزونه کلید را دارد؛ اعتبارش با تست داخل وردپرس سنجیده می‌شود." }
        : { state: "todo", detail: "کلید API شعبه را در صفحهٔ اتصال لیبل مد وردپرس ذخیره کنید." }) },
    { key: "push", title: "کلید امضای همگام‌سازی لحظه‌ای", ...(!config.pushEnabled
      ? { state: "todo", detail: "ارسال لحظه‌ای خاموش است؛ موجودی فقط با دریافت دوره‌ای همگام می‌شود." }
      : !config.signingConfigured
        ? { state: "todo", detail: "کلید امضا در API و Worker تنظیم نشده است." }
        : remote?.pushConfigured === true
          ? { state: "done", detail: "سرور و افزونه هر دو کلید را دارند." }
          : remote?.pushConfigured === false
            ? { state: "todo", detail: "سرور کلید دارد ولی افزونه ندارد." }
            : { state: "unknown", detail: remote ? "این نسخهٔ افزونه وضعیت کلید را گزارش نمی‌کند." : untested }) },
    { key: "warehouse", title: "انبار سایت", ...(config.warehouseId
      ? { state: "done", detail: "موجودی سایت از همین انبار خوانده می‌شود." }
      : { state: "todo", detail: "انبار سایت تعیین نشده؛ هیچ پیام موجودی ساخته نمی‌شود." }) },
    { key: "mapping", title: "نگاشت کالا", ...(!remote
      ? { state: "unknown", detail: untested }
      : linked === null || linked === undefined
        ? { state: "unknown", detail: "شمارش محصولات متصل خوانده نشد." }
        : linked > 0
          ? { state: "done", detail: `${linked.toLocaleString("fa-IR")} محصول شناسهٔ اتصال دارد.` }
          : { state: "todo", detail: "هیچ محصولی شناسهٔ اتصال ندارد." }) },
    { key: "test", title: "آزمون اتصال", ...(!result
      ? { state: "todo", detail: "هنوز در این صفحه اجرا نشده است." }
      : result.ok
        ? { state: "done", detail: "آخرین تست کامل شد؛ نتیجهٔ کامل پایین‌تر آمده است." }
        : { state: "todo", detail: "آخرین تست کامل نشد." }) },
  ];
}
