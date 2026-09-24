/**
 * مشتری API — نازک عمداً.
 *
 * سه چیزی که هر فراخوان لازم دارد و هیچ‌کدام نباید در صفحه‌ها تکرار
 * شوند:
 *
 * ۱. **کوکی همراه درخواست.** نشست یک توکن مات در کوکی HttpOnly است،
 *    نه یک هدر — پس `credentials: "include"` اجباری است. بدون آن، هر
 *    درخواست ۴۰۱ می‌گیرد بی‌آنکه چیزی در کنسول توضیحش دهد.
 *
 * ۲. **توکن CSRF روی هر درخواست تغییردهنده وضعیت.** بند ۶ SECURITY.md
 *    الگوی Double-Submit را الزام کرده: همان مقدار که در کوکی
 *    غیر‌HttpOnly نشسته، در هدر هم می‌رود.
 *
 * ۳. **پیام خطای فارسیِ خودِ سرور.** بدنه خطا `{error:{code,message}}`
 *    است و پیامش عمداً برای کاربر نوشته شده — «موجودی کافی نیست»، نه
 *    «Request failed with status 409». دور انداختنش و گذاشتن یک پیام
 *    عمومی، دفاع‌های سرور را در عمل خاموش می‌کند.
 */

const BASE = "/api";
const CSRF_COOKIE = "labelmod_csrf";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly correlationId: string | null;

  constructor(status: number, code: string, message: string, correlationId: string | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
  }
}

/** مقدار یک کوکی — فقط کوکی‌های غیر HttpOnly دیده می‌شوند. */
export function readCookie(name: string, jar = typeof document === "undefined" ? "" : document.cookie): string | null {
  for (const part of jar.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

interface ErrorBody {
  error?: { code?: string; message?: string; correlationId?: string };
}

export interface RequestOptions {
  signal?: AbortSignal;
  /**
   * کلید Idempotency برای این **عمل**.
   *
   * سرور با همین کلید تصمیم می‌گیرد درخواست تازه است یا Replay. پس
   * باید روی Retry شبکه **همان** بماند و برای عمل بعدی **تازه** شود.
   * ساختنش کار `lib/action-key.ts` است، نه اینجا.
   */
  idempotencyKey?: string;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
  responseType: "json" | "html" = "json",
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";

  if (method !== "GET" && method !== "HEAD") {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers["x-csrf-token"] = csrf;
    if (opts.idempotencyKey !== undefined) {
      headers["idempotency-key"] = opts.idempotencyKey;
    }
  }

  const res = await fetch(`${BASE}${path}`, {
    method,
    ...(opts.signal ? { signal: opts.signal } : {}),
    credentials: "include",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await res.text();
  const parsed: unknown = text === "" ? null : safeParse(text);

  if (!res.ok) {
    const e = (parsed as ErrorBody | null)?.error;
    throw new ApiError(
      res.status,
      e?.code ?? "http_error",
      e?.message ?? `درخواست با وضعیت ${res.status} رد شد`,
      e?.correlationId ?? null,
    );
  }
  if (responseType === "html") {
    if (!res.headers.get("content-type")?.includes("text/html")) throw new ApiError(502, "invalid_response", "پاسخ چاپ معتبر نیست", null);
    return text as T;
  }
  return parsed as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const api = {
  postHtml: (path: string, body: unknown) => request<string>("POST", path, body, {}, "html"),
  get: <T>(path: string, opts?: RequestOptions) => request<T>("GET", path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>("POST", path, body ?? {}, opts),
  patch: <T>(path: string, body: unknown, opts?: RequestOptions) =>
    request<T>("PATCH", path, body, opts),
  put: <T>(path: string, body: unknown, opts?: RequestOptions) =>
    request<T>("PUT", path, body, opts),
  del: <T>(path: string, opts?: RequestOptions) =>
    request<T>("DELETE", path, undefined, opts),
};
