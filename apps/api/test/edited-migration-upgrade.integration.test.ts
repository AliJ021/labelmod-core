/**
 * FND33/FND34 — نصبی که نسخهٔ **اولیهٔ** ۰۶۵ و ۰۷۰ را اجرا کرده، ارتقا می‌یابد.
 *
 * ۰۶۵ و ۰۷۰ پس از اجرا ویرایش شدند و `ops/db.sh migrate` روی هر ویرایش
 * می‌ایستد. این آزمون همان نصب قدیمی را واقعاً می‌سازد — با هش اولیه در
 * دفتر مهاجرت — و ثابت می‌کند:
 *
 *   ۱. ارتقا با `ops/db.sh` جاری کامل می‌شود و ۰۹۰ تفاوت را اعمال می‌کند؛
 *   ۲. اسکیمای حاصل با نصب تازه **یکی** است (ستون و بدنهٔ سه تابع)؛
 *   ۳. دفتر مهاجرت، هش واقعیِ اجراشده را نگه می‌دارد — تاریخ بازنویسی نمی‌شود؛
 *   ۴. هر ویرایشِ **دیگری** هنوز ارتقا را متوقف می‌کند.
 *
 * نسخهٔ اولیه از روی فایل جاری بازسازی و با SHA-256 سنجیده می‌شود، نه از
 * تاریخچهٔ گیت — CI clone کم‌عمق دارد.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const adminUrl = process.env.DATABASE_URL;
const MIGRATIONS = path.join(root, "db/migrations");

const ORIGINAL_065 = "cbfa185bb3ca87930c6ab568bdec4a9b58b1f9db0a13c22b6ecd6792fa502096";
const ORIGINAL_070 = "ceb8ed7d9c2caf7d2032ea947f28ead10fcadd52b5c2b09bab20560e6c7e41e4";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function replaceOnce(text: string, from: string, to: string): string {
  const at = text.indexOf(from);
  assert.ok(at >= 0 && text.indexOf(from, at + 1) < 0, `باید دقیقاً یک بار بیاید: ${from.slice(0, 50)}`);
  return text.slice(0, at) + to + text.slice(at + from.length);
}

/** نسخهٔ اولیهٔ ۰۶۵ (1c0d926): بدون میان‌بُر منطقهٔ زمانی برنامه. */
function original065(): string {
  const text = replaceOnce(readFileSync(path.join(MIGRATIONS, "065_audit_timezone.sql"), "utf8"),
    " -- Most legacy writers used the application zone. Check it before enumerating\n"
    + " -- historical offsets, so a large existing audit trail remains cheap to verify.\n"
    + " PERFORM set_config('TimeZone','Asia/Tehran',true);\n"
    + " IF p_hash=platform.audit_hash(p_version,p_prev,p_at,p_actor,p_action,p_entity,p_id,p_after,p_before,p_reason,p_correlation) THEN RETURN true; END IF;\n",
    "");
  assert.equal(sha256(text), ORIGINAL_065, "بازسازی ۰۶۵ باید بایت‌به‌بایت همان نسخهٔ اجراشده باشد");
  return text;
}

/** نسخهٔ اولیهٔ ۰۷۰ (af3764d): بدون زمان شروع تراکنش. */
function original070(): string {
  let text = readFileSync(path.join(MIGRATIONS, "070_committed_journal_guard.sql"), "utf8");
  for (const [from, to] of [
    ["-- زمان شروع هم سنجیده می‌شود: شناسهٔ تراکنش در کلاستر بازیابی‌شده ممکن است تکرار شود.\n", ""],
    ["ALTER TABLE ledger.journal_entry ADD COLUMN creation_xact xid8,\n  ADD COLUMN creation_xact_started_at timestamptz;",
      "ALTER TABLE ledger.journal_entry ADD COLUMN creation_xact xid8;"],
    ["    NEW.creation_xact_started_at := transaction_timestamp();\n", ""],
    ["  IF NEW.creation_xact IS DISTINCT FROM OLD.creation_xact\n     OR NEW.creation_xact_started_at IS DISTINCT FROM OLD.creation_xact_started_at THEN",
      "  IF NEW.creation_xact IS DISTINCT FROM OLD.creation_xact THEN"],
    ["    SELECT id, status, creation_xact, creation_xact_started_at FROM ledger.journal_entry",
      "    SELECT id, status, creation_xact FROM ledger.journal_entry"],
    ["       (TG_OP <> 'INSERT' OR v_entry.creation_xact IS DISTINCT FROM pg_current_xact_id()\n        OR v_entry.creation_xact_started_at IS DISTINCT FROM transaction_timestamp()) THEN",
      "       (TG_OP <> 'INSERT' OR v_entry.creation_xact IS DISTINCT FROM pg_current_xact_id()) THEN"],
  ] as const) text = replaceOnce(text, from, to);
  assert.equal(sha256(text), ORIGINAL_070, "بازسازی ۰۷۰ باید بایت‌به‌بایت همان نسخهٔ اجراشده باشد");
  return text;
}

test("FND33/34: install that ran the original 065/070 upgrades to the same schema as a fresh install", { skip: !adminUrl }, () => {
  const tag = randomBytes(6).toString("hex");
  const stages: string[] = [];
  const databases: string[] = [];
  const urlFor = (name: string) => { const u = new URL(adminUrl!); u.pathname = `/${name}`; return u.toString(); };
  const psql = (url: string, command: string) => execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-Aqt", "-d", url, "-c", command],
    { stdio: "pipe", env: { ...process.env, PGCLIENTENCODING: "UTF8" } }).toString().trim();
  const createDatabase = (suffix: string) => {
    const name = `labelmod_edited_${tag}_${suffix}`;
    psql(adminUrl!, `CREATE DATABASE "${name}"`);
    databases.push(name);
    return urlFor(name);
  };
  /** پوشهٔ مرحله با `ops/db.sh` جاری و مهاجرت‌هایی که می‌گوییم. */
  const stage = (files: Record<string, string>) => {
    const dir = mkdtempSync(path.join(tmpdir(), "labelmod-edited-"));
    stages.push(dir);
    mkdirSync(path.join(dir, "ops"));
    mkdirSync(path.join(dir, "db/migrations"), { recursive: true });
    copyFileSync(path.join(root, "ops/db.sh"), path.join(dir, "ops/db.sh"));
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, "db/migrations", name), text);
    return dir;
  };
  const migrate = (dir: string, url: string) => execFileSync("bash", [path.join(dir, "ops/db.sh"), "migrate"],
    { cwd: dir, env: { ...process.env, DATABASE_URL: url, PGCLIENTENCODING: "UTF8" }, stdio: "pipe" }).toString();

  const current: Record<string, string> = {};
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    current[name] = readFileSync(path.join(MIGRATIONS, name), "utf8");
  }
  const upTo070 = (overrides: Record<string, string>) => Object.fromEntries(
    Object.entries(current).filter(([name]) => parseInt(name, 10) <= 70).map(([name, text]) => [name, overrides[name] ?? text]));
  assert.ok(current["090_repair_edited_migrations.sql"], "مهاجرت ترمیمی باید وجود داشته باشد");

  // تعریف‌هایی که نصب تازه و نصب ارتقایافته باید یکی‌شان را داشته باشند.
  const fingerprint = (url: string) => psql(url, `SELECT string_agg(def, E'\\n--\\n' ORDER BY def) FROM (
      SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE (n.nspname,p.proname) IN (('ledger','protect_final_entry'),('ledger','protect_posted_line'),
                                       ('platform','audit_content_matches'))
      UNION ALL
      SELECT 'column:'||column_name||':'||data_type FROM information_schema.columns
       WHERE table_schema='ledger' AND table_name='journal_entry' AND column_name LIKE 'creation_xact%') x`);

  try {
    // ── نصب قدیمی: ۰۶۵ و ۰۷۰ با نسخهٔ اولیه، تا ۰۷۰ ──────────────────
    const oldUrl = createDatabase("old");
    migrate(stage(upTo070({ "065_audit_timezone.sql": original065(), "070_committed_journal_guard.sql": original070() })), oldUrl);
    assert.equal(psql(oldUrl, `SELECT checksum FROM public.schema_migration WHERE filename='065_audit_timezone.sql'`), ORIGINAL_065);
    assert.equal(psql(oldUrl, `SELECT checksum FROM public.schema_migration WHERE filename='070_committed_journal_guard.sql'`), ORIGINAL_070);
    assert.equal(psql(oldUrl, `SELECT count(*) FROM information_schema.columns
      WHERE table_schema='ledger' AND table_name='journal_entry' AND column_name='creation_xact_started_at'`), "0",
      "نصب قدیمی واقعاً ستون ترمیم ۰۷۰ را ندارد");

    // ── ارتقا با کد جاری ─────────────────────────────────────────────
    const out = migrate(stage(current), oldUrl);
    assert.match(out, /065_audit_timezone\.sql: نسخهٔ تاریخیِ شناخته‌شده/);
    assert.match(out, /070_committed_journal_guard\.sql: نسخهٔ تاریخیِ شناخته‌شده/);
    assert.match(out, /090_repair_edited_migrations\.sql/);
    // تاریخ بازنویسی نمی‌شود: دفتر همان هشی را دارد که واقعاً اجرا شد.
    assert.equal(psql(oldUrl, `SELECT checksum FROM public.schema_migration WHERE filename='065_audit_timezone.sql'`), ORIGINAL_065);
    // اجرای دوباره بی‌اثر و بی‌خطاست.
    migrate(stage(current), oldUrl);
    // استثنا به نسخهٔ جاریِ دقیق هم گره خورده: ویرایش بعدیِ ۰۶۵ روی همین نصب
    // باید مثل هر نصب دیگری متوقف کند، نه اینکه پشت هش تاریخی پنهان شود.
    assert.throws(() => migrate(stage({ ...current, "065_audit_timezone.sql": current["065_audit_timezone.sql"] + "\n-- ویرایش تازه\n" }), oldUrl),
      (error: { stdout?: Buffer }) => /065_audit_timezone\.sql پس از اجرا ویرایش شده است/.test(error.stdout?.toString() ?? ""),
      "ویرایش نسخهٔ جاری روی نصب تاریخی هم دیده می‌شود");

    // ── نصب تازه برای مقایسه ────────────────────────────────────────
    const freshUrl = createDatabase("fresh");
    migrate(stage(current), freshUrl);
    const upgraded = fingerprint(oldUrl);
    assert.ok(upgraded.includes("creation_xact_started_at"));
    assert.equal(upgraded, fingerprint(freshUrl), "ارتقای نصب قدیمی همان اسکیمای نصب تازه را می‌سازد");

    // ── هر ویرایش دیگری هنوز متوقف می‌کند ───────────────────────────
    const otherUrl = createDatabase("other");
    const tampered = original065() + "\n-- ویرایش ناشناخته\n";
    migrate(stage(upTo070({ "065_audit_timezone.sql": tampered })), otherUrl);
    assert.throws(() => migrate(stage(current), otherUrl), (error: { stdout?: Buffer }) =>
      /065_audit_timezone\.sql پس از اجرا ویرایش شده است/.test(error.stdout?.toString() ?? ""),
    "هش ناشناخته پذیرفته نمی‌شود، حتی با وجود مهاجرت ترمیمی");
    assert.equal(psql(otherUrl, `SELECT count(*) FROM public.schema_migration WHERE filename='090_repair_edited_migrations.sql'`), "0");
  } finally {
    for (const name of databases) {
      try { psql(adminUrl!, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); } catch { /* پاک‌سازی بهترین‌تلاش */ }
    }
    for (const dir of stages) rmSync(dir, { recursive: true, force: true });
  }
});
