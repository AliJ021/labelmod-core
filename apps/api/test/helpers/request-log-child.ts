import assert from "node:assert/strict";
import { createDb } from "../../src/db/client.ts";
import { buildApp } from "../../src/http/app.ts";
import { AuthService } from "../../src/auth/service.ts";
import { loadConfig } from "../../src/lib/config.ts";

const db = createDb(process.env["DATABASE_URL"]!, 3);
const app = await buildApp({
  db: db.db,
  auth: new AuthService(db.db),
  config: loadConfig({ ...process.env, NODE_ENV: "production", LOG_LEVEL: "info" }),
});
const token = process.env["AUDIT_PUBLIC_TOKEN"]!;
const query = process.env["AUDIT_PRIVATE_QUERY"]!;
try {
  const invoice = await app.inject({ method: "GET", url: `/i/${token}` });
  assert.equal(invoice.statusCode, 200);
  const health = await app.inject({ method: "GET", url: `/health?token=${query}` });
  assert.equal(health.statusCode, 200);
  const login = await app.inject({
    method: "POST", url: "/auth/login",
    payload: { username: "request_log_admin", password: process.env["AUDIT_LOGIN_VALUE"], deviceFingerprint: "request-log-test" },
  });
  assert.equal(login.statusCode, 200);
  const cookies = Object.fromEntries(login.cookies.map((c) => [c.name, c.value]));
  const rejected = await app.inject({ method: "POST", url: `/auth/logout?token=${query}`, cookies });
  assert.equal(rejected.statusCode, 403);
  assert.equal(rejected.json().error.code, "csrf_failed");
  const missing = await app.inject({ method: "GET", url: `/missing/${token}?token=${query}`, cookies });
  assert.equal(missing.statusCode, 404);
  console.log(JSON.stringify({ auditCase: "requests_complete", statuses: [invoice.statusCode, health.statusCode, login.statusCode, rejected.statusCode, missing.statusCode] }));
} finally {
  await app.close();
  await db.close();
}
