/** قرارداد رسمی self-cms اسنپ‌پی، ویرایش ۲٫۱؛ مرز ادغام در docs/PAYMENT-PROVIDER-CONTRACTS.md. */
import { z } from "zod";
import { assertContract, exchange, httpsUrl, identifier, input, ProviderContractError,
  requireSupportedChannel, rial, wireJson, type ProviderResult, type ProviderTransport } from "./contract.ts";

const text = z.string().min(1).max(1024);
const secret = text.regex(/^[^\r\n]+$/);
const transactionId = z.string().regex(/^\d{5,10}$/);
const success = <T extends z.ZodType>(response: T) => z.object({ successful: z.literal(true), response });
const reference = success(z.object({ transactionId: identifier }));
const methodType = z.enum(["POSTPAID", "INSTALLMENT", "FINANCING"]);
const item = z.object({
  id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), name: text, category: text,
  amount: rial, count: z.number().int().positive().max(1_000_000), commissionType: z.literal(100),
});
const cart = z.object({
  cartId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cartItems: z.array(item).min(1).max(1000), isShipmentIncluded: z.boolean(), isTaxIncluded: z.boolean(),
  shippingAmount: rial, taxAmount: rial, totalAmount: rial,
});
const order = z.object({
  amount: rial, discountAmount: rial, externalSourceAmount: rial,
  cartList: z.array(cart).min(1).max(100), mobile: z.string().regex(/^09\d{9}$/),
  returnURL: text, transactionId,
}).strict();
export type SnappayOrder = z.infer<typeof order>;
const attempt = z.object({ transactionId, paymentToken: secret, amount: rial,
  state: z.enum(["pending", "verified", "settled", "unknown"]) });
/** این Snapshot باید از قصد پایدار سمت سرور بیاید؛ callback منبع آن نیست. */
export type SnappayAttempt = z.infer<typeof attempt>;
export type SnappayState = "PENDING" | "VERIFY" | "SETTLE" | "CANCEL" | "REVERT";

export interface SnappayConfig {
  /** از پنل پذیرنده/محیط آزمایشی؛ میزبان پیش‌فرض حدس زده نمی‌شود. */
  baseUrl: string;
  channel: string;
  /** Originهای دقیق صفحهٔ پرداخت از تنظیم مورد اعتماد سمت سرور. */
  paymentPageOrigins: readonly string[];
  /** نشانی whitelist‌شدهٔ همین پذیرنده؛ هر سفارش باید دقیقاً همین مقدار را داشته باشد. */
  returnUrl: string;
  timeoutMs?: number;
}
export interface SnappayCredentials { clientId: string; clientSecret: string; username: string; password: string }
export type SnappayCallback = {
  kind: "untrusted_callback";
  transactionId: string;
  signal: "verify_candidate" | "review_required";
};

/** تکرار callback همان دادهٔ نامطمئن است؛ نه فراخوانی درگاه و نه ثبت وجه. */
export function parseSnappayCallback(method: string, body: unknown, stored: SnappayAttempt): SnappayCallback {
  assertContract(method === "POST");
  const expected = input(attempt, stored);
  const parsed = input(z.object({ transactionId, state: z.enum(["OK", "FAILED"]), amount: rial }), body);
  assertContract(parsed.transactionId === expected.transactionId && BigInt(parsed.amount) === BigInt(expected.amount));
  return { kind: "untrusted_callback", transactionId: parsed.transactionId,
    signal: parsed.state === "OK" ? "verify_candidate" : "review_required" };
}

export class SnappayClient {
  readonly #config: SnappayConfig;
  readonly #transport: ProviderTransport;
  readonly #origin: string;
  readonly #returnUrl: string;
  readonly #paymentOrigins: Set<string>;
  constructor(config: SnappayConfig, transport: ProviderTransport) {
    requireSupportedChannel("snappay", config.channel);
    const base = new URL(httpsUrl(config.baseUrl));
    if (base.pathname !== "/" || base.search || !config.paymentPageOrigins.length ||
      (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 30_000))) {
      throw new ProviderContractError("invalid_configuration");
    }
    this.#origin = base.origin;
    this.#returnUrl = httpsUrl(config.returnUrl);
    this.#paymentOrigins = new Set(config.paymentPageOrigins.map(raw => {
      const url = new URL(httpsUrl(raw));
      if (url.pathname !== "/" || url.search) throw new ProviderContractError("invalid_configuration");
      return url.origin;
    }));
    this.#config = { ...config };
    this.#transport = transport;
  }

  async authenticate(credentials: SnappayCredentials): Promise<ProviderResult<{ accessToken: string; expiresIn: number }>> {
    const c = input(z.object({ clientId: secret, clientSecret: secret, username: secret, password: secret }), credentials);
    assertContract(!c.clientId.includes(":"));
    const result = await exchange(this.#transport, {
      method: "POST", url: `${this.#origin}/api/online/v1/oauth/token`,
      headers: { Authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", scope: "online-merchant", username: c.username, password: c.password }).toString(),
    }, z.object({ access_token: secret, token_type: z.literal("bearer"), expires_in: z.number().int().positive() }), this.#config.timeoutMs);
    return result.kind === "ok" ? { kind: "ok", value: { accessToken: result.value.access_token, expiresIn: result.value.expires_in } } : result;
  }

  async eligible(accessToken: string, amount: string, methods: z.infer<typeof methodType>[] = []) {
    const money = input(rial, amount);
    const types = input(z.array(methodType).max(3), methods);
    const query = new URLSearchParams({ amount: money });
    if (types.length) query.set("paymentMethodTypes", types.join(","));
    const result = await this.#request(accessToken, "GET", `/api/online/offer/v1/eligible?${query}`,
      success(z.object({ eligible: z.boolean(), title_message: z.string().max(2000), description: z.string().max(4000) })));
    return result.kind === "ok" ? { kind: "ok" as const, value: result.value.response } : result;
  }

  async createToken(accessToken: string, raw: SnappayOrder) {
    const data = input(order, raw);
    assertContract(BigInt(data.amount) > 0n && httpsUrl(data.returnURL) === this.#returnUrl);
    let total = 0n;
    for (const basket of data.cartList) {
      const items = basket.cartItems.reduce((sum, entry) => sum + BigInt(entry.amount) * BigInt(entry.count), 0n);
      const expected = items + (basket.isShipmentIncluded ? 0n : BigInt(basket.shippingAmount)) +
        (basket.isTaxIncluded ? 0n : BigInt(basket.taxAmount));
      assertContract(expected === BigInt(basket.totalAmount));
      total += expected;
    }
    assertContract(total - BigInt(data.discountAmount) - BigInt(data.externalSourceAmount) === BigInt(data.amount));
    const body = { ...data, amount: BigInt(data.amount), discountAmount: BigInt(data.discountAmount),
      externalSourceAmount: BigInt(data.externalSourceAmount), cartList: data.cartList.map(basket => ({
        ...basket, shippingAmount: BigInt(basket.shippingAmount), taxAmount: BigInt(basket.taxAmount),
        totalAmount: BigInt(basket.totalAmount), cartItems: basket.cartItems.map(entry => ({ ...entry, amount: BigInt(entry.amount) })),
      })) };
    const result = await this.#request(accessToken, "POST", "/api/online/payment/v1/token",
      success(z.object({ paymentToken: secret, paymentPageUrl: text })), body);
    if (result.kind !== "ok") return result;
    try {
      const page = new URL(httpsUrl(result.value.response.paymentPageUrl));
      if (!this.#paymentOrigins.has(page.origin)) return { kind: "unknown" as const, reason: "response" as const };
      return { kind: "ok" as const, value: { ...result.value.response, paymentPageUrl: page.href, state: "pending" as const } };
    } catch { return { kind: "unknown" as const, reason: "response" as const }; }
  }

  async verify(accessToken: string, stored: SnappayAttempt) {
    const current = input(attempt, stored);
    assertContract(current.state === "pending");
    const result = await this.#reference(accessToken, "verify", current);
    return result.kind === "ok" ? { kind: "ok" as const, value: { state: "verified" as const, requires: "settle" as const } } : result;
  }

  async settle(accessToken: string, stored: SnappayAttempt) {
    const current = input(attempt, stored);
    assertContract(current.state === "verified");
    const result = await this.#reference(accessToken, "settle", current);
    return result.kind === "ok" ? { kind: "ok" as const, value: { state: "settled" as const } } : result;
  }

  async status(accessToken: string, stored: SnappayAttempt): Promise<ProviderResult<{ state: SnappayState }>> {
    const current = input(attempt, stored);
    const query = new URLSearchParams({ paymentToken: current.paymentToken });
    const result = await this.#request(accessToken, "GET", `/api/online/payment/v1/status?${query}`,
      success(z.object({ transactionId: identifier, status: z.enum(["PENDING", "VERIFY", "SETTLE", "CANCEL", "REVERT"]), amount: rial })));
    if (result.kind !== "ok") return result;
    const response = result.value.response;
    if (response.transactionId !== current.transactionId || BigInt(response.amount) !== BigInt(current.amount)) {
      return { kind: "unknown", reason: "response" };
    }
    return { kind: "ok", value: { state: response.status } };
  }

  async cancel(accessToken: string, stored: SnappayAttempt) {
    const current = input(attempt, stored);
    assertContract(current.state === "settled");
    const result = await this.#reference(accessToken, "cancel", current);
    return result.kind === "ok" ? { kind: "ok" as const, value: { state: "cancelled" as const } } : result;
  }

  /** متن Revert متعارض است و به تأیید پشتیبانی نیاز دارد. */
  revert(): never { throw new ProviderContractError("unsupported"); }
  /** Update در این برش مستقل پیاده نشده؛ قصد پایدار تعدیل مبلغ هنوز لازم است. */
  update(): never { throw new ProviderContractError("unsupported"); }

  async #reference(accessToken: string, action: "verify" | "settle" | "cancel", stored: SnappayAttempt) {
    const result = await this.#request(accessToken, "POST", `/api/online/payment/v1/${action}`, reference, { paymentToken: stored.paymentToken });
    if (result.kind === "ok" && result.value.response.transactionId !== stored.transactionId) {
      return { kind: "unknown" as const, reason: "response" as const };
    }
    return result;
  }

  #request<T>(accessToken: string, method: "GET" | "POST", path: string, schema: z.ZodType<T>, body?: unknown) {
    const token = input(secret, accessToken);
    return exchange(this.#transport, { method, url: this.#origin + path,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: wireJson(body) }),
    }, schema, this.#config.timeoutMs);
  }
}
