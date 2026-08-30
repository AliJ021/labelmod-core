/**
 * تست یکپارچه صفحه تنظیمات — روی پستگرس واقعی.
 *
 * ادعای مرکزی: **مالک باید بتواند تصمیم‌های باز پروژه را خودش عوض کند،
 * بدون psql و بدون Deploy** — ولی نه هر کسی، نه هر مقداری، و نه بی‌ردّ.
 *
 * چهار چیزی که فقط اینجا سنجیده می‌شوند و در تست SQL دیده نمی‌شوند:
 *   • مجوز هر تنظیم از ستون خودش می‌آید، نه از یک گیت عمومی
 *   • خطای نگهبان دیتابیس به ۴۰۹ فارسی تبدیل می‌شود، نه ۵۰۰
 *   • `canEdit` برای هر نقش درست حساب می‌شود
 *   • نشستِ باز‌شده با PIN نمی‌تواند تنظیمات را عوض کند
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";
import { AuthService } from "../src/auth/service.ts";
import { hashSecret } from "../src/auth/password.ts";
import { buildApp } from "../src/http/app.ts";
import { loadConfig } from "../src/lib/config.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : "DATABASE_URL تنظیم نشده — تست یکپارچه رد شد";

const BRANCH = "00000000-0000-7000-8000-000000000001";

interface SettingView {
  key: string;
  value: unknown;
  kind: string;
  label: string;
  options: Array<{ value: string; label: string }> | null;
  min: number | null;
  max: number | null;
  isEditable: boolean;
  canEdit: boolean;
  permission: string;
  updatedBy: string | null;
}
interface GroupView {
  key: string;
  title: string;
  settings: SettingView[];
}

describe("تنظیمات از مسیر API", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;

  const suffix = `s${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-تنظیمات-و-به‌قدر-کافی-بلند";
  const admin = `sadmin_${suffix}`;
  const accountant = `sacc_${suffix}`;
  const cashier = `scash_${suffix}`;
  const warehouse = `swh_${suffix}`;

  const sessions = new Map<
    string,
    { cookies: Record<string, string>; headers: Record<string, string> }
  >();

  async function loginAs(username: string) {
    const cached = sessions.get(username);
    if (cached) return cached;
    const r = await app.inject({
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

  async function groups(username: string): Promise<GroupView[]> {
    const s = await loginAs(username);
    const r = await app.inject({ method: "GET", url: "/settings", ...s });
    assert.equal(r.statusCode, 200, r.body);
    return (JSON.parse(r.body) as { groups: GroupView[] }).groups;
  }

  function find(gs: GroupView[], key: string): SettingView {
    for (const g of gs) {
      const s = g.settings.find((x) => x.key === key);
      if (s) return s;
    }
    throw new Error(`تنظیم ${key} در پاسخ نبود`);
  }

  async function patch(username: string, key: string, value: unknown, reason?: string) {
    const s = await loginAs(username);
    return app.inject({
      method: "PATCH",
      url: `/settings/${key}`,
      ...s,
      payload: reason === undefined ? { value } : { value, reason },
    });
  }

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);

    const hash = await hashSecret(PASSWORD);
    for (const [username, name, role] of [
      [admin, "مدیر تنظیمات", "admin"],
      [accountant, "حسابدار تنظیمات", "accountant"],
      [cashier, "صندوق‌دار تنظیمات", "cashier"],
      [warehouse, "انباردار تنظیمات", "warehouse"],
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

  test("صفحه تنظیمات همه فراداده لازم را می‌دهد", async () => {
    const gs = await groups(admin);
    assert.ok(gs.length >= 8, `تعداد گروه: ${gs.length}`);

    const all = gs.flatMap((g) => g.settings);
    assert.equal(all.length, 30, "تعداد تنظیمات");

    // اگر برچسب یا نوع نیاید، رابط کاربری ناچار است کلید فنی انگلیسی
    // نشان دهد یا ویجت را حدس بزند — همان hardcode که ممنوع است.
    for (const s of all) {
      assert.ok(s.label.length > 0, `${s.key} برچسب ندارد`);
      assert.notEqual(s.kind, "json", `${s.key} نوع مشخص ندارد`);
      if (s.kind === "choice" || s.kind === "multichoice") {
        assert.ok((s.options?.length ?? 0) > 0, `${s.key} گزینه ندارد`);
      }
    }

    // روش قیمت تمام‌شده باید هر دو گزینه را داشته باشد — «آخرین قیمت
    // خرید» همان روشی است که هلو و دشت به کار می‌برند.
    const costing = find(gs, "costing.method");
    assert.deepEqual(
      costing.options?.map((o) => o.value).sort(),
      ["last_purchase", "moving_weighted_average"],
    );

    // سند فروش باید از داخل تنظیمات قابل انتخاب باشد.
    const posting = find(gs, "ledger.sale_posting");
    assert.deepEqual(
      posting.options?.map((o) => o.value).sort(),
      ["per_invoice", "per_shift"],
    );
  });

  test("صندوق‌دار و انباردار حتی صفحه تنظیمات را نمی‌بینند", async () => {
    // کمترین دسترسی. صفحه هنوز فیلتر گروهی ندارد، پس `settings.view`
    // یعنی دیدن سیاست PIN و عمر نشست هم — که هیچ‌کدام به کار این دو
    // نقش نمی‌آید.
    for (const who of [cashier, warehouse]) {
      const s = await loginAs(who);
      const r = await app.inject({ method: "GET", url: "/settings", ...s });
      assert.equal(r.statusCode, 403, `${who}: ${r.body}`);
    }
  });

  test("حسابدار می‌بیند، ولی فقط تنظیمات عملیاتی را می‌تواند عوض کند", async () => {
    const gs = await groups(accountant);

    // مهلت هشدار سررسید چک، عملیاتی است.
    assert.equal(find(gs, "cheque.due_warning_days").canEdit, true);
    // نرخ مالیات، امنیتی/مالی است.
    assert.equal(find(gs, "tax.default_rate").canEdit, false);
    // و قفل‌شده‌ها برای هیچ‌کس باز نیستند.
    assert.equal(find(gs, "payment.unknown_auto_retry").canEdit, false);

    const ok = await patch(accountant, "cheque.due_warning_days", 10);
    assert.equal(ok.statusCode, 200, ok.body);

    const denied = await patch(accountant, "tax.default_rate", 9, "تست");
    assert.equal(denied.statusCode, 403, denied.body);
    // مقدار نباید عوض شده باشد.
    assert.equal(find(await groups(admin), "tax.default_rate").value, 10);
  });

  test("مدیر تنظیم مالی را عوض می‌کند و نامش در صفحه می‌نشیند", async () => {
    const r = await patch(admin, "tax.default_rate", 9, "ابلاغیه سازمان امور مالیاتی");
    assert.equal(r.statusCode, 200, r.body);
    assert.equal((JSON.parse(r.body) as { value: unknown }).value, 9);

    const s = find(await groups(admin), "tax.default_rate");
    assert.equal(s.value, 9);
    assert.equal(s.updatedBy, "مدیر تنظیمات");
  });

  test("مقدار نامعتبر ۴۰۹ فارسی می‌گیرد، نه ۵۰۰", async () => {
    // این همان الگویی است که یک بار برای محدودیت نرخ گرفتیم: دفاعی که
    // شبیه خرابی سرور گزارش شود، در عمل خاموش است.
    for (const [key, value] of [
      ["tax.default_rate", 120],
      ["auth.pin_length", 3],
      ["auth.min_password_length", 6],
      ["costing.method", "fifo"],
      ["pos.require_customer", "شاید"],
      ["cheque.due_warning_days", 7.5],
    ] as const) {
      const r = await patch(admin, key, value, "تست مقدار نامعتبر");
      assert.equal(r.statusCode, 409, `${key}: ${r.body}`);
      const b = JSON.parse(r.body) as { error: { code: string; message: string } };
      assert.equal(b.error.code, "rule_violation");
      assert.match(b.error.message, /[؀-ۿ]/, "پیام خطا باید فارسی باشد");
    }
  });

  test("تنظیم قفل‌شده از مسیر API باز نمی‌شود", async () => {
    // «هیچ Retry خودکاری روی پرداخت نامشخص» یک قاعده است، نه پیش‌فرض.
    const r = await patch(admin, "payment.unknown_auto_retry", true, "تست");
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(find(await groups(admin), "payment.unknown_auto_retry").value, false);
  });

  test("کلید ناموجود ۴۰۴ می‌گیرد و ساخته نمی‌شود", async () => {
    const r = await patch(admin, "tax.nonexistent_key", 1, "تست");
    assert.equal(r.statusCode, 404, r.body);
  });

  test("تنظیم تصویب‌خواه بدون دلیل عوض نمی‌شود", async () => {
    const r = await patch(admin, "return.window_days", 3);
    assert.equal(r.statusCode, 409, r.body);
    assert.match((JSON.parse(r.body) as { error: { message: string } }).error.message, /دلیل/);
  });

  test("نشست باز‌شده با PIN تنظیمات را عوض نمی‌کند", async () => {
    // PIN فقط قفل صفحه را برمی‌دارد. اگر می‌شد با PIN سقف تخفیف یا
    // مهلت مرجوعی را عوض کرد، بند ۱ SECURITY.md در عمل وجود نداشت.
    const s = await loginAs(admin);
    await handle.db
      .updateTable("identity.session")
      .set({ pin_unlocked: true })
      .where("token_hash", "is not", null)
      .execute();

    const r = await app.inject({
      method: "PATCH",
      url: "/settings/cheque.due_warning_days",
      ...s,
      payload: { value: 11 },
    });
    assert.equal(r.statusCode, 403, r.body);

    await handle.db
      .updateTable("identity.session")
      .set({ pin_unlocked: false })
      .where("token_hash", "is not", null)
      .execute();
  });
});
