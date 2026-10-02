import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ClientRequest } from "node:http";
import type https from "node:https";
import { PaymentProviderRuntime } from "../src/payments/providers/runtime.ts";
import { createProviderHttpsTransport, isPublicProviderAddress } from "../src/payments/providers/https-transport.ts";
import type { ProviderRequest } from "../src/payments/providers/contract.ts";

const env = { SNAPPAY_API_MODE: "diagnostic", SNAPPAY_API_BASE_URL: "https://provider.example",
  SNAPPAY_API_RETURN_URL: "https://merchant.example/callback", SNAPPAY_API_PAYMENT_ORIGINS: '["https://pay.example"]',
  SNAPPAY_API_CLIENT_ID: "synthetic-client", SNAPPAY_API_CLIENT_SECRET: "synthetic-secret",
  SNAPPAY_API_USERNAME: "synthetic-user", SNAPPAY_API_PASSWORD: "synthetic-password" };

test("پیکربندی پیش‌فرض خاموش است؛ ناقص/خراب هیچ اتصال و هیچ افشای راز ندارد", async () => {
  let calls=0;
  const transport = async () => { calls++; throw new Error("private-raw-error"); };
  for (const config of [{}, { ...env,SNAPPAY_API_MODE:"disabled" }, { ...env,SNAPPAY_API_PASSWORD:"" },
    { ...env,SNAPPAY_API_BASE_URL:"http://provider.example" }, { ...env,SNAPPAY_API_BASE_URL:"https://127.0.0.1" },
    { ...env,SNAPPAY_API_PAYMENT_ORIGINS:"invalid-secret-json" }, { ...env,SNAPPAY_API_TIMEOUT_MS:"30001" },
    { ...env,SNAPPAY_API_CLIENT_SECRET:"line\nbreak" }, { ...env,SNAPPAY_API_MODE:"live" }]) {
    const runtime = new PaymentProviderRuntime(config,transport);
    assert.equal(runtime.readiness(true).snappay.manualRecording.enabled,true);
    assert.equal(runtime.readiness(true).snappay.api.paymentIntegration,false);
    assert.equal(runtime.readiness(true).snappay.api.diagnosticAvailable,false);
    await runtime.diagnose("snappay");
    assert.equal(JSON.stringify(runtime),"{}");
    assert.doesNotMatch(JSON.stringify(runtime.readiness(false)),/synthetic-secret|synthetic-password|provider\.example|invalid-secret-json/);
  }
  assert.equal(calls,0);
});

test("تشخیص فقط احراز را می‌سنجد؛ توکن و خطای خام برنمی‌گردد و retry ندارد", async () => {
  const calls: ProviderRequest[]=[];
  const runtime = new PaymentProviderRuntime(env,async request => {
    calls.push(request);
    return {status:200,body:'{"access_token":"private-issued-token","token_type":"bearer","expires_in":300}'};
  });
  assert.equal(runtime.readiness(false).snappay.api.configuration,"diagnostic_only");
  assert.equal(calls.length,0);
  const result = await runtime.diagnose("snappay");
  assert.equal(result.status,"authenticated"); assert.equal(result.paymentIntegration,false);
  assert.equal(calls.length,1); assert.equal(new URL(calls[0]!.url).pathname,"/api/online/v1/oauth/token");
  assert.doesNotMatch(JSON.stringify(result),/private-issued-token|synthetic-/);
  assert.equal((await runtime.diagnose("digipay")).status,"unsupported"); assert.equal(calls.length,1);
  let failed=0;
  const broken = new PaymentProviderRuntime(env,async ()=>{failed++; throw new Error("secret credential body");});
  const unknown = await broken.diagnose("snappay");
  assert.equal(unknown.status,"unknown"); assert.equal(failed,1);
  assert.doesNotMatch(JSON.stringify(unknown),/secret credential/);
});

function network(status=200,chunks=["{}"],headers: Record<string,string>={}) {
  const seen: Array<{ url: URL; options: https.RequestOptions; body: unknown }>=[];
  const request = ((url: URL,options: https.RequestOptions,callback: (response: IncomingMessage)=>void) => {
    const emitter = new EventEmitter();
    return Object.assign(emitter,{ end(body: unknown) {
      seen.push({url,options,body});
      queueMicrotask(()=>callback(Object.assign(Readable.from(chunks.map(c=>Buffer.from(c))),{ statusCode:status,headers }) as IncomingMessage));
      return emitter;
    } }) as ClientRequest;
  }) as typeof https.request;
  return {request,seen};
}
const request = (): ProviderRequest => ({method:"POST",url:"https://provider.example/api/online/v1/oauth/token",
  headers:{Authorization:"Basic synthetic-value","Content-Type":"application/x-www-form-urlencoded"},body:"synthetic-body",
  signal:new AbortController().signal,redirect:"error"});

test("انتقال واقعی به یک origin و DNS عمومی پین می‌شود و TLS تأییدشده دارد", async () => {
  const fake=network(); let lookups=0;
  const transport=createProviderHttpsTransport("https://provider.example",{request:fake.request,
    resolve:async()=>{lookups++;return [{address:"93.184.216.34",family:4}];}});
  assert.deepEqual(await transport(request()),{status:200,body:"{}"});
  assert.equal(fake.seen.length,1); assert.equal(lookups,1);
  const options=fake.seen[0]!.options;
  assert.equal(options.rejectUnauthorized,true); assert.equal(options.minVersion,"TLSv1.3"); assert.equal(options.agent,false);
  assert.equal(options.family,4);
  options.lookup!("untrusted-second-resolution.example",{},(error,address,family)=>{
    assert.equal(error,null);assert.equal(address,"93.184.216.34");assert.equal(family,4);
  });
  await assert.rejects(transport({...request(),url:"https://other.example/private"}),/ارتباط امن/);
  assert.equal(fake.seen.length,1);
});

test("DNS خصوصی/ترکیبی، redirect، پاسخ حجیم و قطع درخواست هیچ retry یا افشای بدنه ندارد", async () => {
  for (const address of ["127.0.0.1","10.2.3.4","169.254.169.254","100.64.0.1","::1","::ffff:127.0.0.1","fc00::1","fe80::1","2001:db8::1"])
    assert.equal(isPublicProviderAddress(address),false,address);
  assert.equal(isPublicProviderAddress("2606:4700:4700::1111"),true);
  const fake=network();
  const denied=createProviderHttpsTransport("https://provider.example",{request:fake.request,
    resolve:async()=>[{address:"93.184.216.34",family:4},{address:"127.0.0.1",family:4}]});
  await assert.rejects(denied(request()),/ارتباط امن/); assert.equal(fake.seen.length,0);
  for (const mock of [network(302,["sensitive-body"],{location:"https://other.example"}),network(200,["x".repeat(262145)]),network(200,["x"],{"content-encoding":"gzip"})]) {
    const transport=createProviderHttpsTransport("https://provider.example",{request:mock.request,resolve:async()=>[{address:"93.184.216.34",family:4}]});
    await assert.rejects(transport(request()),error=>error instanceof Error && error.message==="ارتباط امن درگاه کامل نشد");
    assert.equal(mock.seen.length,1);
  }
  const controller=new AbortController();
  const hanging=createProviderHttpsTransport("https://provider.example",{request:fake.request,resolve:()=>new Promise(()=>{})});
  const pending=hanging({...request(),signal:controller.signal}); controller.abort();
  await assert.rejects(pending,/ارتباط امن/); assert.equal(fake.seen.length,0);
});
