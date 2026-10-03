import { before,after,test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as waitForDeadline } from "node:timers/promises";
import { sql } from "kysely";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";
const skip=process.env.DATABASE_URL ? false : "DATABASE_URL تنظیم نشده";
let disposable:DisposableDb|null=null,handle:DbHandle,actor:string,invoice:string;
before(async()=>{
 if(skip)return;
 disposable=createDisposableDb(process.env.DATABASE_URL!);assert.ok(disposable);handle=createDb(disposable.url,5);
 actor=(await sql<{id:string}>`INSERT INTO identity.app_user(username,full_name) VALUES (${'intent_'+randomUUID()},'آزمون قصد') RETURNING id`.execute(handle.db)).rows[0]!.id;
 await sql`INSERT INTO identity.user_role(user_id,role_code) VALUES(${actor}::uuid,'admin')`.execute(handle.db);
 const product=(await sql<{id:string}>`INSERT INTO catalog.product(code,name_internal) VALUES (${'I-'+randomUUID()},'کالا') RETURNING id`.execute(handle.db)).rows[0]!.id;
 const variation=(await sql<{id:string}>`INSERT INTO catalog.variation(product_id,sku) VALUES(${product}::uuid,${randomUUID()}) RETURNING id`.execute(handle.db)).rows[0]!.id;
 invoice=(await sql<{id:string}>`INSERT INTO sales.invoice(branch_id,warehouse_id,channel,created_by) SELECT branch_id,id,'web',${actor}::uuid FROM inventory.warehouse WHERE code='STORE' LIMIT 1 RETURNING id`.execute(handle.db)).rows[0]!.id;
 await sql`INSERT INTO sales.invoice_line(invoice_id,line_no,variation_id,qty,unit_price,net_amount) VALUES(${invoice}::uuid,1,${variation}::uuid,1,100000,100000)`.execute(handle.db);
});
after(async()=>{await handle?.close();disposable?.drop();});
test("قرارداد SQL: snapshot بزرگ، immutability، callback، unknown و بدون رسید",{skip},async()=>{
 await handle.db.connection().execute(async connection=>{await sql.raw(readFileSync(new URL("../../../db/test/provider-intents.sql",import.meta.url),"utf8")).execute(connection);});
});
test("قصد و claim هم‌زمان فقط یک برنده دارند و crash تلاش تازه نمی‌سازد",{skip},async()=>{
 const key=randomUUID();
 const create=()=>sql<{id:string}>`SELECT sales.create_provider_intent(${invoice}::uuid,'snappay',${key}::uuid,${'a'.repeat(64)},${actor}::uuid) id`.execute(handle.db);
 const [a,b]=await Promise.all([create(),create()]);const id=a.rows[0]!.id;assert.equal(id,b.rows[0]!.id);
 const claim=()=>sql<{id:string}>`SELECT sales.claim_provider_intent(${id}::uuid,0,'token',${actor}::uuid) id`.execute(handle.db);
 const claims=await Promise.allSettled([claim(),claim()]);assert.equal(claims.filter(c=>c.status==='fulfilled').length,1);
 const accepted=claims.find(c=>c.status==='fulfilled');assert.ok(accepted?.status==='fulfilled');const token=accepted.value.rows[0]!.id;
 await sql`SELECT sales.finish_provider_intent(${id}::uuid,1,${token}::uuid,'unknown','{}',${actor}::uuid)`.execute(handle.db);
 await assert.rejects(sql`SELECT sales.claim_provider_intent(${id}::uuid,2,'token',${actor}::uuid)`.execute(handle.db));
 await assert.rejects(sql`SELECT sales.claim_provider_intent(${id}::uuid,2,'status',${actor}::uuid)`.execute(handle.db));
 await assert.rejects(sql`SELECT sales.create_provider_intent(${invoice}::uuid,'snappay',${randomUUID()}::uuid,${'a'.repeat(64)},${actor}::uuid)`.execute(handle.db));
 assert.equal((await create()).rows[0]!.id,id);
 if(process.env.LMC_TEST_DB_ROLE==='app') await assert.rejects(sql`INSERT INTO sales.provider_intent_event(intent_id,version,state,operation,actor_id) VALUES(${id}::uuid,3,'settled_evidence','settle',${actor}::uuid)`.execute(handle.db));
 await assert.rejects(sql`SELECT sales.claim_provider_intent(${id}::uuid,2,'status',${randomUUID()}::uuid)`.execute(handle.db));
});
test("claim پس از قطع اتصال پایدار می‌ماند و انقضای واقعی فقط unknown می‌سازد",{skip,timeout:45000},async()=>{
 const key=randomUUID();
 const id=(await sql<{id:string}>`SELECT sales.create_provider_intent(${invoice}::uuid,'digipay',${key}::uuid,${'b'.repeat(64)},${actor}::uuid) id`.execute(handle.db)).rows[0]!.id;
 await sql`SELECT sales.claim_provider_intent(${id}::uuid,0,'token',${actor}::uuid)`.execute(handle.db);
 await handle.close();handle=createDb(disposable!.url,5);
 const deadline=(await sql<{ms:number}>`SELECT ceil(greatest(extract(epoch FROM expires_at-clock_timestamp())*1000,0))::integer ms FROM sales.provider_intent_event WHERE intent_id=${id}::uuid AND version=1`.execute(handle.db)).rows[0]!.ms;
 // انتظار تا مهلت واقعی همین claim؛ زمان‌بندی تولید یا retry شبکه‌ای وجود ندارد.
 await waitForDeadline(deadline+25);
 await sql`SELECT sales.expire_provider_intent(${id}::uuid,1,${actor}::uuid)`.execute(handle.db);
 const row=(await sql<{state:string}>`SELECT state FROM sales.provider_intent_event WHERE intent_id=${id}::uuid ORDER BY version DESC LIMIT 1`.execute(handle.db)).rows[0]!;
 assert.equal(row.state,'unknown');
 await assert.rejects(sql`SELECT sales.claim_provider_intent(${id}::uuid,2,'token',${actor}::uuid)`.execute(handle.db));
});
