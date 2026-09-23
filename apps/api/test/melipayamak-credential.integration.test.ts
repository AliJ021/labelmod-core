import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";
import { buildApp } from "../src/http/app.ts";
import { AuthService } from "../src/auth/service.ts";
import { hashSecret } from "../src/auth/password.ts";
import { loadConfig } from "../src/lib/config.ts";
import { loginWithMfa } from "./helpers/login-with-mfa.ts";
import { decryptMeliKey, encryptMeliKey, readMeliKey } from "../src/platform/melipayamak-credential.ts";
import { tick } from "../src/worker/loop.ts";

const MASTER = "a1".repeat(32);
const SECRET = "only-test-melipayamak-api-key";
const PASSWORD = "Meli-test-password-long-enough";
const URL_PATH = "/settings/melipayamak-credential";
let disposable: DisposableDb;
let handle: DbHandle;
let app: FastifyInstance;
type Session = { cookies: Record<string, string>; headers: Record<string, string> };
const sessions: Record<string, Session> = {};

before(async () => {
  assert.ok(process.env.DATABASE_URL);
  const created = createDisposableDb(process.env.DATABASE_URL!); assert.ok(created); disposable = created;
  handle = createDb(created.url, 5);
  const password = await hashSecret(PASSWORD);
  for (const role of ["admin", "cashier"]) {
    const u = await sql<{ id: string }>`INSERT INTO identity.app_user(username,full_name,password_hash)
      VALUES(${`meli_${role}`},${`آزمون اتصال ${role}`},${password}) RETURNING id`.execute(handle.db);
    await sql`INSERT INTO identity.user_role(user_id,role_code,branch_id)
      VALUES(${u.rows[0]!.id}::uuid,${role},'00000000-0000-7000-8000-000000000001')`.execute(handle.db);
  }
  app = await buildApp({ db: handle.db, auth: new AuthService(handle.db),
    config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal", SMS_CREDENTIAL_KEY: MASTER }) });
  await app.ready();
  for (const role of ["admin", "cashier"]) {
    const r = await loginWithMfa(app, { method: "POST", url: "/auth/login",
      payload: { username: `meli_${role}`, password: PASSWORD, deviceFingerprint: `meli-test-${role}` } });
    assert.equal(r.statusCode, 200, r.body);
    const cookies = Object.fromEntries(r.cookies.map((c) => [c.name, c.value]));
    sessions[role] = { cookies, headers: { "x-csrf-token": cookies.labelmod_csrf! } };
  }
});
after(async () => { await app?.close(); await handle?.close(); disposable?.drop(); });
async function status() {
  const r = await app.inject({ method: "GET", url: URL_PATH, ...sessions.admin });
  assert.equal(r.statusCode, 200, r.body); return r.json() as { revision: number; hasKey: boolean; accountName: string };
}
async function save(payload: Record<string, unknown>, session = sessions.admin!) {
  return app.inject({ method: "PUT", url: URL_PATH, ...session, payload });
}

test("اعتبارنامه: رمزگذاری تصادفی و رد کلید اصلی غلط یا ciphertext دست‌کاری‌شده", () => {
  const a = encryptMeliKey(SECRET, MASTER); const b = encryptMeliKey(SECRET, MASTER);
  assert.notDeepEqual(a, b); assert.ok(!JSON.stringify(a).includes(SECRET));
  assert.equal(decryptMeliKey(a, MASTER), SECRET);
  assert.throws(() => decryptMeliKey(a, "b2".repeat(32)));
  assert.throws(() => decryptMeliKey({ ...a, ciphertext: "00" }, MASTER));
  assert.throws(() => encryptMeliKey(SECRET, undefined));
});
test("اعتبارنامه: بی‌نشست، بدون مجوز یا بدون CSRF نمی‌توان کلید را نوشت", async () => {
  const payload = { revision: 0, accountName: "آزمون", apiKey: SECRET };
  assert.equal((await app.inject({ method: "PUT", url: URL_PATH, payload })).statusCode, 401);
  assert.equal((await save(payload, sessions.cashier)).statusCode, 403);
  assert.equal((await app.inject({ method: "PUT", url: URL_PATH, cookies: sessions.admin!.cookies, payload })).statusCode, 403);
  assert.equal((await status()).hasKey, false);
});
test("اعتبارنامه: ذخیره و چرخش کلید، بدون راز در پاسخ یا حسابرسی", async () => {
  const current = await status();
  const r = await save({ revision: current.revision, accountName: "پنل آزمون", apiKey: SECRET });
  assert.equal(r.statusCode, 200, r.body); assert.ok(!r.body.includes(SECRET));
  assert.equal(await readMeliKey(handle.db, MASTER), SECRET);
  const raw = await sql<{ value: unknown }>`SELECT to_jsonb(t) value FROM platform.melipayamak_credential t`.execute(handle.db);
  assert.ok(!JSON.stringify(raw.rows).includes(SECRET));
  const audit = await sql<{ value: unknown }>`SELECT to_jsonb(t) value FROM platform.audit_log t WHERE entity='melipayamak'`.execute(handle.db);
  assert.ok(audit.rows.length > 0); assert.ok(!JSON.stringify(audit.rows).includes(SECRET));
  assert.ok(!JSON.stringify(audit.rows).includes("ciphertext"));
  const next = await save({ revision: r.json().revision, accountName: "پنل جدید", apiKey: `${SECRET}-rotated` });
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(await readMeliKey(handle.db, MASTER), `${SECRET}-rotated`);
});
test("اعتبارنامه: تغییر نام بدون فرستادن کلید، کلید را حفظ می‌کند", async () => {
  const s = await status();
  const r = await save({ revision: s.revision, accountName: "نام تازه" });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(await readMeliKey(handle.db, MASTER), `${SECRET}-rotated`);
});
test("اعتبارنامه: دو ویرایش هم‌زمان یکدیگر را بی‌صدا بازنویسی نمی‌کنند", async () => {
  const s = await status();
  const r = await Promise.all([save({ revision: s.revision, accountName: "اول" }), save({ revision: s.revision, accountName: "دوم" })]);
  assert.deepEqual(r.map((v) => v.statusCode).sort(), [200, 409]);
});
test("اعتبارنامه: نشست PIN اجازهٔ تغییر کلید ندارد", async () => {
  const s = await status();
  await sql`UPDATE identity.session SET pin_unlocked=true`.execute(handle.db);
  try { assert.equal((await save({ revision: s.revision, accountName: "ردشده", apiKey: SECRET })).statusCode, 403); }
  finally { await sql`UPDATE identity.session SET pin_unlocked=false`.execute(handle.db); }
});
test("اعتبارنامه: حذف صریح، راز را حذف می‌کند و ارسال خودکار فعال نمی‌شود", async () => {
  const before = await sql`SELECT key,value FROM platform.setting WHERE key IN ('notify.sms_enabled','notify.sms_provider') ORDER BY key`.execute(handle.db);
  const s = await status(); const r = await save({ revision: s.revision, accountName: "", clearKey: true });
  assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().hasKey, false);
  assert.equal(await readMeliKey(handle.db, MASTER), "");
  const after = await sql`SELECT key,value FROM platform.setting WHERE key IN ('notify.sms_enabled','notify.sms_provider') ORDER BY key`.execute(handle.db);
  assert.deepEqual(after.rows, before.rows);
});
test("Worker: کلید پیامک ناقص صف Push مستقل را خراب نمی‌کند", async () => {
  const actor = "00000000-0000-7000-8000-0000000000f1";
  await sql`SELECT platform.set_setting('notify.sms_provider','"melipayamak"'::jsonb,'آزمون',${actor}::uuid)`.execute(handle.db);
  // Push خاموش است و handler باید طبق قرارداد همان پیام را بی‌اثر تکمیل کند؛ نه به علت کلید SMS بمیراند.
  const row = await sql<{ id: string }>`INSERT INTO platform.outbox_message(topic,payload)
    VALUES('web.stock_push','{"variationId":"00000000-0000-7000-8000-000000000123"}') RETURNING id`.execute(handle.db);
  await tick({ db: handle.db, workerName: "meli-isolation-test", smsApiKey: "", smsCredentialKey: MASTER,
    webhookToken: undefined, webPushSecret: undefined, batchSize: 100, leaseSeconds: 120, log: () => {} });
  const state = await sql<{ status: string }>`SELECT status FROM platform.outbox_message WHERE id=${row.rows[0]!.id}::bigint`.execute(handle.db);
  assert.equal(state.rows[0]!.status, "sent");
});
