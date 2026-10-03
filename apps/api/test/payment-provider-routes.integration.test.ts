import { before, after, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";
import { AuthService } from "../src/auth/service.ts";
import { hashSecret } from "../src/auth/password.ts";
import { newApiKey, hashApiKey } from "../src/auth/api-key.ts";
import { buildApp } from "../src/http/app.ts";
import { loadConfig } from "../src/lib/config.ts";
import { loginWithMfa } from "./helpers/login-with-mfa.ts";
import { PaymentProviderRuntime } from "../src/payments/providers/runtime.ts";

const DATABASE_URL=process.env.DATABASE_URL;
describe("مرز تشخیص اتصال درگاه",{skip:DATABASE_URL ? false : "DATABASE_URL تنظیم نشده"},()=>{
  let disposable: DisposableDb | null=null;
  let handle: DbHandle, app: FastifyInstance;
  let calls=0, address=30;
  const ids: Record<string,string>={};
  const sessions=new Map<string,{cookies:Record<string,string>;headers:Record<string,string>}>();
  const suffix=Date.now().toString(), password="رمز-آزمایشی-فقط-تشخیص-درگاه";
  const machineKey=newApiKey();
  async function login(who: string) {
    if(sessions.has(who)) return sessions.get(who)!;
    const response=await loginWithMfa(app,{method:"POST",url:"/auth/login",remoteAddress:`127.0.0.${++address}`,
      payload:{username:`provider_${who}_${suffix}`,password,deviceFingerprint:`provider-${who}-${suffix}`}});
    assert.equal(response.statusCode,200,response.body);
    const csrf=response.cookies.find(c=>c.name==="labelmod_csrf")!.value;
    const session={cookies:{labelmod_session:response.cookies.find(c=>c.name==="labelmod_session")!.value,labelmod_csrf:csrf},headers:{"x-csrf-token":csrf}};
    sessions.set(who,session); return session;
  }
  before(async()=>{
    disposable=createDisposableDb(DATABASE_URL!); if(!disposable) throw new Error("ساخت دیتابیس آزمایشی ناموفق بود");
    handle=createDb(disposable.url,5);
    const branch=await handle.db.selectFrom("platform.branch").select("id").where("code","=","MAIN").executeTakeFirstOrThrow();
    const hash=await hashSecret(password);
    for(const [who,role,scope] of [["global","admin",null],["branch","admin",branch.id],["cashier","cashier",branch.id]] as const) {
      const user=await handle.db.insertInto("identity.app_user").values({username:`provider_${who}_${suffix}`,full_name:"کاربر مصنوعی درگاه",
        password_hash:hash,is_active:true,mobile:null,pin_hash:null,totp_secret:null}).returning("id").executeTakeFirstOrThrow();
      ids[who]=user.id;
      await handle.db.insertInto("identity.user_role").values({user_id:user.id,role_code:role,branch_id:scope}).execute();
    }
    await handle.db.insertInto("identity.api_client").values({name:"کلید مصنوعی مدیر",user_id:ids.global!,key_hash:hashApiKey(machineKey),created_by:ids.global!}).execute();
    const runtime=new PaymentProviderRuntime({SNAPPAY_API_MODE:"diagnostic",SNAPPAY_API_BASE_URL:"https://provider.example",
      SNAPPAY_API_RETURN_URL:"https://merchant.example/callback",SNAPPAY_API_PAYMENT_ORIGINS:'["https://pay.example"]',
      SNAPPAY_API_CLIENT_ID:"fixture-client",SNAPPAY_API_CLIENT_SECRET:"fixture-private-secret",
      SNAPPAY_API_USERNAME:"fixture-user",SNAPPAY_API_PASSWORD:"fixture-private-password"},async()=>{
      calls++;return {status:200,body:'{"access_token":"fixture-private-token","token_type":"bearer","expires_in":300}'};
    });
    app=await buildApp({db:handle.db,auth:new AuthService(handle.db),config:loadConfig({...process.env,NODE_ENV:"test",LOG_LEVEL:"fatal"}),paymentProviders:runtime});
    await app.ready();
  });
  after(async()=>{await app?.close();await handle?.close();disposable?.drop();});

  test("آمادگی برای مدیر سراسری، بدون راز و بدون فعال‌شدن پرداخت آنلاین",async()=>{
    const response=await app.inject({method:"GET",url:"/payment-providers/readiness",...await login("global")});
    assert.equal(response.statusCode,200,response.body);
    assert.equal(response.json().snappay.api.configuration,"diagnostic_only");
    assert.equal(response.json().snappay.api.paymentIntegration,false);
    assert.equal(response.json().snappay.manualRecording.mode,"manual_reference");
    assert.equal(response.json().digipay.configuration,"unsupported");
    assert.doesNotMatch(response.body,/fixture-private|provider\.example|merchant\.example/);
    assert.equal(calls,0);
  });
  test("مهمان، صندوق‌دار، مدیر شعبه و کلید API حتی متعلق به مدیر رد می‌شوند",async()=>{
    const guest=await app.inject({method:"GET",url:"/payment-providers/readiness"}); assert.equal(guest.statusCode,401);
    for(const who of ["cashier","branch"]) {
      const auth=await login(who);
      assert.equal((await app.inject({method:"GET",url:"/payment-providers/readiness",...auth})).statusCode,403);
      const denied=await app.inject({method:"POST",url:"/payment-providers/snappay/diagnose",remoteAddress:`127.0.0.${++address}`,...auth,payload:{confirmed:true}});
      assert.equal(denied.statusCode,403,denied.body);
    }
    const machine=await app.inject({method:"POST",url:"/payment-providers/snappay/diagnose",remoteAddress:`127.0.0.${++address}`,
      headers:{authorization:`Bearer ${machineKey}`},payload:{confirmed:true}});
    assert.equal(machine.statusCode,403,machine.body);assert.equal(calls,0);
  });
  test("PIN یا بدنهٔ حاوی endpoint/credential اجازه تماس نمی‌دهد",async()=>{
    const auth=await login("global");
    const altered=await app.inject({method:"POST",url:"/payment-providers/snappay/diagnose",remoteAddress:`127.0.0.${++address}`,...auth,
      payload:{confirmed:true,baseUrl:"https://evil.example",password:"browser-secret"}});
    assert.equal(altered.statusCode,400,altered.body);
    await handle.db.updateTable("identity.session").set({pin_unlocked:true}).where("user_id","=",ids.global!).execute();
    try {
      const pin=await app.inject({method:"POST",url:"/payment-providers/snappay/diagnose",remoteAddress:`127.0.0.${++address}`,...auth,payload:{confirmed:true}});
      assert.equal(pin.statusCode,403,pin.body);assert.equal(calls,0);
    } finally {await handle.db.updateTable("identity.session").set({pin_unlocked:false}).where("user_id","=",ids.global!).execute();}
  });
  test("آزمون صریح احراز، توکن را دور می‌ریزد و هیچ receipt مالی نمی‌سازد",async()=>{
    const before=await handle.db.selectFrom("treasury.payment").select(({fn})=>fn.countAll().as("n")).executeTakeFirstOrThrow();
    const auth=await login("global");
    const response=await app.inject({method:"POST",url:"/payment-providers/snappay/diagnose",remoteAddress:`127.0.0.${++address}`,...auth,payload:{confirmed:true}});
    assert.equal(response.statusCode,200,response.body);assert.equal(response.json().status,"authenticated");
    assert.equal(response.json().paymentIntegration,false);assert.equal(calls,1);
    assert.doesNotMatch(response.body,/fixture-private|access_token|accessToken/);
    const digi=await app.inject({method:"POST",url:"/payment-providers/digipay/diagnose",remoteAddress:`127.0.0.${++address}`,...auth,payload:{confirmed:true}});
    assert.equal(digi.json().status,"unsupported");assert.equal(calls,1);
    const after=await handle.db.selectFrom("treasury.payment").select(({fn})=>fn.countAll().as("n")).executeTakeFirstOrThrow();
    assert.equal(after.n,before.n);
  });
});
