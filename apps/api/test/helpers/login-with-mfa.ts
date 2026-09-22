import assert from "node:assert/strict";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { totp } from "../../src/auth/totp.ts";

const secrets = new Map<string, string>();

/** ورود واقعی fixture تجاری؛ سیاست MFA خاموش نمی‌شود و عامل دوم واقعاً تأیید می‌شود. */
export async function loginWithMfa(app: FastifyInstance, options: InjectOptions): Promise<LightMyRequestResponse> {
  const response = await app.inject(options);
  if (response.statusCode !== 200) return response;
  const payload = options.payload as { username: string; deviceFingerprint?: string };
  const body = response.json();
  const cookies = Object.fromEntries(response.cookies.map(c => [c.name, c.value]));
  const remoteAddress = options.remoteAddress ?? "127.0.0.1";
  if (body.enrollmentRequired) {
    const headers = { "x-csrf-token": cookies.labelmod_csrf! };
    const begin = await app.inject({ method: "POST", url: "/auth/2fa/totp/begin", cookies, headers, remoteAddress, payload: {} });
    assert.equal(begin.statusCode, 200, begin.body);
    const secret = begin.json().secret as string;
    const confirm = await app.inject({ method: "POST", url: "/auth/2fa/totp/confirm", cookies, headers, remoteAddress, payload: { code: totp(secret) } });
    assert.equal(confirm.statusCode, 200, confirm.body);
    secrets.set(payload.username, secret);
    const me = await app.inject({ method: "GET", url: "/auth/me", cookies });
    assert.equal(me.statusCode, 200, me.body);
    assert.equal(me.json().enrollmentRequired, false);
    return response;
  }
  if (body.needsSecondFactor) {
    const secret = secrets.get(payload.username);
    assert.ok(secret, "راز fixture باید از ثبت واقعی MFA آمده باشد");
    const verified = await app.inject({ method: "POST", url: "/auth/2fa/totp", cookies, remoteAddress,
      payload: { code: totp(secret), deviceFingerprint: payload.deviceFingerprint } });
    assert.equal(verified.statusCode, 200, verified.body);
    return verified;
  }
  return response;
}
