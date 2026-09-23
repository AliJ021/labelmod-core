import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";

const BR = "00000000-0000-7000-8000-000000000001";
let disposable: DisposableDb;
let db: Client;
let actor: string;
before(async () => {
  assert.ok(process.env.DATABASE_URL, "آزمون تغییرناپذیری سند به دیتابیس مستقل نیاز دارد");
  const created = createDisposableDb(process.env.DATABASE_URL!); assert.ok(created); disposable = created;
  const owner = new Client({ connectionString: created.ownerUrl }); await owner.connect();
  try {
    actor = (await owner.query("INSERT INTO identity.app_user(username,full_name) VALUES('journal_guard_test','آزمون مستقل تغییرناپذیری سند') RETURNING id")).rows[0].id;
    await owner.query(`INSERT INTO ledger.posting_rule(event_type,leg,side,account_code,description)
      VALUES('journal_guard_test','cash','debit','1101','آزمون بدهکار'),('journal_guard_test','equity','credit','3102','آزمون بستانکار')`);
  } finally { await owner.end(); }
  db = new Client({ connectionString: created.url }); await db.connect();
});
after(async () => { await db?.end(); disposable?.drop(); });
async function posted() {
  const r = await db.query(`SELECT ledger.post_entry('journal_guard_test',$1::uuid,'2026-04-01','آزمون سند تأییدشده',
    '[{"leg":"cash","amount":"1000"},{"leg":"equity","amount":"1000"}]'::jsonb,NULL,NULL,$2::uuid) id`, [BR, actor]);
  return r.rows[0].id as string;
}
async function rejected(sql: string, args: unknown[]) {
  await db.query("BEGIN");
  try { await assert.rejects(db.query(sql, args), (error: { code?: string }) => error.code === "P0001"); }
  finally { await db.query("ROLLBACK"); }
}

test("پس از ثبت کامل، افزودن دو سطر متوازن به سند هم ممنوع است", async () => {
  const id = await posted();
  await rejected(`INSERT INTO ledger.journal_line(entry_id,line_no,account_code,debit,credit)
    VALUES($1,3,'1101',500,0),($1,4,'3102',0,500)`, [id]);
  const r = await db.query("SELECT count(*)::int n,sum(debit)::text debit FROM ledger.journal_line WHERE entry_id=$1", [id]);
  assert.deepEqual(r.rows[0], { n: 2, debit: "1000" });
});
test("برگشت وضعیت سند تأییدشده به پیش‌نویس راه دورزدن نیست", async () => {
  const id = await posted();
  await rejected("UPDATE ledger.journal_entry SET status='draft' WHERE id=$1", [id]);
});
test("تاریخ و شرح سند تأییدشده بازنویسی نمی‌شوند", async () => {
  const id = await posted();
  await rejected("UPDATE ledger.journal_entry SET entry_date='2026-04-02',description='تغییر غیرمجاز' WHERE id=$1", [id]);
});
test("ارتقا به نهایی، مجوز تازه‌ای برای افزودن سطر نمی‌دهد", async () => {
  const id = await posted();
  await db.query("BEGIN");
  try {
    await db.query("UPDATE ledger.journal_entry SET status='final' WHERE id=$1", [id]);
    await assert.rejects(db.query(`INSERT INTO ledger.journal_line(entry_id,line_no,account_code,debit,credit)
      VALUES($1,3,'1101',500,0),($1,4,'3102',0,500)`, [id]), (e: { code?: string }) => e.code === "P0001");
  } finally { await db.query("ROLLBACK"); }
  await db.query("UPDATE ledger.journal_entry SET status='final' WHERE id=$1", [id]);
  assert.equal((await db.query("SELECT status FROM ledger.journal_entry WHERE id=$1", [id])).rows[0].status, "final");
});
test("انتقال سطر پیش‌نویس به والد تأییدشده هم ممنوع است", async () => {
  const id = await posted();
  await db.query("BEGIN");
  try {
    const draft = (await db.query(`INSERT INTO ledger.journal_entry(fiscal_year,branch_id,entry_date,kind,description)
      VALUES(1405,$1,'2026-04-01','manual','پیش‌نویس مستقل') RETURNING id`, [BR])).rows[0].id;
    const line = (await db.query(`INSERT INTO ledger.journal_line(entry_id,line_no,account_code,debit,credit)
      VALUES($1,3,'1101',500,0) RETURNING id`, [draft])).rows[0].id;
    await assert.rejects(db.query("UPDATE ledger.journal_line SET entry_id=$1 WHERE id=$2", [id, line]),
      (e: { code?: string }) => e.code === "P0001");
  } finally { await db.query("ROLLBACK"); }
});
test("پیش‌نویس واقعی همچنان ویرایش و حذف می‌شود", async () => {
  await db.query("BEGIN");
  try {
    const id = (await db.query(`INSERT INTO ledger.journal_entry(fiscal_year,branch_id,entry_date,kind,description)
      VALUES(1405,$1,'2026-04-01','manual','پیش‌نویس مستقل') RETURNING id`, [BR])).rows[0].id;
    await db.query(`INSERT INTO ledger.journal_line(entry_id,line_no,account_code,debit,credit)
      VALUES($1,1,'1101',500,0),($1,2,'3102',0,500)`, [id]);
    await db.query("UPDATE ledger.journal_line SET description='ویرایش مجاز' WHERE entry_id=$1", [id]);
    await db.query("DELETE FROM ledger.journal_entry WHERE id=$1", [id]);
    await db.query("COMMIT");
  } catch (e) { await db.query("ROLLBACK"); throw e; }
});

test("شناسه تراکنش داخلی قابل جعل یا تمدید نیست", async () => {
  const id = await posted();
  await rejected("UPDATE ledger.journal_entry SET creation_xact=pg_current_xact_id() WHERE id=$1", [id]);
  await rejected("UPDATE ledger.journal_entry SET creation_xact_started_at=transaction_timestamp() WHERE id=$1", [id]);
  await db.query("BEGIN");
  try {
    const row = (await db.query(`INSERT INTO ledger.journal_entry(fiscal_year,branch_id,entry_date,kind,description,creation_xact)
      VALUES(1405,$1,'2026-04-01','manual','آزمون ورودی جعل‌شده','1'::xid8)
      RETURNING id, creation_xact=pg_current_xact_id() AS real_transaction`, [BR])).rows[0];
    assert.equal(row.real_transaction, true);
    await assert.rejects(db.query("UPDATE ledger.journal_entry SET creation_xact=NULL WHERE id=$1", [row.id]),
      (e: { code?: string }) => e.code === "P0001");
  } finally { await db.query("ROLLBACK"); }
});

test("تکرار شناسه تراکنش پس از بازیابی، مجوز تکمیل سند تاریخی نیست", async () => {
  const fixture = new Client({ connectionString: disposable.ownerUrl });
  await fixture.connect();
  try {
    await fixture.query("BEGIN");
    // فقط در دیتابیس موقت: شبیه‌سازی ردیف بازیابی‌شده با xid برابر نشست جدید.
    // زمان ساخت قدیمی است؛ هیچ تریگری در سرور اصلی تغییر داده نمی‌شود.
    await fixture.query("ALTER TABLE ledger.journal_entry DISABLE TRIGGER protect_final_entry_t");
    const id = (await fixture.query(`INSERT INTO ledger.journal_entry
      (fiscal_year,branch_id,entry_date,kind,description,status,creation_xact,creation_xact_started_at)
      VALUES(1405,$1,'2026-04-01','manual','شاهد بازیابی در پایگاه موقت','confirmed',
        pg_current_xact_id(),transaction_timestamp()-interval '1 day') RETURNING id`, [BR])).rows[0].id;
    await fixture.query("ALTER TABLE ledger.journal_entry ENABLE TRIGGER protect_final_entry_t");
    const role = decodeURIComponent(new URL(disposable.url).username);
    await fixture.query(`SET LOCAL ROLE "${role.replaceAll('"', '""')}"`);
    await assert.rejects(fixture.query(`INSERT INTO ledger.journal_line(entry_id,line_no,account_code,debit,credit)
      VALUES($1,1,'1101',500,0),($1,2,'3102',0,500)`, [id]),
      (e: { code?: string }) => e.code === "P0001");
  } finally { await fixture.query("ROLLBACK"); await fixture.end(); }
});
