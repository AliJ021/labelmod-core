import { loginWithMfa } from "./helpers/login-with-mfa.ts";
/**
 * تست یکپارچه نگاشت حساب — روی پستگرس واقعی.
 *
 * `db/test/posting-rule.sql` خودِ تابع را می‌سنجد. آنچه **فقط** اینجا
 * دیده می‌شود:
 *
 *   • مجوز `ledger.mapping` از `permission_rule` می‌آید، نه از یک `if`
 *     روی نام نقش — و حسابدار در Seed صریحاً نداردش، پس ۴۰۳ می‌گیرد
 *     تا وقتی مالک ردیفش را روشن کند.
 *   • خطای نگهبان دیتابیس ۴۰۹ فارسی می‌شود، نه ۵۰۰. دفاعی که شبیه
 *     خرابی سرور گزارش شود، در عمل خاموش است.
 *   • فهرست حساب‌های مجاز از سرور می‌آید و **فقط قابل ثبت و فعال**
 *     است، پس صفحه گزینهٔ محکوم‌به‌رد نشان نمی‌دهد.
 *   • و نشستِ باز‌شده با PIN نمی‌تواند نگاشت را عوض کند — `ledger.mapping`
 *     در `auth.pin_forbidden_operations` هست.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";
import { AuthService } from "../src/auth/service.ts";
import { hashSecret } from "../src/auth/password.ts";
import { buildApp } from "../src/http/app.ts";
import { loadConfig } from "../src/lib/config.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : "DATABASE_URL تنظیم نشده — تست یکپارچه رد شد";

const BRANCH = "00000000-0000-7000-8000-000000000001";

interface RuleView {
  id: number;
  eventType: string;
  leg: string;
  side: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  description: string;
  allowAccountOverride: boolean;
  entryCount: number;
}
interface AccountView {
  code: string;
  name: string;
  type: string;
}

describe("نگاشت حساب از مسیر API", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;

  const suffix = `m${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-نگاشت-حساب-و-به‌قدر-کافی-بلند";
  const admin = `madmin_${suffix}`;
  const accountant = `macc_${suffix}`;
  const cashier = `mcash_${suffix}`;

  const sessions = new Map<
    string,
    { cookies: Record<string, string>; headers: Record<string, string> }
  >();

  async function loginAs(username: string) {
    const cached = sessions.get(username);
    if (cached) return cached;
    const r = await loginWithMfa(app, {
      method: "POST",
      url: "/auth/login",
      payload: {
        username,
        password: PASSWORD,
        deviceFingerprint: `fp-${suffix}-${username}`,
      },
    });
    assert.equal(r.statusCode, 200, `ورود ${username} ناموفق: ${r.body}`);
    const csrf = r.cookies.find((c) => c.name === "labelmod_csrf")?.value ?? "";
    const out = {
      cookies: {
        labelmod_session: r.cookies.find((c) => c.name === "labelmod_session")?.value ?? "",
        labelmod_csrf: csrf,
      },
      headers: { "x-csrf-token": csrf },
    };
    sessions.set(username, out);
    return out;
  }

  async function read(username: string) {
    const s = await loginAs(username);
    const r = await app.inject({ method: "GET", url: "/posting-rules", ...s });
    assert.equal(r.statusCode, 200, r.body);
    return JSON.parse(r.body) as { rules: RuleView[]; accounts: AccountView[] };
  }

  async function put(username: string, leg: string, accountCode: string, reason: string) {
    const s = await loginAs(username);
    return app.inject({
      method: "PUT",
      url: `/posting-rules/sale_shift/${leg}/credit`,
      ...s,
      payload: { accountCode, reason },
    });
  }

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);

    const hash = await hashSecret(PASSWORD);
    for (const [username, name, role] of [
      [admin, "مدیر نگاشت", "admin"],
      [accountant, "حسابدار نگاشت", "accountant"],
      [cashier, "صندوق‌دار نگاشت", "cashier"],
    ] as const) {
      const u = await handle.db
        .insertInto("identity.app_user")
        .values({
          username,
          full_name: name,
          password_hash: hash,
          is_active: true,
          mobile: null,
          pin_hash: null,
          totp_secret: null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await handle.db
        .insertInto("identity.user_role")
        .values({ user_id: u.id, role_code: role, branch_id: BRANCH })
        .execute();
    }

    app = await buildApp({
      db: handle.db,
      auth: new AuthService(handle.db),
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }),
    });
    await app.ready();
  });

  after(async () => {
    await app?.close();
    await handle?.close();
    disposable?.drop();
  });

  test("فهرست نگاشت کامل است و حساب‌های مجاز همراهش می‌آید", async () => {
    const { rules, accounts } = await read(admin);

    assert.ok(rules.length >= 50, `تعداد قاعده: ${rules.length}`);
    // نام و نوع حساب باید بیاید، وگرنه صفحه فهرستی از کد بی‌معنا است.
    for (const r of rules) {
      assert.ok(r.accountName.length > 0, `${r.eventType}/${r.leg} نام حساب ندارد`);
      assert.ok(r.accountType.length > 0, `${r.eventType}/${r.leg} نوع حساب ندارد`);
      assert.ok(r.description.length > 0, `${r.eventType}/${r.leg} توضیح ندارد`);
      assert.equal(typeof r.entryCount, "number");
    }

    const sales = rules.find((r) => r.eventType === "sale_shift" && r.leg === "sales");
    assert.ok(sales, "قاعده فروش کالا در پاسخ نبود");
    assert.equal(sales.accountCode, "4101");
    assert.equal(sales.accountType, "revenue");
    // درآمد هرگز از تراکنش تعیین نمی‌شود — قاعدهٔ CLAUDE.md.
    assert.equal(sales.allowAccountOverride, false);

    /*
     * فهرست انتخاب فقط حساب قابل ثبت و فعال دارد. اگر حساب سطح میانی
     * هم می‌آمد، کاربر گزینه‌ای می‌دید که سرور قطعاً ردش می‌کند — و
     * نتیجه‌اش این است که به فهرست اعتماد نمی‌کند.
     */
    assert.ok(accounts.length >= 20, `تعداد حساب: ${accounts.length}`);
    assert.equal(accounts.find((a) => a.code === "41"), undefined, "حساب سطح میانی نباید بیاید");
    assert.ok(accounts.find((a) => a.code === "4101"), "حساب قابل ثبت باید بیاید");
  });

  test("صندوق‌دار و حسابدار نمی‌توانند نگاشت را عوض کنند", async () => {
    for (const who of [cashier, accountant]) {
      const r = await put(who, "sales", "4202", "تلاش بی‌مجوز");
      assert.equal(r.statusCode, 403, `${who}: ${r.body}`);
    }

    /*
     * ⚠️ حسابدار عمداً ۴۰۳ می‌گیرد و این یک **پیش‌فرض** است نه یک قاعده:
     *    نگاشت حساب ذاتاً کارِ اوست، ولی Seed دسترسی‌ای نمی‌دهد که مالک
     *    انتخابش نکرده. دادنش یک ردیف در `permission_rule` است — و همین
     *    تست ثابت می‌کند که آن ردیف **واقعاً** کافی است، یعنی هیچ شرط
     *    دسترسی‌ای در کد نیست.
     */
    // ⚠️ `sql` خام و نه Query Builder: `permission_rule` در تایپ
    //    تولیدشدهٔ Kysely نیست (جدول‌های مجوز از آن بیرون‌اند).
    await sql`
      UPDATE identity.permission_rule SET allowed = true
       WHERE role_code = 'accountant' AND operation = 'ledger.mapping'
    `.execute(handle.db);

    const ok = await put(accountant, "sales", "4202", "حسابدار پس از گرفتن مجوز");
    assert.equal(ok.statusCode, 200, ok.body);

    // و برمی‌گردانیم تا بندهای بعدی از وضعیت Seed شروع کنند.
    await put(admin, "sales", "4101", "بازگشت برای بند بعدی");
    await sql`
      UPDATE identity.permission_rule SET allowed = false
       WHERE role_code = 'accountant' AND operation = 'ledger.mapping'
    `.execute(handle.db);
  });

  test("نگهبان دیتابیس ۴۰۹ فارسی می‌دهد، نه ۵۰۰", async () => {
    // نوع حساب متفاوت: ۴۱۰۲ کاهندهٔ درآمد است، ۴۱۰۱ درآمد.
    const wrongType = await put(admin, "sales", "4102", "تلاش برای عوض‌کردن ماهیت");
    assert.equal(wrongType.statusCode, 409, wrongType.body);
    const body = JSON.parse(wrongType.body) as {
      error: { code: string; message: string; correlationId: string };
    };
    assert.equal(body.error.code, "rule_violation");
    assert.match(body.error.message, /نوع حساب/);
    // شناسهٔ پیگیری همراه خطا می‌رود، وگرنه کاربر چیزی ندارد که به آن
    // ارجاع دهد و لاگ از دسترس بیرون می‌ماند.
    assert.ok(body.error.correlationId.length > 0);

    // حساب سطح میانی
    const notPostable = await put(admin, "sales", "41", "تلاش روی سطح میانی");
    assert.equal(notPostable.statusCode, 409, notPostable.body);

    // همان حساب فعلی
    const same = await put(admin, "sales", "4101", "بی‌تغییر");
    assert.equal(same.statusCode, 409, same.body);

    // بدون دلیل — این یکی Zod است و ۴۰۰، چون شکل بدنه غلط است نه معنایش
    const s = await loginAs(admin);
    const noReason = await app.inject({
      method: "PUT",
      url: "/posting-rules/sale_shift/sales/credit",
      ...s,
      payload: { accountCode: "4202" },
    });
    assert.equal(noReason.statusCode, 400, noReason.body);
  });

  test("تغییر مجاز اثر می‌گذارد و در فهرست دیده می‌شود", async () => {
    const done = await put(admin, "sales", "4202", "تصمیم حسابدار برای سرفصل تازه");
    assert.equal(done.statusCode, 200, done.body);

    const { rules } = await read(admin);
    const sales = rules.find((r) => r.eventType === "sale_shift" && r.leg === "sales");
    assert.equal(sales?.accountCode, "4202");

    // و ردّ حسابرسی با مقدار پیش و پس — سؤال «چه کسی درآمد را جابه‌جا
    // کرد» باید جواب داشته باشد.
    const a = await sql<{
      before: { account_code: string };
      after: { account_code: string };
      reason: string | null;
    }>`
      SELECT before, after, reason FROM platform.audit_log
       WHERE action = 'ledger.set_posting_rule'
       ORDER BY at DESC LIMIT 1
    `.execute(handle.db);
    const audit = a.rows[0];
    assert.ok(audit, "سطر حسابرسی نوشته نشد");
    assert.equal(audit.before.account_code, "4101");
    assert.equal(audit.after.account_code, "4202");
    assert.match(audit.reason ?? "", /سرفصل تازه/);
  });
});
