import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { sql } from "kysely";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { AuthService } from "../src/auth/service.ts";
import { hashSecret } from "../src/auth/password.ts";
import { buildApp } from "../src/http/app.ts";
import { loadConfig } from "../src/lib/config.ts";
import { loginWithMfa } from "./helpers/login-with-mfa.ts";
import { InvoiceService } from "../src/sales/invoice.ts";
import { handleInvoiceFinalized } from "../src/worker/handlers.ts";
import { readNotifySettings } from "../src/worker/settings.ts";
import { drainDbOnClose } from "./helpers/drained-db.ts";

const root = path.resolve(fileURLToPath(import.meta.url), "../../../..");
const adminUrl = process.env.DATABASE_URL;
const BR = "00000000-0000-7000-8000-000000000001";
const WH = "00000000-0000-7000-8000-000000000101";
const ACTOR = "00000000-0000-7000-8000-0000000000f1";

describe("شمارهٔ عددی فاکتور: مهاجرت، هم‌زمانی و برگشت تراکنش", { skip: adminUrl ? false : "DATABASE_URL تنظیم نشده" }, () => {
  const name = `labelmod_numeric_${randomBytes(6).toString("hex")}`;
  const role = `lmc_numeric_${randomBytes(6).toString("hex")}`;
  let admin: DbHandle; let owner: DbHandle; let app: DbHandle;
  const legacy: Array<{ id: string; number: string }> = [];
  let beforeInvoices: unknown; let beforeAudit: unknown;
  let branch2: string; let wh2: string; let variation: string;
  const restricted = process.env.LMC_TEST_DB_ROLE === "app";

  before(async () => {
    admin = drainDbOnClose(createDb(adminUrl!, 1));
    await sql.raw(`CREATE DATABASE ${name}`).execute(admin.db);
    const url = new URL(adminUrl!); url.pathname = `/${name}`;
    owner = drainDbOnClose(createDb(url.toString(), 4));
    // این آزمون عمداً ارتقای دادهٔ ۰۹۴ را می‌سنجد؛ بقیه آزمون‌ها runner کانونی را اجرا می‌کنند.
    for (const file of readdirSync(path.join(root,"db/migrations")).sort().filter(f => f.endsWith(".sql") && f < "095"))
      await sql.raw(readFileSync(path.join(root,"db/migrations",file),"utf8")).execute(owner.db);
    for (const file of readdirSync(path.join(root,"db/seed")).sort().filter(f => f.endsWith(".sql")))
      await sql.raw(readFileSync(path.join(root,"db/seed",file),"utf8")).execute(owner.db);
    branch2 = (await sql<{id:string}>`INSERT INTO platform.branch(code,name) VALUES('NUM2','شعبه آزمون') RETURNING id`.execute(owner.db)).rows[0]!.id;
    wh2 = (await sql<{id:string}>`INSERT INTO inventory.warehouse(branch_id,code,name) VALUES(${branch2}::uuid,'NUM2','انبار آزمون') RETURNING id`.execute(owner.db)).rows[0]!.id;
    const product = (await sql<{id:string}>`INSERT INTO catalog.product(code,name_internal) VALUES('NUM','کالای آزمون') RETURNING id`.execute(owner.db)).rows[0]!.id;
    variation = (await sql<{id:string}>`INSERT INTO catalog.variation(product_id,sku) VALUES(${product}::uuid,'NUM') RETURNING id`.execute(owner.db)).rows[0]!.id;
    const customer=(await sql<{id:string}>`INSERT INTO sales.customer(full_name,mobile_normalized,consent_sms)
      VALUES('مشتری ۲','+989121234567',true) RETURNING id`.execute(owner.db)).rows[0]!.id;
    for (const [index,status] of ['finalized','paid','partially_returned','returned','cancelled'].entries()) {
      const number = index === 0 ? '9007199254740993' : `F-1405-${index}`;
      const row = (await sql<{id:string;number:string}>`INSERT INTO sales.invoice(branch_id,warehouse_id,number,status)
        VALUES(${BR}::uuid,${WH}::uuid,${number},'draft') RETURNING id,number`.execute(owner.db)).rows[0]!;
      await sql`INSERT INTO sales.invoice_line(invoice_id,line_no,variation_id,qty,unit_price,net_amount) VALUES(${row.id}::uuid,1,${variation}::uuid,1,100,100)`.execute(owner.db);
      await sql`UPDATE sales.invoice SET status=${status},customer_id=${customer}::uuid WHERE id=${row.id}::uuid`.execute(owner.db);
      legacy.push(row);
    }
    legacy.push((await sql<{id:string;number:string}>`INSERT INTO sales.invoice(branch_id,warehouse_id,number,status)
      VALUES(${branch2}::uuid,${wh2}::uuid,'9007199254740993','finalized') RETURNING id,number`.execute(owner.db)).rows[0]!);
    await sql`SELECT platform.audit('invoice.finalize','invoice',${legacy[0]!.id},'{"number":"9007199254740993"}'::jsonb,${ACTOR}::uuid)`.execute(owner.db);
    beforeInvoices = (await sql`SELECT to_jsonb(i) AS row FROM sales.invoice i ORDER BY id`.execute(owner.db)).rows;
    beforeAudit = (await sql`SELECT to_jsonb(a) AS row FROM platform.audit_log a ORDER BY id`.execute(owner.db)).rows;
    await sql.raw(readFileSync(path.join(root,"db/migrations/095_numeric_invoice_numbers.sql"),"utf8")).execute(owner.db);
    if (restricted) {
      execFileSync("bash",[path.join(root,"ops/db-roles.sh")],{cwd:root,stdio:"pipe",env:{...process.env,DATABASE_URL:url.toString(),APP_ROLE:role,APP_PASSWORD:"numeric-test-only",PGCLIENTENCODING:"UTF8"}});
      url.username=role; url.password="numeric-test-only";
    }
    app = drainDbOnClose(createDb(url.toString(), 5));
    await sql`INSERT INTO catalog.price(variation_id,price_list,amount) VALUES(${variation}::uuid,'default',100)`.execute(app.db);
    for (const wh of [WH,wh2]) await sql`SELECT inventory.apply_movement(${variation}::uuid,${wh}::uuid,10,'purchase_receipt','test_receipt',${variation}::uuid,${ACTOR}::uuid,50)`.execute(app.db);
  });
  after(async () => {
    if (app) await app.close(); if (owner) await owner.close();
    if (admin) {
      // اتصال نشت‌کرده باید teardown را بشکند، نه با FORCE پنهان شود.
      await sql.raw(`DROP DATABASE IF EXISTS ${name}`).execute(admin.db);
      if (restricted) await sql.raw(`DROP ROLE IF EXISTS ${role}`).execute(admin.db);
      await admin.close();
    }
  });
  test("همهٔ سندهای شماره‌دار نگاشت دارند، شمارهٔ قدیمی و زنجیره حسابرسی تغییر نمی‌کنند", async () => {
    assert.deepEqual((await sql`SELECT to_jsonb(i) AS row FROM sales.invoice i ORDER BY id`.execute(app.db)).rows,beforeInvoices);
    // پس از مهاجرت، آماده‌سازی کالا حسابرسی تازه می‌افزاید؛ پیشوند تاریخی دقیقاً حفظ می‌شود.
    const audit = (await sql`SELECT to_jsonb(a) AS row FROM platform.audit_log a ORDER BY id`.execute(app.db)).rows;
    assert.deepEqual(audit.slice(0,(beforeAudit as unknown[]).length),beforeAudit);
    const numbers = [];
    for (const row of legacy) {
      const current = await new InvoiceService(app.db).byId(row.id);
      assert.match(current!.number!, /^[1-9][0-9]*$/);
      assert.ok(BigInt(current!.number!)>9007199254740993n);
      numbers.push(current!.number);
    }
    assert.equal(new Set(numbers).size,legacy.length);
    assert.equal((await sql`SELECT * FROM platform.audit_check`.execute(app.db)).rows.length,0);
  });
  test("API شمارهٔ قدیمی و فارسی را در همان شعبه می‌یابد و همهٔ خواندن‌ها عدد یکسان دارند", async () => {
    const password="numeric-test-password-long";
    const hash=await hashSecret(password);
    const user=(await sql<{id:string}>`INSERT INTO identity.app_user(username,full_name,password_hash) VALUES('numeric-reader','کاربر آزمون',${hash}) RETURNING id`.execute(app.db)).rows[0]!.id;
    await sql`INSERT INTO identity.user_role(user_id,role_code,branch_id) VALUES(${user}::uuid,'supervisor',${BR}::uuid)`.execute(app.db);
    const http=await buildApp({db:app.db,auth:new AuthService(app.db),config:loadConfig({...process.env,NODE_ENV:"test",LOG_LEVEL:"fatal"})});
    try {
      const login=await loginWithMfa(http,{method:"POST",url:"/auth/login",payload:{username:'numeric-reader',password,deviceFingerprint:'numeric-reader'}});
      assert.equal(login.statusCode,200,login.body);
      const cookies=Object.fromEntries(login.cookies.map(c=>[c.name,c.value]));
      for(const old of legacy.slice(0,2)) {
        const number=(await new InvoiceService(app.db).byId(old.id))!.number!;
        const fa=number.replace(/[0-9]/g,d=>"۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
        const ar=number.replace(/[0-9]/g,d=>"٠١٢٣٤٥٦٧٨٩"[Number(d)]!);
        for(const q of [old.number,number,fa,ar]) {
          const found=await http.inject({method:'GET',url:`/invoices/lookup?branchId=${BR}&number=${encodeURIComponent(q)}`,cookies});
          assert.equal(found.statusCode,200,found.body);assert.equal(found.json().id,old.id);assert.equal(found.json().number,number);
        }
        const list=await http.inject({method:'GET',url:`/invoices?search=${encodeURIComponent(old.number)}`,cookies});
        assert.equal(list.statusCode,200,list.body);assert.equal(list.json().rows.find((r:{id:string})=>r.id===old.id).number,number);
        const print=await http.inject({method:'GET',url:`/invoices/${old.id}/print`,cookies});
        assert.equal(print.statusCode,200,print.body);assert.match(print.body,new RegExp('class="docno">'+number+'<'));
      }
      const named=await http.inject({method:'GET',url:`/invoices?search=${encodeURIComponent('مشتری ۲')}`,cookies});
      assert.equal(named.statusCode,200);assert.equal(named.json().rows.length,5);
      const historical=legacy[1]!;
      const number=(await new InvoiceService(app.db).byId(historical.id))!.number!;
      const messages:string[]=[]; const links:string[]=[];
      await handleInvoiceFinalized({db:app.db,settings:{...await readNotifySettings(app.db),invoiceSms:true,publicUrl:'https://example.test'},
        sms:{send:async (_to,text)=>{messages.push(text);}},
        webhook:{send:async payload=>{assert.equal(payload.kind,'invoice');if(payload.kind==='invoice'){assert.equal(payload.invoiceNumber,number);links.push(payload.link);}}},
        webPush:{send:async ()=>{throw new Error('unexpected web push');}},
      },{id:'1',topic:'invoice.finalized',payload:{invoice_id:historical.id,number:historical.number},attempts:0});
      assert.equal(messages.length,1);assert.ok(messages[0]!.includes(`فاکتور ${number} ثبت شد`));
      assert.ok(!messages[0]!.includes(historical.number));assert.equal(links.length,1);
      const publicPage=await http.inject({method:'GET',url:new URL(links[0]!).pathname});
      assert.equal(publicPage.statusCode,200);assert.match(publicPage.body,new RegExp('class="docno">'+number+'<'));
      const other=(await new InvoiceService(app.db).byId(legacy.at(-1)!.id))!.number!;
      assert.equal((await http.inject({method:'GET',url:`/invoices/lookup?branchId=${BR}&number=${other}`,cookies})).statusCode,404);
      assert.equal((await http.inject({method:'GET',url:`/invoices/lookup?branchId=${branch2}&number=${other}`,cookies})).statusCode,403);
    } finally { await http.close(); }
  });
  async function draft(branch=BR, warehouse=WH) {
    const id=(await sql<{id:string}>`INSERT INTO sales.invoice(branch_id,warehouse_id,channel,created_by)
      VALUES(${branch}::uuid,${warehouse}::uuid,'web',${ACTOR}::uuid) RETURNING id`.execute(app.db)).rows[0]!.id;
    await sql`INSERT INTO sales.invoice_line(invoice_id,line_no,variation_id,qty,unit_price,net_amount)
      VALUES(${id}::uuid,1,${variation}::uuid,1,100,100)`.execute(app.db);
    await sql`INSERT INTO treasury.payment(invoice_id,method_code,amount,status) VALUES(${id}::uuid,'cash',100,'succeeded')`.execute(app.db);
    return id;
  }
  test("شکست پس از تخصیص، شماره و خروج کالا و پیام را با هم برمی‌گرداند", async () => {
    const id=await draft();
    const before=(await sql`SELECT last_value::text FROM sales.invoice_number_counter`.execute(app.db)).rows;
    await assert.rejects(app.db.transaction().execute(async trx => {
      const number=(await sql<{number:string}>`SELECT sales.finalize_invoice(${id}::uuid,${ACTOR}::uuid) AS number`.execute(trx)).rows[0]!.number;
      assert.match(number,/^[0-9]+$/);
      throw new Error('rollback-number');
    }),/rollback-number/);
    assert.deepEqual((await sql`SELECT last_value::text FROM sales.invoice_number_counter`.execute(app.db)).rows,before);
    assert.equal((await new InvoiceService(app.db).byId(id))!.number,null);
    assert.equal((await sql`SELECT * FROM inventory.stock_movement WHERE ref_id=${id}::uuid`.execute(app.db)).rows.length,0);
    assert.equal((await sql`SELECT * FROM platform.outbox_message WHERE payload->>'invoice_id'=${id}`.execute(app.db)).rows.length,0);
    const number=(await sql<{number:string}>`SELECT sales.finalize_invoice(${id}::uuid,${ACTOR}::uuid) AS number`.execute(app.db)).rows[0]!.number;
    assert.equal(BigInt(number),BigInt((before[0] as {last_value:string}).last_value)+1n);
  });
  test("دو شعبهٔ هم‌زمان شمارهٔ مستقل می‌گیرند؛ replay همان سند همان شماره است", async () => {
    const ids=await Promise.all([draft(),draft(branch2,wh2)]);
    const numbers=await Promise.all(ids.map(async id => (await sql<{number:string}>`SELECT sales.finalize_invoice(${id}::uuid,${ACTOR}::uuid) AS number`.execute(app.db)).rows[0]!.number));
    assert.notEqual(numbers[0],numbers[1]);
    for (const [index,id] of ids.entries()) {
      assert.equal((await sql<{number:string}>`SELECT sales.finalize_invoice(${id}::uuid,${ACTOR}::uuid) AS number`.execute(app.db)).rows[0]!.number,numbers[index]);
      assert.equal((await app.db.selectFrom('sales.invoice').select('number').where('id','=',id).executeTakeFirstOrThrow()).number,numbers[index]);
      assert.equal((await sql<{n:string}>`SELECT count(*)::text AS n FROM inventory.stock_movement WHERE ref_id=${id}::uuid AND kind='sale'`.execute(app.db)).rows[0]!.n,'1');
      const payload=(await sql<{payload:{number:string}}>`SELECT payload FROM platform.outbox_message WHERE topic='invoice.finalized' AND payload->>'invoice_id'=${id}`.execute(app.db)).rows[0]!.payload;
      assert.equal(payload.number,numbers[index]);
    }
  });
  test("نگاشت قابل بازنویسی نیست؛ نقش محدود به شمارنده دسترسی نوشتن ندارد", async () => {
    await assert.rejects(sql`UPDATE sales.invoice_number SET number='1' WHERE invoice_id=${legacy[0]!.id}::uuid`.execute(app.db));
    await assert.rejects(sql`DELETE FROM sales.invoice_number WHERE invoice_id=${legacy[0]!.id}::uuid`.execute(app.db));
    if (restricted) {
      await assert.rejects(sql`UPDATE sales.invoice_number_counter SET last_value=0`.execute(app.db),/permission denied/);
      await assert.rejects(sql`INSERT INTO sales.invoice_number(invoice_id,number) VALUES(${legacy[0]!.id}::uuid,'1')`.execute(app.db),/permission denied/);
    }
  });
  test("سال مالی تازه شمارنده را از نو آغاز نمی‌کند و نهایی‌سازی هم‌زمان یک سند تکراری نمی‌سازد", async () => {
    await sql`INSERT INTO ledger.fiscal_year(id,starts_on,ends_on,status) VALUES(1406,'2027-03-21','2028-03-19','open')`.execute(app.db);
    const id=await draft();
    await sql`UPDATE sales.invoice SET occurred_at='2027-04-01T12:00:00Z' WHERE id=${id}::uuid`.execute(app.db);
    const before=(await sql<{n:string}>`SELECT last_value::text AS n FROM sales.invoice_number_counter`.execute(app.db)).rows[0]!.n;
    const numbers=await Promise.all([1,2].map(async ()=>
      (await sql<{n:string}>`SELECT sales.finalize_invoice(${id}::uuid,${ACTOR}::uuid) AS n`.execute(app.db)).rows[0]!.n));
    assert.equal(numbers[0],numbers[1]);assert.equal(BigInt(numbers[0]!),BigInt(before)+1n);
    assert.equal((await sql<{n:string}>`SELECT count(*)::text AS n FROM inventory.stock_movement WHERE ref_id=${id}::uuid AND kind='sale'`.execute(app.db)).rows[0]!.n,'1');
  });
});
