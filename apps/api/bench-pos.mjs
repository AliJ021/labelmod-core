/**
 * بودجهٔ صندوق — اندازه‌گیری «افزودن قلم به سبد» (بخش ۸٫۸ ممیزی)
 *
 * ADR-002: «افزودن قلم به سبد **زیر ۱۰۰ میلی‌ثانیه** روی ضعیف‌ترین
 * دستگاه هدف». عدد مصوب است؛ اینجا اختراع نمی‌شود، اندازه گرفته می‌شود.
 *
 * چه چیزی اندازه گرفته می‌شود: زمان **سرور** برای POST /invoices/:id/lines
 * از لحظهٔ ورود درخواست تا پاسخ کامل، با `app.inject` — یعنی بدون شبکه و
 * بدون Render مرورگر. این سهمِ سرور است، نه کل زمانِ محسوسِ کاربر.
 */
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "fatal";
const { execFileSync } = await import("node:child_process");
const { randomBytes } = await import("node:crypto");
const os = await import("node:os");
const { sql } = await import("kysely");
const { createDb } = await import("./src/db/client.ts");
const { AuthService } = await import("./src/auth/service.ts");
const { hashSecret } = await import("./src/auth/password.ts");
const { buildApp } = await import("./src/http/app.ts");
const { loadConfig } = await import("./src/lib/config.ts");

const ADMIN = process.env.DATABASE_URL;
if (!ADMIN) throw new Error("DATABASE_URL لازم است");
const name = `lmc_bench_${randomBytes(5).toString("hex")}`;
const url = (() => { const u = new URL(ADMIN); u.pathname = `/${name}`; return u.toString(); })();
const psql = (u, c) => execFileSync("psql", ["-v","ON_ERROR_STOP=1","-q","-d",u,"-c",c], { stdio:"pipe" });
psql(ADMIN, `CREATE DATABASE "${name}"`);
for (const step of ["migrate","seed"])
  execFileSync("bash", ["../../ops/db.sh", step], { cwd: import.meta.dirname, stdio:"pipe", env:{...process.env, DATABASE_URL:url} });

const BR = "00000000-0000-7000-8000-000000000001";
const WH = "00000000-0000-7000-8000-000000000101";
const SYS = "00000000-0000-7000-8000-0000000000f1";
const h = createDb(url, 10);
const PW = "رمز-بنچمارک-و-به‌قدر-کافی-بلند";
const sx = `b${Date.now()}`;

const u = await h.db.insertInto("identity.app_user").values({
  username:`cash_${sx}`, full_name:"صندوق‌دار بنچمارک", password_hash: await hashSecret(PW),
  is_active:true, mobile:null, pin_hash:null, totp_secret:null }).returning("id").executeTakeFirstOrThrow();
await h.db.insertInto("identity.user_role").values({user_id:u.id, role_code:"cashier", branch_id:BR}).execute();

// دادهٔ واقع‌گرایانه: ۲۰۰ تنوع با قیمت و موجودی، چون سبد ۲۰۰ قلمی
// نمی‌تواند یک کالا را ۲۰۰ بار داشته باشد بی‌آنکه سطر تجمیع شود.
const VARS = [];
const N_VARS = 220;
const prod = await sql`INSERT INTO catalog.product (code,name_internal) VALUES (${`P-${sx}`},'کالای بنچمارک') RETURNING id`.execute(h.db);
await sql`SELECT platform.set_actor(${SYS}::uuid)`.execute(h.db);
for (let i = 0; i < N_VARS; i++) {
  const v = await sql`INSERT INTO catalog.variation (product_id,color,size,sku)
    VALUES (${prod.rows[0].id}, ${'رنگ'+i}, ${'S'+i}, ${`SKU-${sx}-${i}`}) RETURNING id`.execute(h.db);
  const id = v.rows[0].id;
  VARS.push(id);
  await sql`INSERT INTO catalog.price (variation_id,price_list,amount) VALUES (${id},'default',1500000)`.execute(h.db);
  await sql`SELECT inventory.apply_movement(${id}::uuid,${WH}::uuid,50,'purchase_receipt',NULL,NULL,${SYS}::uuid,900000)`.execute(h.db);
}

const app = await buildApp({ db:h.db, auth:new AuthService(h.db), config:loadConfig({...process.env}) });
await app.ready();

const lr = await app.inject({method:"POST",url:"/auth/login",
  payload:{username:`cash_${sx}`,password:PW,deviceFingerprint:`fp-${sx}`}});
if (lr.statusCode !== 200) throw new Error(lr.body);
const ck = (n)=>lr.cookies.find(x=>x.name===n)?.value??"";
const AUTH = { cookies:{labelmod_session:ck("labelmod_session"),labelmod_csrf:ck("labelmod_csrf")},
               headers:{"x-csrf-token":ck("labelmod_csrf")} };

await app.inject({method:"POST",url:"/shifts",...AUTH,payload:{branchId:BR,openingCash:"0"}});

function stats(xs) {
  const s = [...xs].sort((a,b)=>a-b);
  const q = (p) => s[Math.min(s.length-1, Math.ceil(p*s.length)-1)];
  return { n:s.length, p50:q(0.5), p95:q(0.95), p99:q(0.99), max:s[s.length-1],
           mean: s.reduce((a,b)=>a+b,0)/s.length };
}
const f = (x) => x.toFixed(1).padStart(6);

console.log("── محیط ───────────────────────────────────────────────────");
console.log(`  CPU        ${os.cpus()[0].model} × ${os.cpus().length}`);
console.log(`  RAM        ${(os.totalmem()/2**30).toFixed(1)} GiB`);
console.log(`  Node       ${process.version}`);
console.log(`  PostgreSQL ${(await sql`SHOW server_version`.execute(h.db)).rows[0].server_version}`);
console.log(`  کاتالوگ    ${N_VARS} تنوع با قیمت و موجودی`);
console.log(`  اندازه‌گیری  app.inject — بدون شبکه، بدون Render مرورگر`);
console.log(`  حالت عملکرد بی‌ربط به این عدد: کلید مرورگری است (backdrop-filter)\n`);

console.log("── افزودن قلم به سبد، به‌ازای اندازهٔ سبد ─────────────────");
console.log("  سبد │    p50    p95    p99    max   mean │ بودجه ۱۰۰ms");
console.log("  ────┼──────────────────────────────────────┼────────────");

const RESULTS = {};
for (const target of [1, 10, 50, 200]) {
  // یک فاکتور تازه برای هر اندازه، تا اندازهٔ سبد واقعاً همان باشد
  const inv = await app.inject({method:"POST",url:"/invoices",...AUTH,
    payload:{branchId:BR,warehouseId:WH,channel:"pos"}});
  if (inv.statusCode !== 201) throw new Error(inv.body);
  const id = JSON.parse(inv.body).id;

  // گرم‌کردن: JIT و Plan Cache نباید در p50 اولین اندازه بنشینند
  if (target === 1) {
    const warm = await app.inject({method:"POST",url:"/invoices",...AUTH,
      payload:{branchId:BR,warehouseId:WH,channel:"pos"}});
    const wid = JSON.parse(warm.body).id;
    for (let i = 0; i < 30; i++)
      await app.inject({method:"POST",url:`/invoices/${wid}/lines`,...AUTH,
        payload:{variationId:VARS[i], qty:"1"}});
  }

  const samples = [];
  for (let i = 0; i < target; i++) {
    const t0 = process.hrtime.bigint();
    const r = await app.inject({method:"POST",url:`/invoices/${id}/lines`,...AUTH,
      payload:{variationId:VARS[i], qty:"1"}});
    const t1 = process.hrtime.bigint();
    if (r.statusCode !== 201) throw new Error(`قلم ${i}: ${r.statusCode} ${r.body}`);
    samples.push(Number(t1 - t0) / 1e6);
  }
  // فقط نمونه‌های **پایانی** نمایندهٔ «سبد با این اندازه»اند: قلم اول
  // روی سبد خالی می‌نشیند. پس آخرین ۲۵٪ (حداقل ۱) گزارش می‌شود.
  const tailFrom = Math.max(0, samples.length - Math.max(1, Math.ceil(samples.length * 0.25)));
  const st = stats(samples.slice(tailFrom));
  RESULTS[target] = st;
  const ok = st.p99 < 100 ? "✓" : "✗ شکست";
  console.log(`  ${String(target).padStart(3)} │ ${f(st.p50)} ${f(st.p95)} ${f(st.p99)} ${f(st.max)} ${f(st.mean)} │ ${ok}`);
}

console.log("\n── رشد با اندازهٔ سبد ────────────────────────────────────");
const base = RESULTS[1].p50;
for (const k of [1,10,50,200])
  console.log(`  سبد ${String(k).padStart(3)} قلم →  p50 ${f(RESULTS[k].p50)} ms  (×${(RESULTS[k].p50/base).toFixed(2)} نسبت به سبد ۱)`);

const worst = Math.max(...[1,10,50,200].map(k=>RESULTS[k].p99));
console.log(`\n  بدترین p99 روی همهٔ اندازه‌ها: ${worst.toFixed(1)} ms  ` +
            `${worst < 100 ? "— بودجه شکسته نشد" : "— **بودجه شکست**"}`);

await app.close(); await h.close();
psql(ADMIN, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
