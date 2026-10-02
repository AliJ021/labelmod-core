import { z } from "zod";
import { ProviderContractError, type ProviderTransport } from "./contract.ts";
import { createProviderHttpsTransport } from "./https-transport.ts";
import { SnappayClient, type SnappayCredentials } from "./snappay.ts";

const requiredKeys = ["SNAPPAY_API_BASE_URL","SNAPPAY_API_RETURN_URL","SNAPPAY_API_PAYMENT_ORIGINS",
  "SNAPPAY_API_CLIENT_ID","SNAPPAY_API_CLIENT_SECRET","SNAPPAY_API_USERNAME","SNAPPAY_API_PASSWORD"] as const;
const secret = z.string().min(1).max(1024).regex(/^[^\r\n]+$/);
const credentials = z.object({ clientId: secret.refine(v=>!v.includes(":")), clientSecret: secret, username: secret, password: secret });
type Configuration = "disabled" | "incomplete" | "invalid" | "diagnostic_only";

/** کلیدها فیلد خصوصی‌اند؛ JSON و خروجی آمادگی هیچ راز، میزبان یا توکنی ندارند. */
export class PaymentProviderRuntime {
  readonly #state: Configuration;
  readonly #missing: readonly string[];
  readonly #client: SnappayClient | undefined;
  readonly #credentials: SnappayCredentials | undefined;

  constructor(env: NodeJS.ProcessEnv, transport?: ProviderTransport) {
    this.#missing = [];
    if (!env.SNAPPAY_API_MODE || env.SNAPPAY_API_MODE === "disabled") { this.#state="disabled"; return; }
    if (env.SNAPPAY_API_MODE !== "diagnostic") { this.#state="invalid"; return; }
    this.#missing = requiredKeys.filter(key=>!env[key]);
    if (this.#missing.length) { this.#state="incomplete"; return; }
    try {
      const parsed = credentials.safeParse({ clientId: env.SNAPPAY_API_CLIENT_ID, clientSecret: env.SNAPPAY_API_CLIENT_SECRET,
        username: env.SNAPPAY_API_USERNAME, password: env.SNAPPAY_API_PASSWORD });
      if (!parsed.success) throw new ProviderContractError("invalid_configuration");
      const origins = z.array(z.string()).min(1).max(10).parse(JSON.parse(env.SNAPPAY_API_PAYMENT_ORIGINS!));
      const timeoutMs = env.SNAPPAY_API_TIMEOUT_MS === undefined ? 10000 : Number(env.SNAPPAY_API_TIMEOUT_MS);
      const realTransport = createProviderHttpsTransport(env.SNAPPAY_API_BASE_URL!);
      this.#client = new SnappayClient({ baseUrl: env.SNAPPAY_API_BASE_URL!, returnUrl: env.SNAPPAY_API_RETURN_URL!,
        paymentPageOrigins: origins, channel: "online", timeoutMs }, transport ?? realTransport);
      this.#credentials = parsed.data;
      this.#state="diagnostic_only";
    } catch { this.#state="invalid"; }
  }

  readiness(manualSnappayEnabled: boolean) {
    return { snappay: { manualRecording: { enabled: manualSnappayEnabled, mode: "manual_reference" },
      api: { configuration: this.#state, missing: this.#missing, authentication: "not_checked",
        diagnosticAvailable: this.#state==="diagnostic_only", paymentIntegration: false, productionReady: false,
        channels: { online: "adapter_only", pos: "unsupported", paymentLink: "unsupported" },
        blockers: ["durable_intent_not_integrated","stage_contract_validation_required"] } },
      digipay: { configuration: "unsupported", paymentIntegration: false, productionReady: false,
        blockers: ["official_contract_unavailable"] } };
  }

  /** فقط فراخوانی صریح تشخیص؛ توکن دور ریخته می‌شود و موفقیت احراز، پرداخت نیست. */
  async diagnose(provider: "snappay" | "digipay") {
    if (provider !== "snappay") return { status: "unsupported", paymentIntegration: false };
    if (!this.#client || !this.#credentials || this.#state!=="diagnostic_only")
      return { status: this.#state, paymentIntegration: false };
    const result = await this.#client.authenticate(this.#credentials);
    return { status: result.kind === "ok" ? "authenticated" : "unknown",
      ...(result.kind === "unknown" ? { reason: result.reason } : {}), paymentIntegration: false,
      checkedAt: new Date().toISOString() };
  }
}
