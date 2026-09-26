import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { Client } from "pg";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { buildApp } from "../src/http/app.ts";
import { AuthService } from "../src/auth/service.ts";
import { hashSecret } from "../src/auth/password.ts";
import { loadConfig } from "../src/lib/config.ts";
import { loginWithMfa } from "./helpers/login-with-mfa.ts";

describe("posting branch scope and concurrent finalization",{skip:!process.env.DATABASE_URL},()=>{
  let disposable:DisposableDb,handle:DbHandle,app:FastifyInstance;
  const branch="00000000-0000-7000-8000-000000000001",warehouse="00000000-0000-7000-8000-000000000101";
  let otherBranch:string,otherWarehouse:string,actor:string,variation:string;
  let session:{cookies:Record<string,string>;headers:Record<string,string>};
  before(async()=>{
    const made=createDisposableDb(process.env.DATABASE_URL!);assert.ok(made);disposable=made;handle=createDb(made.url,8);
    app=await buildApp({db:handle.db,auth:new AuthService(handle.db),config:loadConfig({...process.env,NODE_ENV:"test",LOG_LEVEL:"fatal"})});
    await app.ready();
    const username="posting_scope_"+randomUUID(),password="posting-test-password-only";
    actor=(await sql<{id:string}>`INSERT INTO identity.app_user(username,full_name,password_hash) VALUES(${username},'Posting scope test',${await hashSecret(password)}) RETURNING id`.execute(handle.db)).rows[0]!.id;
    await sql`INSERT INTO identity.user_role(user_id,role_code,branch_id) VALUES(${actor}::uuid,'admin',${branch}::uuid)`.execute(handle.db);
    const login=await loginWithMfa(app,{method:"POST",url:"/auth/login",payload:{username,password,deviceFingerprint:username}});
    assert.equal(login.statusCode,200,login.body);
    const cookies=Object.fromEntries(login.cookies.map(c=>[c.name,c.value]));session={cookies,headers:{"x-csrf-token":cookies.labelmod_csrf!}};
    otherBranch=(await sql<{id:string}>`INSERT INTO platform.branch(code,name) VALUES('POST-OTHER','Other posting branch') RETURNING id`.execute(handle.db)).rows[0]!.id;
    await sql`INSERT INTO platform.document_counter(branch_id,doc_type,fiscal_year,prefix)
      SELECT ${otherBranch}::uuid,doc_type,fiscal_year,'OTHER-'||prefix FROM platform.document_counter WHERE branch_id=${branch}::uuid`.execute(handle.db);
    otherWarehouse=(await sql<{id:string}>`INSERT INTO inventory.warehouse(branch_id,code,name,kind) VALUES(${otherBranch}::uuid,'POST-OTHER','Other warehouse','store') RETURNING id`.execute(handle.db)).rows[0]!.id;
    const product=(await sql<{id:string}>`INSERT INTO catalog.product(code,name_internal) VALUES('POST-RACE','Posting race') RETURNING id`.execute(handle.db)).rows[0]!.id;
    variation=(await sql<{id:string}>`INSERT INTO catalog.variation(product_id,sku,color,size) VALUES(${product}::uuid,'POST-RACE','black','M') RETURNING id`.execute(handle.db)).rows[0]!.id;
    for(const wh of [warehouse,otherWarehouse])await sql`SELECT inventory.apply_movement(${variation}::uuid,${wh}::uuid,30,'opening',NULL,NULL,${actor}::uuid,100000)`.execute(handle.db);
  });
  after(async()=>{await app?.close();await handle?.close();disposable?.drop();});
  async function invoice(days:number,foreign=false) {
    const id=(await sql<{id:string}>`INSERT INTO sales.invoice(branch_id,warehouse_id,channel,created_by,occurred_at)
      VALUES(${foreign?otherBranch:branch}::uuid,${foreign?otherWarehouse:warehouse}::uuid,'web',${actor}::uuid,now()-make_interval(days=>${days})) RETURNING id`.execute(handle.db)).rows[0]!.id;
    await sql`INSERT INTO sales.invoice_line(invoice_id,line_no,variation_id,qty,unit_price,net_amount) VALUES(${id}::uuid,1,${variation}::uuid,1,200000,200000)`.execute(handle.db);
    await sql`INSERT INTO treasury.payment(invoice_id,method_code,amount) VALUES(${id}::uuid,'cash',200000)`.execute(handle.db);
    return id;
  }
  const finalize=(id:string)=>sql`SELECT sales.finalize_invoice(${id}::uuid,${actor}::uuid)`.execute(handle.db);
  async function batch(id:string) {return (await sql<{id:string}>`SELECT posting_batch_id id FROM sales.invoice WHERE id=${id}::uuid`.execute(handle.db)).rows[0]!.id;}
  test("bulk API closes only its actor's branches; explicit trusted scheduler remains global",async()=>{
    const own=await invoice(10),foreign=await invoice(10,true);await finalize(own);await finalize(foreign);
    const ownBatch=await batch(own),foreignBatch=await batch(foreign);
    const empty=await sql`SELECT * FROM sales.close_due_channel_days(${actor}::uuid,now(),ARRAY[]::uuid[])`.execute(handle.db);
    assert.deepEqual(empty.rows,[]);
    assert.equal((await sql<{status:string}>`SELECT status FROM ledger.posting_batch WHERE id=${ownBatch}::uuid`.execute(handle.db)).rows[0]!.status,"open");
    const response=await app.inject({method:"POST",url:"/posting-batches/close-due",...session,payload:{}});
    assert.equal(response.statusCode,200,response.body);
    const result=response.json();assert.ok(result.closed.some((r:{batchId:string})=>r.batchId===ownBatch));
    assert.ok([...result.closed,...result.skipped].every((r:{branchId:string})=>r.branchId===branch),"foreign branch IDs and posting outcomes must not leak");
    assert.equal((await sql<{status:string}>`SELECT status FROM ledger.posting_batch WHERE id=${foreignBatch}::uuid`.execute(handle.db)).rows[0]!.status,"open");
    await sql`SELECT * FROM sales.close_due_channel_days(${actor}::uuid)`.execute(handle.db);
    assert.equal((await sql<{status:string}>`SELECT status FROM ledger.posting_batch WHERE id=${foreignBatch}::uuid`.execute(handle.db)).rows[0]!.status,"posted");
  });
  test("a finalizer arriving after the closer lock rechecks posted state and leaves stock unchanged",async()=>{
    const first=await invoice(7);await finalize(first);const batchId=await batch(first),second=await invoice(7);
    const closer=new Client({connectionString:disposable.ownerUrl}),finisher=new Client({connectionString:disposable.url});
    await Promise.all([closer.connect(),finisher.connect()]);
    let finish:Promise<{error?:Error}>|undefined;
    try {
      const closePid=(await closer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      const finishPid=(await finisher.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      const stock=(await closer.query('SELECT on_hand::text AS qty FROM inventory.stock_balance WHERE variation_id=$1 AND warehouse_id=$2',[variation,warehouse])).rows[0].qty;
      await closer.query('BEGIN');await closer.query('SELECT * FROM ledger.posting_batch WHERE id=$1 FOR UPDATE',[batchId]);
      finish=finisher.query('SELECT sales.finalize_invoice($1,$2)',[second,actor]).then(()=>({}),error=>({error}));
      let blocked=false;
      for(let i=0;i<150;i++) {
        const r=await closer.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) blocked',[finishPid,closePid]);
        if(r.rows[0].blocked){blocked=true;break;}await pause(20);
      }
      await closer.query('SELECT * FROM sales.post_batch($1,$2)',[batchId,actor]);await closer.query('COMMIT');
      const result=await finish;
      assert.ok(blocked,'finalizer must wait at the batch boundary');assert.ok(result.error);assert.match(result.error.message,/دوره ثبت.*بسته/);
      assert.equal((await closer.query('SELECT on_hand::text AS qty FROM inventory.stock_balance WHERE variation_id=$1 AND warehouse_id=$2',[variation,warehouse])).rows[0].qty,stock);
      assert.equal((await closer.query('SELECT status FROM sales.invoice WHERE id=$1',[second])).rows[0].status,'draft');
    }finally{await closer.query('ROLLBACK');await finish;await Promise.all([closer.end(),finisher.end()]);}
  });
  test("closer waits for an in-flight finalizer and includes its revenue and COGS",async()=>{
    const first=await invoice(5);await finalize(first);const batchId=await batch(first),second=await invoice(5);
    const gate=new Client({connectionString:disposable.ownerUrl}),finisher=new Client({connectionString:disposable.url}),closer=new Client({connectionString:disposable.url});
    await Promise.all([gate.connect(),finisher.connect(),closer.connect()]);
    let finish:Promise<unknown>|undefined,close:Promise<unknown>|undefined;
    try {
      const gatePid=(await gate.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      const finishPid=(await finisher.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      const closePid=(await closer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      await gate.query('BEGIN');await gate.query('SELECT * FROM inventory.stock_balance WHERE variation_id=$1 AND warehouse_id=$2 FOR UPDATE',[variation,warehouse]);
      finish=finisher.query('SELECT sales.finalize_invoice($1,$2)',[second,actor]);
      async function blocked(pid:number,by:number) {
        const until=Date.now()+7000;
        while(Date.now()<until) {
          const r=await gate.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) blocked',[pid,by]);
          if(r.rows[0].blocked)return true;await pause(20);
        }return false;
      }
      assert.ok(await blocked(finishPid,gatePid),'finalizer really reached the stock gate');
      close=closer.query('SELECT * FROM sales.post_batch($1,$2)',[batchId,actor]);
      const serialized=await blocked(closePid,finishPid);
      await gate.query('COMMIT');await Promise.all([finish,close]);
      assert.ok(serialized,'batch posting must wait for the finalizer, not post an incomplete aggregate');
      const result=(await sql<{sales:string;cogs:string;n:number}>`SELECT
        (SELECT sum(credit)::text FROM ledger.journal_line WHERE entry_id=b.sale_entry_id AND account_code='4101') sales,
        (SELECT sum(debit)::text FROM ledger.journal_line WHERE entry_id=b.cogs_entry_id AND account_code='5101') cogs,
        (SELECT count(*)::int FROM sales.invoice WHERE posting_batch_id=b.id AND status='finalized') n
        FROM ledger.posting_batch b WHERE b.id=${batchId}::uuid`.execute(handle.db)).rows[0]!;
      assert.equal(result.sales,'400000');assert.equal(result.cogs,'200000');assert.equal(result.n,2);
    }finally{await gate.query('ROLLBACK');await Promise.allSettled([finish,close]);await Promise.all([gate.end(),finisher.end(),closer.end()]);}
  });
});
