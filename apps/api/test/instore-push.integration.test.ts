import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";
import { buildApp } from "../src/http/app.ts";
import { AuthService } from "../src/auth/service.ts";
import { hashApiKey, newApiKey } from "../src/auth/api-key.ts";
import { loadConfig } from "../src/lib/config.ts";
import { tick, type LoopOptions } from "../src/worker/loop.ts";

const BR = "00000000-0000-7000-8000-000000000001";
const WH = "00000000-0000-7000-8000-000000000101";
const ACTOR = "00000000-0000-7000-8000-0000000000f1";
let disposable: DisposableDb;
let owner: Client;
let writer: Client;
let handle: DbHandle;
let app: FastifyInstance;
let variation: string;
let customer: string;
const key = newApiKey();
const auth = { authorization: `Bearer ${key}` };

before(async () => {
  assert.ok(process.env.DATABASE_URL, "آزمون Push به دیتابیس مستقل نیاز دارد");
  const d = createDisposableDb(process.env.DATABASE_URL); assert.ok(d); disposable = d;
  owner = new Client({ connectionString: d.ownerUrl }); writer = new Client({ connectionString: d.url });
  await Promise.all([owner.connect(), writer.connect()]); handle = createDb(d.url);
  const product = (await owner.query("INSERT INTO catalog.product(code,name_internal) VALUES('INSTORE-PUSH','آزمون اعلان') RETURNING id")).rows[0].id;
  variation = (await owner.query("INSERT INTO catalog.variation(product_id,color,size,sku) VALUES($1,'آبی','M','INSTORE-PUSH-M') RETURNING id", [product])).rows[0].id;
  customer = (await owner.query("INSERT INTO sales.customer(mobile_normalized,full_name) VALUES('09121119988','آزمون اعلان') RETURNING id")).rows[0].id;
  await owner.query("SELECT inventory.apply_movement($1::uuid,$2::uuid,100,'purchase_receipt','test_receipt',$3::uuid,$3::uuid,600)", [variation, WH, ACTOR]);
  const user = (await owner.query("INSERT INTO identity.app_user(username,full_name,is_active) VALUES('api:instore_push','سایت آزمون',false) RETURNING id")).rows[0].id;
  await owner.query("INSERT INTO identity.user_role(user_id,role_code,branch_id) VALUES($1,'web',$2)", [user, BR]);
  await owner.query("INSERT INTO identity.api_client(name,user_id,key_hash,created_by) VALUES('آزمون',$1,$2,$3)", [user, hashApiKey(key), ACTOR]);
  await setting('web.push_enabled', true); await setting('web.site_url', 'https://shop.example.test');
  await setting('notify.sms_enabled', false);
  app = await buildApp({ db: handle.db, auth: new AuthService(handle.db), config: loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'fatal' }) });
  await app.ready();
});
after(async () => { await app?.close(); await handle?.close(); await writer?.end(); await owner?.end(); disposable?.drop(); });

async function setting(k: string, v: unknown) {
  await owner.query("SELECT platform.set_setting($1,$2::jsonb,'آزمون',$3::uuid)", [k, JSON.stringify(v), ACTOR]);
}
async function draft(channel = 'pos', customerId: string | null = customer, c = writer, item = variation, paid = true) {
  await c.query('SELECT platform.set_actor($1::uuid)', [ACTOR]);
  const id = (await c.query(`INSERT INTO sales.invoice(branch_id,warehouse_id,channel,customer_id,created_by)
    VALUES($1,$2,$3,$4,$5) RETURNING id`, [BR, WH, channel, customerId, ACTOR])).rows[0].id as string;
  await c.query(`INSERT INTO sales.invoice_line(invoice_id,line_no,variation_id,qty,unit_price,discount_amount,net_amount)
    VALUES($1,1,$2,1,1000,0,1000)`, [id, item]);
  await c.query('SELECT sales.refresh_invoice_totals($1::uuid)', [id]);
  if (paid) await c.query(`INSERT INTO treasury.payment(invoice_id,method_code,direction,amount,status,occurred_at)
    VALUES($1,'cash','in',1000,'succeeded',now())`, [id]);
  return id;
}
async function finalize(id: string, c = writer) { await c.query('SELECT sales.finalize_invoice($1::uuid,$2::uuid)', [id, ACTOR]); }
async function notices(id: string) { return (await owner.query("SELECT * FROM platform.outbox_message WHERE topic='web.instore_push' AND payload->>'invoiceId'=$1", [id])).rows; }
async function feed(id: string, branch = BR) {
  return app.inject({ method: 'GET', url: `/web/instore-purchases?branchId=${branch}&invoiceId=${id}`, headers: auth });
}

test('نهایی‌سازی یک اعلان بدون اطلاعات مشتری می‌سازد و replay اعلان دوم ندارد', async () => {
  const id = await draft(); assert.equal((await notices(id)).length, 0);
  await finalize(id); await finalize(id);
  const rows = await notices(id); assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].payload, { invoiceId: id, branchId: BR });
  assert.equal(rows[0].status, 'pending');
});
test('rollback نهایی‌سازی، موجودی و اعلان را با هم برمی‌گرداند', async () => {
  const before = (await owner.query('SELECT on_hand::text FROM inventory.stock_balance WHERE variation_id=$1 AND warehouse_id=$2', [variation, WH])).rows;
  let id: string;
  await writer.query('BEGIN');
  try {
    id = await draft('pos', customer, writer); await finalize(id);
    assert.equal((await writer.query("SELECT count(*)::int n FROM platform.outbox_message WHERE topic='web.instore_push' AND payload->>'invoiceId'=$1", [id])).rows[0].n, 1);
    assert.equal((await notices(id)).length, 0, 'اعلان commit نشده نباید برای Worker قابل مشاهده باشد');
  } finally { await writer.query('ROLLBACK'); }
  assert.equal((await notices(id)).length, 0);
  assert.deepEqual((await owner.query('SELECT on_hand::text FROM inventory.stock_balance WHERE variation_id=$1 AND warehouse_id=$2', [variation, WH])).rows, before);
});
test('فروش سایت، فروش ناشناس و خاموشی Push اعلان حضوری تولید نمی‌کنند', async () => {
  for (const [channel, c] of [['web', customer], ['pos', null]] as const) {
    const id = await draft(channel, c); await finalize(id); assert.equal((await notices(id)).length, 0);
  }
  await setting('web.push_enabled', false);
  try { const id = await draft(); await finalize(id); assert.equal((await notices(id)).length, 0); }
  finally { await setting('web.push_enabled', true); }
});
test('دریافت هدفمند فقط همان فاکتور را برمی‌گرداند و حلقهٔ سایت بسته است', async () => {
  const a = await draft(); const b = await draft(); await finalize(a); await finalize(b);
  const r = await feed(b); assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().items.map((x: { invoiceId: string }) => x.invoiceId), [b]);
  const web = await draft('web'); await finalize(web);
  assert.deepEqual((await feed(web)).json().items, []);
  const unfinished = await draft(); assert.deepEqual((await feed(unfinished)).json().items, []);
});
test('دریافت هدفمند مجوز شعبه و احراز هویت را دور نمی‌زند', async () => {
  const id = await draft(); await finalize(id);
  assert.equal((await feed(id, '00000000-0000-7000-8000-000000000099')).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: `/web/instore-purchases?branchId=${BR}&invoiceId=${id}` })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: `/web/instore-purchases?branchId=${BR}&invoiceId=bad`, headers: auth })).statusCode, 400);
});
test('اجرای دوباره مهاجرت نه اعلان قدیمی می‌سازد و نه اعلان را تکرار می‌کند', async () => {
  const id = await draft(); await finalize(id);
  const before = (await owner.query('SELECT count(*)::int n FROM platform.outbox_message')).rows[0].n;
  const migration = readFileSync(new URL('../../../db/migrations/073_instore_purchase_push.sql', import.meta.url), 'utf8');
  await owner.query(migration); await owner.query(migration); await finalize(id);
  assert.equal((await owner.query('SELECT count(*)::int n FROM platform.outbox_message')).rows[0].n, before);
  assert.equal((await notices(id)).length, 1);
});

test('۲۵ فروش هم‌زمان، هرکدام یک اعلان و یک کاهش موجودی دارند', async () => {
  const count = 25;
  const before = Number((await owner.query('SELECT on_hand FROM inventory.stock_balance WHERE variation_id=$1 AND warehouse_id=$2', [variation, WH])).rows[0].on_hand);
  const ids = await Promise.all(Array.from({ length: count }, async () => {
    const c = new Client({ connectionString: disposable.url }); await c.connect();
    try {
      await c.query('BEGIN');
      const id = await draft('pos', customer, c); await finalize(id, c);
      await c.query('COMMIT');
      await finalize(id, c);
      return id;
    } catch (e) { await c.query('ROLLBACK'); throw e; }
    finally { await c.end(); }
  }));
  const after = Number((await owner.query('SELECT on_hand FROM inventory.stock_balance WHERE variation_id=$1 AND warehouse_id=$2', [variation, WH])).rows[0].on_hand);
  assert.equal(before - after, count);
  const rows = (await owner.query("SELECT payload->>'invoiceId' id,count(*)::int n FROM platform.outbox_message WHERE topic='web.instore_push' AND payload->>'invoiceId'=ANY($1::text[]) GROUP BY 1", [ids])).rows;
  assert.equal(rows.length, count); assert.ok(rows.every(x => x.n === 1));
  const feedIds = await Promise.all(ids.map(id => feed(id).then(r => {
    assert.equal(r.statusCode, 200, r.body);
    return r.json().items.map((x: { invoiceId: string }) => x.invoiceId);
  })));
  assert.deepEqual(feedIds, ids.map(id => [id]));
});

test('رقابت فروش سایت و حضوری برای آخرین کالا بیش‌فروشی نمی‌کند', async () => {
  const product = (await owner.query("INSERT INTO catalog.product(code,name_internal) VALUES('PUSH-LAST','آزمون آخرین کالا') RETURNING id")).rows[0].id;
  const item = (await owner.query("INSERT INTO catalog.variation(product_id,color,size,sku) VALUES($1,'آبی','M','PUSH-LAST-M') RETURNING id", [product])).rows[0].id;
  await owner.query("SELECT inventory.apply_movement($1::uuid,$2::uuid,1,'purchase_receipt','test_receipt',$3::uuid,$3::uuid,600)", [item, WH, ACTOR]);
  const clients = [new Client({ connectionString: disposable.url }), new Client({ connectionString: disposable.url })];
  await Promise.all(clients.map(c => c.connect()));
  try {
    const ids = [await draft('pos', customer, clients[0], item), await draft('web', customer, clients[1], item)];
    const results = await Promise.allSettled(ids.map((id, i) => finalize(id, clients[i])));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const failure = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal(failure.reason.code, 'P0001');
    assert.equal(Number((await owner.query('SELECT on_hand FROM inventory.stock_balance WHERE variation_id=$1 AND warehouse_id=$2', [item, WH])).rows[0].on_hand), 0);
    assert.equal((await owner.query("SELECT count(*)::int n FROM sales.invoice WHERE id=ANY($1::uuid[]) AND finalized_at IS NOT NULL", [ids])).rows[0].n, 1);
    assert.equal((await owner.query("SELECT count(*)::int n FROM inventory.stock_movement WHERE variation_id=$1 AND qty<0", [item])).rows[0].n, 1);
  } finally { await Promise.all(clients.map(c => c.end())); }
});

test('قفل سازگار با FK همچنان از عبور هم‌زمان دو فروش از سقف اعتبار جلوگیری می‌کند', async () => {
  const creditCustomer = (await owner.query("INSERT INTO sales.customer(mobile_normalized,full_name,credit_limit) VALUES('09121119989','آزمون سقف هم‌زمان',1500) RETURNING id")).rows[0].id;
  const clients = [new Client({ connectionString: disposable.url }), new Client({ connectionString: disposable.url })];
  await Promise.all(clients.map(c => c.connect()));
  const ids: string[] = [];
  try {
    // هر دو FK پیش از شروع نهایی‌سازی قفل KEY SHARE دارند.
    for (const c of clients) {
      await c.query('BEGIN');
      ids.push(await draft('pos', creditCustomer, c, variation, false));
    }
    const results = await Promise.all(clients.map(async (c, i) => {
      const id = ids[i]; assert.ok(id);
      try { await finalize(id, c); await c.query('COMMIT'); return 'committed'; }
      catch (e) {
        await c.query('ROLLBACK');
        const error = e as { code: string; message: string };
        assert.equal(error.code, 'P0001'); assert.match(error.message, /سقف اعتبار/);
        return 'credit_limit';
      }
    }));
    assert.deepEqual(results.sort(), ['committed', 'credit_limit']);
    assert.equal((await owner.query("SELECT sum(payable_amount-paid_amount)::text due FROM sales.invoice WHERE customer_id=$1 AND finalized_at IS NOT NULL", [creditCustomer])).rows[0].due, '1000');
  } finally { await Promise.all(clients.map(c => c.end())); }
});

test('قطعی سایت اعلان را موفق اعلام نمی‌کند؛ بازیابی صف مستقل از پیامک است', async () => {
  const id = await draft(); await finalize(id);
  const before = (await owner.query('SELECT on_hand::text FROM inventory.stock_balance WHERE variation_id=$1 AND warehouse_id=$2', [variation, WH])).rows;
  const delivered: string[] = [];
  let unavailable = true;
  const opts: LoopOptions = { db: handle.db, workerName: 'instore-test', smsApiKey: '', webhookToken: undefined,
    webPushSecret: 'test-key', batchSize: 100, leaseSeconds: 120, log: () => {},
    webPushDeps: { resolveTarget: async raw => ({ url: new URL(raw), ip: '203.0.113.10', ips: ['203.0.113.10'] }),
      post: async (target, init) => {
        if (unavailable) return { status: 503 };
        if (target.url.pathname.endsWith('/instore')) {
          assert.ok(init.headers['x-lmc-signature']);
          const p = JSON.parse(init.body) as { invoiceId: string; branchId: string };
          assert.deepEqual(Object.keys(p).sort(), ['branchId', 'invoiceId']); delivered.push(p.invoiceId);
        }
        return { status: 200 };
      } },
  };
  await tick(opts);
  const failed = (await notices(id))[0]; assert.equal(failed.status, 'pending'); assert.equal(failed.attempts, 1);
  assert.ok(new Date(failed.next_attempt_at).getTime() > Date.now());
  unavailable = false;
  // ساعت موعد fixture جلو می‌آید؛ خود سیاست backoff و assertion آن دست‌نخورده‌اند.
  await owner.query("UPDATE platform.outbox_message SET next_attempt_at=now()-interval '1 second' WHERE status='pending'");
  await tick(opts); await tick(opts);
  assert.equal(delivered.filter(x => x === id).length, 1);
  assert.equal((await notices(id))[0].status, 'sent');
  assert.deepEqual((await owner.query('SELECT on_hand::text FROM inventory.stock_balance WHERE variation_id=$1 AND warehouse_id=$2', [variation, WH])).rows, before);
});
