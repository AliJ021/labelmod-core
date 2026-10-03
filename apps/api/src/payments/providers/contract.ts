import { z } from "zod";

/** فقط مرز سرور؛ هیچ credential یا پاسخ خامی به UI یا لاگ برنمی‌گردد. */
export class ProviderContractError extends Error {
  readonly code: "invalid_input" | "unsupported" | "invalid_configuration";
  constructor(code: "invalid_input" | "unsupported" | "invalid_configuration") {
    super(code === "unsupported" ? "قرارداد این عملیات پرداخت تأیید نشده است." : "دادهٔ اتصال پرداخت معتبر نیست.");
    this.name = "ProviderContractError";
    this.code = code;
  }
}

export const rial = z.string().regex(/^(0|[1-9]\d{0,17})$/);
export const identifier = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);

export function input<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ProviderContractError("invalid_input");
  return parsed.data;
}

export function assertContract(condition: boolean): asserts condition {
  if (!condition) throw new ProviderContractError("invalid_input");
}

export interface ProviderRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  /** انتقال‌دهنده باید Redirect را رد کند؛ credential نباید به میزبان دیگر برود. */
  redirect: "error";
}
export interface ProviderResponse { status: number; body: string }
/** انتقال‌دهندهٔ تزریق‌شده نباید retry، redirect یا ثبت بدنه/هدر داشته باشد. */
export type ProviderTransport = (request: ProviderRequest) => Promise<ProviderResponse>;
export type ProviderResult<T> = { kind: "ok"; value: T } | {
  kind: "unknown";
  reason: "timeout" | "transport" | "http" | "response";
};

/** محدودیت محلی دفاعی؛ تلاش دوباره یا موفقیت مالی از نتیجهٔ نامعلوم استنتاج نمی‌شود. */
export async function exchange<T>(transport: ProviderTransport, request: Omit<ProviderRequest, "signal" | "redirect">,
  schema: z.ZodType<T>, timeoutMs = 30_000): Promise<ProviderResult<T>> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new ProviderContractError("invalid_configuration");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, timeoutMs);
    });
    const response = await Promise.race([
      Promise.resolve().then(() => transport({ ...request, signal: controller.signal, redirect: "error" })), timeout,
    ]);
    if (response.status < 200 || response.status >= 300) return { kind: "unknown", reason: "http" };
    if (response.body.length > 262_144) return { kind: "unknown", reason: "response" };
    // JSON عددی در قرارداد درگاه است؛ متن اصلی مبلغ قبل از گردشدن Number برداشته می‌شود.
    const decoded: unknown = JSON.parse(response.body, (key, value: unknown, context?: { source?: string }) => {
      if (key === "amount" && typeof value === "number") return context?.source ?? null;
      return value;
    });
    const parsed = schema.safeParse(decoded);
    return parsed.success ? { kind: "ok", value: parsed.data } : { kind: "unknown", reason: "response" };
  } catch {
    return { kind: "unknown", reason: controller.signal.aborted ? "timeout" : "transport" };
  } finally { clearTimeout(timer); }
}

/** مبلغ داخلی رشته است؛ فقط در مرز مستند API به عدد صحیح JSON تبدیل می‌شود. */
export function wireJson(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(wireJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}:${wireJson(item)}`).join(",")}}`;
  }
  throw new ProviderContractError("invalid_input");
}

export function httpsUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ProviderContractError("invalid_configuration"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new ProviderContractError("invalid_configuration");
  return url.href;
}

/** قرارداد عمومی حضوری/لینک/صورت‌حساب اثبات نشده؛ دیجی‌پی تا دریافت قرارداد دقیق بسته است. */
export function requireSupportedChannel(provider: "snappay" | "digipay", channel: string): void {
  if (provider !== "snappay" || channel !== "online") throw new ProviderContractError("unsupported");
}
