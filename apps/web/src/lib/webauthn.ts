/**
 * مراسم WebAuthn سمت مرورگر — و تبدیلی که بیشترین اشتباه را دارد.
 *
 * ── چرا این فایل وجود دارد ────────────────────────────────────────
 *
 * سرور JSON می‌فرستد و JSON بایت ندارد؛ `navigator.credentials` اما
 * `ArrayBuffer` می‌خواهد و `ArrayBuffer` برمی‌گرداند. پس بین این دو،
 * `base64url` می‌نشیند — و اینجا **رایج‌ترین باگ WebAuthn وب** است:
 * استفاده از `btoa`/`atob` که `base64` استاندارد می‌دهند، نه
 * `base64url`. تفاوتشان سه کاراکتر است (`+` در برابر `-`، `/` در
 * برابر `_`، و `=` پایانی) و نتیجه‌اش یک امضای معتبر است که سرور
 * ردش می‌کند، **بدون هیچ پیام مفیدی**.
 *
 * ⚠️ **EXTERNAL VERIFICATION REQUIRED.** این مسیر به یک دامنه واقعی
 *    (HTTPS، نه `localhost` با IP) و یک Authenticator واقعی نیاز
 *    دارد. تست‌های مخزن چرخه چالش و دامنه را می‌سنجند؛ خودِ مراسم
 *    باید یک بار با کلید واقعی آزموده شود.
 *
 * ── چرا کتابخانه‌ای اضافه نشد ──────────────────────────────────────
 *
 * سمت سرور `@simplewebauthn/server` هست چون آنجا CBOR، COSE و شش
 * خانواده امضا در کار است. سمت مرورگر هیچ‌کدام نیست: دو تبدیل
 * base64url و دو فراخوان مرورگر. `docs/SECURITY.md` بند ۵ می‌گوید
 * «هیچ وابستگی‌ای بدون دلیل مشخص» — و اینجا دلیلی نیست.
 */

/** `base64url` → بایت. `atob` تنها `base64` می‌فهمد، پس اول ترجمه. */
function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  // `ArrayBuffer` صریح، نه `ArrayBufferLike`: نوع `BufferSource` در
  // DOM حافظه اشتراکی را نمی‌پذیرد و بدون این، خروجی جور نمی‌شود.
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** بایت → `base64url`. `btoa` پایانه `=` می‌گذارد و باید برداشته شود. */
function toBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * آیا این مرورگر اصلاً کلید امنیتی دارد؟
 *
 * `undefined` روی هر چیزی که HTTPS نیست (و روی مرورگرهای قدیمی).
 * صفحه باید دکمه‌ای نشان ندهد که با کلیک، خطای مبهم مرورگر بدهد.
 */
export function webauthnAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential === "function" &&
    typeof navigator.credentials?.create === "function"
  );
}

/** گزینه‌های سرور، همان‌طور که JSON می‌آیند. */
type ServerOptions = Record<string, unknown>;

interface RawDescriptor {
  id: string;
  type?: string;
  transports?: string[];
}

function descriptors(list: unknown): PublicKeyCredentialDescriptor[] {
  if (!Array.isArray(list)) return [];
  return (list as RawDescriptor[]).map((d) => ({
    id: fromBase64Url(d.id),
    type: "public-key",
    ...(d.transports === undefined
      ? {}
      : { transports: d.transports as AuthenticatorTransport[] }),
  }));
}

/**
 * ثبت یک کلید تازه.
 *
 * خروجی همان شکلی است که `@simplewebauthn/server` انتظار دارد —
 * ساختنش دستی است چون `PublicKeyCredential` یک شیء مرورگری است و
 * `JSON.stringify` رویش یک شیء **خالی** می‌دهد. این هم یک تله رایج
 * است که خطایش «پاسخ ناقص» است، نه چیزی که علت را بگوید.
 */
export async function createCredential(options: ServerOptions): Promise<Record<string, unknown>> {
  const user = options.user as { id: string; name: string; displayName: string };
  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge: fromBase64Url(options.challenge as string),
    rp: options.rp as PublicKeyCredentialRpEntity,
    user: {
      id: fromBase64Url(user.id),
      name: user.name,
      displayName: user.displayName,
    },
    pubKeyCredParams: options.pubKeyCredParams as PublicKeyCredentialParameters[],
    excludeCredentials: descriptors(options.excludeCredentials),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout as number }),
    ...(options.authenticatorSelection === undefined
      ? {}
      : { authenticatorSelection: options.authenticatorSelection as AuthenticatorSelectionCriteria }),
    ...(options.attestation === undefined
      ? {}
      : { attestation: options.attestation as AttestationConveyancePreference }),
  };

  const credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!credential) throw new Error("کلیدی ساخته نشد.");
  const response = credential.response as AuthenticatorAttestationResponse;

  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      attestationObject: toBase64Url(response.attestationObject),
      transports:
        typeof response.getTransports === "function" ? response.getTransports() : undefined,
    },
  };
}

/** مرحله دوم ورود — همان تبدیل‌ها، در جهت دیگر. */
export async function getAssertion(options: ServerOptions): Promise<Record<string, unknown>> {
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: fromBase64Url(options.challenge as string),
    allowCredentials: descriptors(options.allowCredentials),
    ...(options.rpId === undefined ? {} : { rpId: options.rpId as string }),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout as number }),
    ...(options.userVerification === undefined
      ? {}
      : { userVerification: options.userVerification as UserVerificationRequirement }),
  };

  const credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!credential) throw new Error("کلید پاسخی نداد.");
  const response = credential.response as AuthenticatorAssertionResponse;

  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      authenticatorData: toBase64Url(response.authenticatorData),
      signature: toBase64Url(response.signature),
      userHandle: response.userHandle === null ? undefined : toBase64Url(response.userHandle),
    },
  };
}

/** برای تست — همان تبدیلی که مراسم رویش سوار است. */
export const __base64url = { fromBase64Url, toBase64Url };
