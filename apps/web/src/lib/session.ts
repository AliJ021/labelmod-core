/**
 * نشست سمت مرورگر — و اینکه کدام صفحه باید دیده شود.
 *
 * توکن نشست HttpOnly است و این فایل هرگز نمی‌بیندش. تنها کاری که
 * اینجا می‌شود این است که از سرور بپرسیم «کی هستم؟» و بر اساس پاسخ
 * تصمیم بگیریم کدام صفحه را نشان بدهیم.
 *
 * ── چرا «قفل» را در حافظه مرورگر نگه می‌داریم ────────────────────
 *
 * `identity.session_from_token()` برای نشست **قفل‌شده** هیچ‌چیز
 * برنمی‌گرداند — عمداً، چون نشست قفل نباید هیچ مسیری را باز کند. اثر
 * جانبی‌اش این است که `GET /auth/me` برای «قفل است» و «اصلاً وارد
 * نشده» **یک پاسخ** می‌دهد: ۴۰۱ `no_session`.
 *
 * پس اگر فقط به سرور تکیه کنیم، صندوق‌داری که صفحه را قفل کرده، بعد
 * از برگشتن فرم ورود کامل می‌بیند — نه صفحه PIN. یعنی قفل صفحه عملاً
 * همان خروج می‌شود و کل دلیل وجودش (بازگشت سریع بین دو مشتری) از بین
 * می‌رود.
 *
 * راه‌حل: وقتی **خودمان** قفل می‌کنیم، نام کاربر را در حافظه مرورگر
 * یادداشت می‌کنیم تا بدانیم کدام صفحه را نشان بدهیم.
 *
 * این امنیت را ضعیف نمی‌کند و نباید با آن اشتباه شود: این یادداشت
 * فقط **کدام فرم را نشان بده** را تعیین می‌کند. مرجع همچنان سرور
 * است — اگر نشست واقعاً رفته باشد، `POST /auth/unlock` همان
 * `no_session` را می‌دهد و ما به فرم ورود برمی‌گردیم. هیچ دسترسی‌ای
 * از روی این مقدار داده نمی‌شود.
 */
import { api, ApiError } from "./api.ts";
import { browserStore, type DeviceStore } from "./device.ts";

const LOCK_KEY = "labelmod_locked_user";

export interface DeviceState {
  approved: boolean;
  enrolled: boolean;
}

export interface Me {
  id: string;
  fullName: string;
  roles: string[];
  expiresAt: string;
  /**
   * نشست ارتقایافته است؟
   *
   * سرور این را `!pinUnlocked` حساب می‌کند: نشستی که با PIN باز شده
   * ارتقایافته **نیست** و عملیات `auth.pin_forbidden_operations` رویش
   * بسته است. UI با همین تصمیم می‌گیرد دکمه‌ای را نشان بدهد که سرور
   * بعداً ردش می‌کند یا اول احراز کامل مجدد بخواهد.
   */
  elevated: boolean;
  device: DeviceState | null;
  /** این نشست تا ثبت عامل دوم به مسیرهای راه‌اندازی محدود است. */
  enrollmentRequired: boolean;
}

export interface LoginResult {
  user: { id: string; fullName: string; roles: string[] };
  expiresAt: string;
  device: {
    registered: boolean;
    approved: boolean;
    enrolled: boolean;
    /** تا دستگاه راز ثبت‌نام نگرفته باشد، PIN کار نمی‌کند. */
    pinAvailable: boolean;
  } | null;
  enrollmentRequired: boolean;
}

/** کدام صفحه دیده شود. */
export type AuthView = "loading" | "login" | "locked" | "ready";

/**
 * تصمیم صفحه — یک تابع خالص، تا بشود بدون مرورگر سنجیدش.
 *
 * ترتیب مهم است: نشست زنده همیشه برنده است. اگر یادداشت قفل مانده
 * ولی سرور می‌گوید نشست معتبر است (مثلاً از تب دیگری باز شده)، صفحه
 * PIN نشان دادن یعنی کاربر را الکی پشت یک در نگه داشته‌ایم.
 */
export function authView(input: {
  loaded: boolean;
  me: Me | null;
  lockedUser: string | null;
}): AuthView {
  if (!input.loaded) return "loading";
  if (input.me) return "ready";
  return input.lockedUser ? "locked" : "login";
}

/** نامی که روی صفحه قفل نشان داده می‌شود — اگر قفلی در کار باشد. */
export function readLockedUser(store: DeviceStore = browserStore): string | null {
  const v = store.read(LOCK_KEY);
  return v !== null && v.trim() !== "" ? v : null;
}

export function rememberLock(fullName: string, store: DeviceStore = browserStore): void {
  store.write(LOCK_KEY, fullName);
}

export function forgetLock(store: DeviceStore = browserStore): void {
  store.write(LOCK_KEY, "");
}

/**
 * آیا این خطا یعنی «نشستی نیست»؟
 *
 * هم ۴۰۱ و هم کد `no_session` سنجیده می‌شوند: کد دقیق‌تر است ولی
 * مسیرهای دیگری هم ممکن است فقط وضعیت بدهند.
 */
export function isNoSession(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.code === "no_session");
}

/**
 * پاسخ موتور مجوز — همان چیزی که `identity.can()` برمی‌گرداند.
 *
 * `needs_approval` از `deny` جداست: اولی یعنی «کسی باید تأیید کند» و
 * دومی یعنی «نه». یکی‌کردنشان یعنی سرپرست هیچ‌وقت پرسیده نمی‌شود.
 */
export interface Decision {
  verdict: "allow" | "deny" | "needs_approval";
  approver: string | null;
  reason: string;
}

/**
 * پاسخ مرحله اول ورود — نشست، یا «کد دوم لازم است».
 *
 * `needsSecondFactor` یک اتحاد تفکیک‌شده در TypeScript نیست چون از
 * JSON می‌آید، ولی همان نقش را دارد: صفحه باید هر دو حالت را بنویسد.
 */
export interface SecondFactorNeeded {
  needsSecondFactor: true;
  fullName: string;
  methods: Array<"totp" | "webauthn" | "recovery">;
  expiresAt: string;
}

/**
 * یک کلید امنیتی ثبت‌شده.
 *
 * `publicKey` و `counter` عمداً اینجا نیستند چون در **پاسخ سرور** هم
 * نیستند — مثل `identity.device_overview` که ستون راز را ندارد.
 */
export interface WebauthnKey {
  id: string;
  credentialId: string;
  name: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  deviceType: string | null;
  backedUp: boolean;
}

export interface TwoFactorStatus {
  enabled: boolean;
  pending: boolean;
  recoveryCodesLeft: number;
  webauthnKeys: number;
  /** نقشش در فهرست الزام است ولی هنوز راه نینداخته است. */
  shouldHave: boolean;
}

export const session = {
  /** `null` یعنی وارد نشده یا قفل — از هم قابل تفکیک نیستند. */
  async me(): Promise<Me | null> {
    try {
      return await api.get<Me>("/auth/me");
    } catch (err) {
      if (isNoSession(err)) return null;
      throw err;
    }
  },

  /**
   * «آیا می‌توانم؟» — تا صفحه دکمه‌ای نشان ندهد که سرور بعداً ردش کند.
   *
   * ⚠️ **دروازه نیست.** هر عملیات حساس در لحظه اجرا دوباره مجوز
   *    می‌گیرد؛ این فقط برای اینکه کاربر به بن‌بست نخورد. صفحه‌ای که
   *    فقط به این تکیه کند، با یک درخواست مستقیم دور زده می‌شود.
   */
  can(operation: string): Promise<Decision> {
    return api.get<Decision>(`/auth/can?operation=${encodeURIComponent(operation)}`);
  },

  login(input: {
    username: string;
    password: string;
    deviceFingerprint: string;
  }): Promise<LoginResult | SecondFactorNeeded> {
    return api.post<LoginResult | SecondFactorNeeded>("/auth/login", input);
  },

  /**
   * مرحله دوم — بلیت از **کوکی** می‌رود، نه از بدنه.
   *
   * کوکی `labelmod_pending` را سرور HttpOnly ست کرده و مرورگر خودش
   * برمی‌گرداند. اسکریپت صفحه هرگز نمی‌بیندش.
   */
  secondFactor(
    method: "totp" | "recovery",
    input: { code: string; deviceFingerprint: string },
  ): Promise<LoginResult> {
    return api.post<LoginResult>(`/auth/2fa/${method}`, input);
  },

  twoFactor(): Promise<TwoFactorStatus> {
    return api.get<TwoFactorStatus>("/auth/2fa");
  },

  beginTotp(): Promise<{ secret: string; uri: string }> {
    return api.post<{ secret: string; uri: string }>("/auth/2fa/totp/begin", {});
  },

  confirmTotp(code: string): Promise<{ enabled: boolean; recoveryCodes: string[] }> {
    return api.post<{ enabled: boolean; recoveryCodes: string[] }>(
      "/auth/2fa/totp/confirm",
      { code },
    );
  },

  regenerateRecovery(): Promise<{ recoveryCodes: string[] }> {
    return api.post<{ recoveryCodes: string[] }>("/auth/2fa/recovery/regenerate", {});
  },

  disableTwoFactor(): Promise<{ ok: boolean }> {
    return api.del<{ ok: boolean }>("/auth/2fa");
  },

  // ── کلید امنیتی ───────────────────────────────────────────────
  //
  // گزینه‌ها و پاسخ‌ها عمداً `Record<string, unknown>` می‌مانند: شکل
  // دقیقشان را استاندارد تعیین می‌کند و `lib/webauthn.ts` ترجمه‌شان
  // می‌کند. تعریف دوباره‌شان اینجا یعنی دو نسخه از یک قرارداد.

  webauthnKeys(): Promise<{ credentials: WebauthnKey[] }> {
    return api.get<{ credentials: WebauthnKey[] }>("/auth/2fa/webauthn");
  },

  beginWebauthnRegistration(): Promise<Record<string, unknown>> {
    return api.post<Record<string, unknown>>("/auth/2fa/webauthn/register/begin", {});
  },

  finishWebauthnRegistration(
    response: Record<string, unknown>,
    name?: string,
  ): Promise<{ id: string }> {
    return api.post<{ id: string }>("/auth/2fa/webauthn/register/finish", {
      response,
      ...(name === undefined || name.trim() === "" ? {} : { name: name.trim() }),
    });
  },

  removeWebauthnKey(id: string): Promise<{ ok: boolean }> {
    return api.del<{ ok: boolean }>(`/auth/2fa/webauthn/${encodeURIComponent(id)}`);
  },

  /** مرحله دوم ورود — بلیت در کوکی است، پس بدنه‌ای لازم نیست. */
  beginWebauthnLogin(): Promise<Record<string, unknown>> {
    return api.post<Record<string, unknown>>("/auth/2fa/webauthn/begin", {});
  },

  verifyWebauthnLogin(response: Record<string, unknown>): Promise<unknown> {
    return api.post<unknown>("/auth/2fa/webauthn/verify", { response });
  },

  unlock(input: { pin: string; deviceFingerprint: string }): Promise<{ ok: boolean }> {
    return api.post<{ ok: boolean }>("/auth/unlock", input);
  },

  /** تنها راه درآوردن نشست از حالت PIN — رمز کامل، نه PIN. */
  reauth(password: string): Promise<{ ok: boolean; elevated: boolean }> {
    return api.post<{ ok: boolean; elevated: boolean }>("/auth/reauth", { password });
  },

  lock(): Promise<{ locked: boolean }> {
    return api.post<{ locked: boolean }>("/auth/lock");
  },

  logout(): Promise<{ ok: boolean }> {
    return api.post<{ ok: boolean }>("/auth/logout");
  },
};
