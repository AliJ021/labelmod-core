import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";
import { AuthService } from "../src/auth/service.ts";
import { hashSecret, verifySecret } from "../src/auth/password.ts";
import { SmsFactorService, deliverSmsChallenge } from "../src/auth/sms-factor.ts";
import { encryptMeliKey } from "../src/platform/melipayamak-credential.ts";
import { buildApp } from "../src/http/app.ts";
import { loadConfig } from "../src/lib/config.ts";
import { HANDLERS } from "../src/worker/handlers.ts";
import { readNotifySettings } from "../src/worker/settings.ts";

const URL = process.env.DATABASE_URL;
const MASTER = "12".repeat(32), PASSWORD = "test-only-password-sms-2026";
const config = loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal", SMS_CREDENTIAL_KEY: MASTER });
const BRANCH = "00000000-0000-7000-8000-000000000001";
describe("PIN شخصی و عامل دوم پیامکی روی دیتابیس واقعی", { skip: URL ? false : "DATABASE_URL لازم است" }, () => {
  let disposable: DisposableDb, handle: DbHandle, app: FastifyInstance, service: SmsFactorService, hash: string;
  let seq = 0, actor = "";
  const ip = () => `10.91.${Math.floor(++seq / 200)}.${seq % 200 + 1}`;
  before(async () => {
    const d = createDisposableDb(URL!); assert.ok(d); disposable = d;
    handle = createDb(d.url, 8); hash = await hashSecret(PASSWORD);
    app = await buildApp({ db: handle.db, auth: new AuthService(handle.db), config }); await app.ready();
    service = new SmsFactorService(handle.db, config);
    actor = (await person()).id;
    await setting("notify.sms_enabled", true);
    await setting("notify.sms_provider", "melipayamak");
    await setting("notify.sms_sender", "500000000");
    await sql`UPDATE platform.melipayamak_credential SET encrypted_key=${JSON.stringify(encryptMeliKey("test-provider-key", MASTER))}::jsonb WHERE singleton`.execute(handle.db);
  });
  after(async () => { await app?.close(); await handle?.close(); disposable?.drop(); });
  async function setting(name:string,value:unknown) {
    await sql`SELECT platform.set_setting(${name},${JSON.stringify(value)}::jsonb,'آزمون',${actor}::uuid)`.execute(handle.db);
  }
  async function person(role = "admin") {
    const username = "sms_test_" + ++seq;
    const u = await handle.db.insertInto("identity.app_user").values({
      username, full_name: "آزمون پیامک", password_hash: hash, is_active: true,
      mobile: null, pin_hash: null, totp_secret: null,
    }).returning("id").executeTakeFirstOrThrow();
    await handle.db.insertInto("identity.user_role").values({ user_id: u.id, role_code: role, branch_id: BRANCH }).execute();
    const r = await login(username); assert.equal(r.statusCode, 200, r.body);
    const csrf = r.cookies.find(c => c.name === "labelmod_csrf")!.value;
    const token = r.cookies.find(c => c.name === "labelmod_session")!.value;
    const resolved = await new AuthService(handle.db).resolve(token); assert.ok(resolved);
    return { id: u.id, username, sessionId: resolved.sessionId,
      cookies: { labelmod_session: token, labelmod_csrf: csrf }, headers: { "x-csrf-token": csrf },
      mobile: "0912" + String(seq).padStart(7, "0") };
  }
  function login(username: string) {
    return app.inject({ method: "POST", url: "/auth/login", payload: { username, password: PASSWORD }, remoteAddress: ip() });
  }
  type Person = Awaited<ReturnType<typeof person>>;
  function post(p: Person, url: string, payload: unknown) {
    return app.inject({ method: "POST", url, cookies: p.cookies, headers: p.headers, payload: payload as object, remoteAddress: ip() });
  }
  async function queued(p: Person, purpose: "enroll" | "login" = "enroll", bind = p.sessionId, address = ip()) {
    await service.request({ userId: p.id, purpose, binding: bind, sessionId: p.sessionId, currentPassword: PASSWORD, mobile: p.mobile, ip: address });
    return deliver(p.id);
  }
  async function deliver(userId: string) {
    const r = await sql<{ id: string; encrypted_code: unknown }>`SELECT id,encrypted_code FROM identity.sms_challenge WHERE user_id=${userId}::uuid ORDER BY created_at DESC LIMIT 1`.execute(handle.db);
    const row = r.rows[0]!; let code = "";
    await deliverSmsChallenge(handle.db, row.id, { send: async (_to, text) => { code = text.match(/\b\d{6}\b/)![0]; } }, MASTER);
    assert.match(code, /^\d{6}$/);
    const stored = await sql<{ encrypted_code: unknown; code_hash: string }>`SELECT encrypted_code,code_hash FROM identity.sms_challenge WHERE id=${row.id}::uuid`.execute(handle.db);
    assert.equal(stored.rows[0]!.encrypted_code, null);
    assert.notEqual(stored.rows[0]!.code_hash, code);
    const outbox = await sql<{ payload: unknown }>`SELECT payload FROM platform.outbox_message WHERE topic='auth.sms_otp' AND payload->>'challengeId'=${row.id}`.execute(handle.db);
    assert.deepEqual(outbox.rows.map(r => r.payload), [{ challengeId: row.id }]);
    return { id: row.id, code };
  }
  async function enroll(p: Person) { const c = await queued(p); assert.equal(await service.confirmEnrollment(p.id, p.sessionId, c.code), true); return c; }
  test("ثبت، تغییر و حذف PIN فقط با رمز فعلی؛ خطا PIN قبلی را عوض نمی‌کند", async () => {
    const p = await person("cashier");
    const status = await app.inject({ method: "GET", url: "/auth/pin", cookies: p.cookies }); assert.equal(status.json().hasPin, false);
    const bad = await post(p, "/auth/pin", { pin: "1234", currentPassword: "wrong-password" }); assert.equal(bad.statusCode, 401);
    const good = await post(p, "/auth/pin", { pin: "1234", currentPassword: PASSWORD }); assert.equal(good.statusCode, 200, good.body);
    const updated = await post(p, "/auth/pin", { pin: "9876", currentPassword: PASSWORD }); assert.equal(updated.statusCode, 200, updated.body);
    const row = await handle.db.selectFrom("identity.app_user").select("pin_hash").where("id","=",p.id).executeTakeFirstOrThrow();
    assert.ok(await verifySecret(row.pin_hash!, "9876")); assert.equal(await verifySecret(row.pin_hash!, "1234"), false);
    const csrf = await app.inject({ method:"POST",url:"/auth/pin",cookies:p.cookies,payload:{pin:null,currentPassword:PASSWORD},remoteAddress:ip() }); assert.equal(csrf.statusCode,403);
    const deleted = await post(p, "/auth/pin", { pin: null, currentPassword: PASSWORD }); assert.equal(deleted.statusCode, 200, deleted.body);
    assert.equal((await app.inject({method:"GET",url:"/auth/pin",cookies:p.cookies})).json().hasPin,false);
  });
  test("SMS تنها پس از تأیید شماره، عامل دوم است؛ نشست محدود ارتقا می‌یابد", async () => {
    const p = await person();
    const r = await post(p,"/auth/2fa/sms/enroll",{mobile:p.mobile,currentPassword:PASSWORD}); assert.equal(r.statusCode,200,r.body);
    assert.equal((await service.status(p.id)).enabled,false);
    const c = await deliver(p.id);
    const confirmed = await post(p,"/auth/2fa/sms/confirm",{code:c.code}); assert.equal(confirmed.statusCode,200,confirmed.body);
    assert.equal((await app.inject({method:"GET",url:"/auth/me",cookies:p.cookies})).json().enrollmentRequired,false);
    assert.equal((await service.status(p.id)).enabled,true);
    const again = await login(p.username); assert.equal(again.json().needsSecondFactor,true);
    assert.deepEqual(again.json().methods,["sms"]); assert.ok(!again.cookies.some(c=>c.name==="labelmod_session"));
  });
  test("ورود پیامکی واقعی مسیر API، رقابت دو مصرف و بازپخش فقط یک نشست می‌سازند", async () => {
    const p=await person(); await enroll(p);
    const pending=await login(p.username), token=pending.cookies.find(c=>c.name==="labelmod_pending")!.value;
    const cookies={labelmod_pending:token};
    const send=await app.inject({method:"POST",url:"/auth/2fa/sms/request",cookies,payload:{},remoteAddress:ip()}); assert.equal(send.statusCode,200,send.body);
    const c=await deliver(p.id);
    const results=await Promise.all([1,2].map(()=>app.inject({method:"POST",url:"/auth/2fa/sms",cookies,payload:{code:c.code},remoteAddress:ip()})));
    assert.equal(results.filter(r=>r.statusCode===200).length,1,results.map(r=>r.body).join("\n"));
    assert.ok(results.find(r=>r.statusCode===200)!.cookies.some(c=>c.name==="labelmod_session"));
    const replay=await app.inject({method:"POST",url:"/auth/2fa/sms",cookies,payload:{code:c.code},remoteAddress:ip()}); assert.notEqual(replay.statusCode,200);
  });
  test("کد به حساب، نشست و هدف بسته است", async () => {
    const p=await person(), other=await person(), c=await queued(p);
    assert.equal(await service.confirmEnrollment(other.id,other.sessionId,c.code),false);
    assert.equal(await service.verifyLogin(p.id,p.sessionId,c.code),false);
    assert.equal(await service.confirmEnrollment(p.id,p.sessionId,c.code),true);
    assert.equal(await service.confirmEnrollment(p.id,p.sessionId,c.code),false);
  });
  test("سه کد اشتباه واقعاً ثبت می‌شوند و کد درست بعد از آن پذیرفته نمی‌شود",async()=>{
    const p=await person(),c=await queued(p),wrong=c.code==="000000"?"111111":"000000";
    for(let i=0;i<3;i++) assert.equal(await service.confirmEnrollment(p.id,p.sessionId,wrong),false);
    assert.equal(await service.confirmEnrollment(p.id,p.sessionId,c.code),false);
    const r=await sql<{attempts:number;used_at:Date}>`SELECT attempts,used_at FROM identity.sms_challenge WHERE id=${c.id}::uuid`.execute(handle.db);
    assert.equal(r.rows[0]!.attempts,3);assert.ok(r.rows[0]!.used_at);
  });
  test("انقضا و ارسال مجدد، کد قبلی را غیرقابل استفاده می‌کند",async()=>{
    const p=await person(),first=await queued(p),second=await queued(p);
    assert.equal(await service.confirmEnrollment(p.id,p.sessionId,first.code),false);
    await sql`UPDATE identity.sms_challenge SET expires_at=now()-interval '1 second' WHERE id=${second.id}::uuid`.execute(handle.db);
    assert.equal(await service.confirmEnrollment(p.id,p.sessionId,second.code),false);
  });
  test("سهمیه سه ارسال با درخواست هم‌زمان دور زده نمی‌شود",async()=>{
    const p=await person(),address=ip();
    const results=await Promise.allSettled([1,2,3,4,5].map(()=>service.request({userId:p.id,purpose:"enroll",binding:p.sessionId,sessionId:p.sessionId,currentPassword:PASSWORD,mobile:p.mobile,ip:address})));
    assert.equal(results.filter(r=>r.status==="fulfilled").length,3);
    assert.ok(results.filter(r=>r.status==="rejected").every(r=>r.reason.code==="locked"));
  });
  test("سهمیه IP بین حساب‌ها مشترک است",async()=>{
    const address=ip();
    for(let i=0;i<3;i++){const p=await person();await queued(p,"enroll",p.sessionId,address);}
    const p=await person();
    await assert.rejects(()=>queued(p,"enroll",p.sessionId,address),{code:"locked"});
  });
  test("غیرفعال‌کردن عامل، بلیت ورود قبلی را باطل می‌کند",async()=>{
    const p=await person();await enroll(p);
    const pending=await login(p.username),token=pending.cookies.find(c=>c.name==="labelmod_pending")!.value;
    const c=await queued(p,"login",token);
    const disabled=await post(p,"/auth/2fa/sms/disable",{currentPassword:PASSWORD});assert.equal(disabled.statusCode,200,disabled.body);
    const attempt=await app.inject({method:"POST",url:"/auth/2fa/sms",cookies:{labelmod_pending:token},payload:{code:c.code},remoteAddress:ip()});assert.notEqual(attempt.statusCode,200);
  });
  test("خرابی ارسال متن کد یا شماره را در خطای صف افشا نمی‌کند",async()=>{
    const p=await person();
    await service.request({userId:p.id,purpose:"enroll",binding:p.sessionId,sessionId:p.sessionId,currentPassword:PASSWORD,mobile:p.mobile,ip:ip()});
    const r=await sql<{id:string}>`SELECT id FROM identity.sms_challenge WHERE user_id=${p.id}::uuid`.execute(handle.db);
    await assert.rejects(()=>deliverSmsChallenge(handle.db,r.rows[0]!.id,{send:async(to,text)=>{throw new Error(to+text);}},MASTER),e=>{
      assert.ok(e instanceof Error);assert.ok(!e.message.includes(p.mobile));assert.ok(!/\d{6}/.test(e.message));return true;
    });
  });
  test("بدون کلید امن یا با ارسال log، فعال‌سازی fail-closed است",async()=>{
    const p=await person();
    const noKey=new SmsFactorService(handle.db,loadConfig({...process.env,NODE_ENV:"test",SMS_CREDENTIAL_KEY:""}));
    await assert.rejects(()=>noKey.request({userId:p.id,purpose:"enroll",binding:p.sessionId,sessionId:p.sessionId,currentPassword:PASSWORD,mobile:p.mobile,ip:ip()}),{code:"sms_unavailable"});
    await setting("notify.sms_provider","log");
    await assert.rejects(()=>queued(p),{code:"sms_unavailable"});
    const r=await sql<{n:string}>`SELECT count(*)::text AS n FROM identity.sms_challenge WHERE user_id=${p.id}::uuid`.execute(handle.db);assert.equal(r.rows[0]!.n,"0");
    await setting("notify.sms_provider","melipayamak");
  });
  test("نشست قفل‌شده یا کاربر غیرفعال نمی‌تواند چالش ثبت‌شده را تأیید کند",async()=>{
    const p=await person(),c=await queued(p);
    await sql`UPDATE identity.session SET locked_at=now() WHERE id=${p.sessionId}::uuid`.execute(handle.db);
    await assert.rejects(()=>service.confirmEnrollment(p.id,p.sessionId,c.code),{code:"no_session"});
    assert.equal((await service.status(p.id)).enabled,false);
    const inactive=await person(),d=await queued(inactive);
    await handle.db.updateTable("identity.app_user").set({is_active:false}).where("id","=",inactive.id).execute();
    await assert.rejects(()=>service.confirmEnrollment(inactive.id,inactive.sessionId,d.code),{code:"no_session"});
    assert.equal((await service.status(inactive.id)).enabled,false);
  });
  test("کد ورود یک بلیت در بلیت دیگری از همان حساب پذیرفته نمی‌شود",async()=>{
    const p=await person();await enroll(p);
    const a=(await login(p.username)).cookies.find(c=>c.name==="labelmod_pending")!.value;
    const b=(await login(p.username)).cookies.find(c=>c.name==="labelmod_pending")!.value;
    const c=await queued(p,"login",a);
    assert.equal(await service.verifyLogin(p.id,b,c.code),false);
    assert.equal(await service.verifyLogin(p.id,a,c.code),true);
  });
  test("ثبت شماره بدون CSRF یا با رمز غلط هیچ چالشی نمی‌سازد",async()=>{
    const p=await person();
    const noCsrf=await app.inject({method:"POST",url:"/auth/2fa/sms/enroll",cookies:p.cookies,payload:{mobile:p.mobile,currentPassword:PASSWORD},remoteAddress:ip()});
    assert.equal(noCsrf.statusCode,403);
    const bad=await post(p,"/auth/2fa/sms/enroll",{mobile:p.mobile,currentPassword:"incorrect"});assert.equal(bad.statusCode,401);
    const r=await sql<{n:string}>`SELECT count(*)::text AS n FROM identity.sms_challenge WHERE user_id=${p.id}::uuid`.execute(handle.db);
    assert.equal(r.rows[0]!.n,"0");
  });
  test("Worker کد منقضی را ارسال نمی‌کند و ciphertext آن را پاک می‌کند",async()=>{
    const p=await person();
    await service.request({userId:p.id,purpose:"enroll",binding:p.sessionId,sessionId:p.sessionId,currentPassword:PASSWORD,mobile:p.mobile,ip:ip()});
    const r=await sql<{id:string}>`UPDATE identity.sms_challenge SET expires_at=now()-interval '1 second' WHERE user_id=${p.id}::uuid RETURNING id`.execute(handle.db);
    let sent=0;
    const result=await HANDLERS["auth.sms_otp"]!({
      db:handle.db,settings:await readNotifySettings(handle.db),sms:{send:async()=>{sent++;}},smsCredentialKey:MASTER,
      webhook:{send:async()=>{throw new Error("نباید webhook فراخوانی شود");}},
      webPush:{send:async()=>{throw new Error("نباید Push فراخوانی شود");}},
    },{id:r.rows[0]!.id,topic:"auth.sms_otp",payload:{challengeId:r.rows[0]!.id},attempts:1});
    assert.equal(result.done,true);assert.equal(sent,0);
    const after=await sql<{encrypted_code:unknown}>`SELECT encrypted_code FROM identity.sms_challenge WHERE id=${r.rows[0]!.id}::uuid`.execute(handle.db);
    assert.equal(after.rows[0]!.encrypted_code,null);
  });
});
