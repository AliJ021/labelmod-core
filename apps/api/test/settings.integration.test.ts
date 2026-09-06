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
  unit: string | null;
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
    // عدد دقیق ادعا نمی‌شود: هر تنظیم تازه این تست را می‌شکست بدون
    // اینکه چیزی واقعاً خراب شده باشد. آنچه اهمیت دارد این است که
    // فهرست خالی نیست و **هر** تنظیم فراداده کامل دارد.
    assert.ok(all.length >= 30, `تعداد تنظیمات: ${all.length}`);
    assert.equal(new Set(all.map((x) => x.key)).size, all.length, "کلید تکراری");

    // اگر برچسب یا نوع نیاید، رابط کاربری ناچار است کلید فنی انگلیسی
    // نشان دهد یا ویجت را حدس بزند — همان hardcode که ممنوع است.
    for (const s of all) {
      assert.ok(s.label.length > 0, `${s.key} برچسب ندارد`);
      assert.notEqual(s.kind, "json", `${s.key} نوع مشخص ندارد`);
      if (s.kind === "choice" || s.kind === "multichoice") {
        assert.ok((s.options?.length ?? 0) > 0, `${s.key} گزینه ندارد`);
      }
    }

    // روش قیمت تمام‌شده باید **هر سه** گزینه را داشته باشد. مالک خواست
    // مثل هلو سه روش در دسترس باشد؛ و از این سه، فقط میانگین موزون و
    // FIFO در فهرست استاندارد حسابداری شماره ۸ ایران‌اند — «آخرین قیمت
    // خرید» روش رایج بازار است ولی در آن فهرست نیست.
    const costing = find(gs, "costing.method");
    assert.deepEqual(
      costing.options?.map((o) => o.value).sort(),
      ["fifo", "last_purchase", "moving_weighted_average"],
    );
    // پیش‌فرض، تصمیم مالک است: «آخرین قیمت خرید»، مثل هلو.
    assert.equal(costing.value, "last_purchase", "پیش‌فرض باید آخرین قیمت خرید باشد");

    // بستن خودکار فروش سایت باید یک کلید بله/خیر باشد.
    assert.equal(find(gs, "sales.auto_close_channel_day").kind, "bool");
    assert.equal(find(gs, "sales.auto_close_after_hours").unit, "ساعت");

    // سند فروش: فقط گزینه‌ای که **واقعاً پیاده شده** در فهرست است.
    //
    // تا مهاجرت ۰۲۴، «per_invoice» هم بود ولی هیچ کدی نمی‌خواندش —
    // مالک می‌توانست انتخابش کند و سیستم بی‌سروصدا همان تجمیعی را
    // ادامه دهد. تنظیمی که کار نکند از نبودنش بدتر است.
    const posting = find(gs, "ledger.sale_posting");
    assert.deepEqual(posting.options?.map((o) => o.value), ["per_shift"]);
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
      // «lifo» عمداً: چیزی که هیچ‌وقت روش قیمت‌گذاری این پروژه نمی‌شود.
      ["costing.method", "lifo"],
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
    const r = await patch(admin, "return.window_hours", 72);
    assert.equal(r.statusCode, 409, r.body);
    assert.match((JSON.parse(r.body) as { error: { message: string } }).error.message, /دلیل/);
  });

  test("مهلت مرجوعی به ساعت است و ۴۸ ساعت پیش‌فرض است", async () => {
    // «۲ روز» نمی‌توانست ۴۸ ساعت را بیان کند: گرد کردن روز، ۷۱ ساعت را
    // هم داخل مهلت می‌شمرد. کلید قدیمی حذف شده، نه اینکه کنارش بماند.
    const gs = await groups(admin);
    const w = find(gs, "return.window_hours");
    assert.equal(w.unit, "ساعت");
    assert.equal(w.kind, "int");

    const all = gs.flatMap((g) => g.settings).map((x) => x.key);
    assert.ok(!all.includes("return.window_days"), "کلید قدیمی نباید مانده باشد");

    const r = await patch(admin, "return.window_hours", 24, "تست تغییر مهلت");
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(find(await groups(admin), "return.window_hours").value, 24);
    await patch(admin, "return.window_hours", 48, "بازگشت به پیش‌فرض");
  });

  test("کارمزد و دوره تسویه کارت‌خوان از تنظیمات عوض می‌شوند", async () => {
    // عمداً در `platform.setting` نیست: این دو عدد از قبل در
    // `treasury.account` هستند و همان‌جاست که سند تسویه می‌خواندشان.
    // یک کلید سراسری یعنی کارت‌خوان فروشگاه و درگاه سایت ناچار یک
    // کارمزد داشته باشند — که تقریباً هرگز درست نیست.
    const s = await loginAs(admin);
    const r = await app.inject({ method: "GET", url: "/settlement-terms", ...s });
    assert.equal(r.statusCode, 200, r.body);
    const terms = (JSON.parse(r.body) as { terms: Array<Record<string, unknown>> }).terms;
    assert.equal(terms.length, 2, "کارت‌خوان و درگاه");

    const pos = terms.find((t) => t.code === "POS-1");
    assert.ok(pos, "کارت‌خوان در فهرست نیست");
    assert.equal(pos.settlementDays, 1, "کارت‌خوان فردای همان روز تسویه می‌کند");
    assert.equal(typeof pos.feePercent, "string", "کارمزد رشته است، نه عدد");

    const upd = await app.inject({
      method: "PATCH",
      url: `/settlement-terms/${pos.id as string}`,
      ...s,
      payload: { settlementDays: 1, feePercent: "0.235", reason: "قرارداد PSP" },
    });
    assert.equal(upd.statusCode, 200, upd.body);
    assert.equal((JSON.parse(upd.body) as { feePercent: string }).feePercent, "0.235");

    // سقف ۱۰٪ — عددی مثل ۱۵ تقریباً همیشه یعنی درصد و مبلغ اشتباه
    // گرفته شده، و آن اشتباه هر روز در سند تسویه ضرب می‌شود.
    const bad = await app.inject({
      method: "PATCH",
      url: `/settlement-terms/${pos.id as string}`,
      ...s,
      payload: { settlementDays: 1, feePercent: "15", reason: "تست" },
    });
    assert.equal(bad.statusCode, 409, bad.body);
  });

  test("دستگاه تازه از تنظیمات اضافه می‌شود و «پیاده‌شده» نمی‌آید", async () => {
    // خواسته مالک: «مستندات SDK درایور کارت‌خوان باید از طریق تنظیمات
    // قابل جایگزاری یا تغییر باشد، چون هم ممکن است کارت‌خوان‌ها عوض
    // شوند و هم ممکن است زیادتر شوند.» تا مهاجرت ۰۴۷، جدولش بود ولی
    // دستگیره‌اش نه — رسیدن یک PSP تازه باز هم psql می‌خواست.
    const s = await loginAs(admin);
    const put = await app.inject({
      method: "PUT",
      url: "/device-drivers/novinpay",
      ...s,
      payload: {
        label: "پرداخت نوین",
        deviceKind: "card_terminal",
        vendor: "نوین",
        sdkDocUrl: "https://docs.example.com/novinpay",
        notes: "پروتکل نسخه ۲.۱",
        reason: "کارت‌خوان تازه",
      },
    });
    assert.equal(put.statusCode, 200, put.body);
    const made = JSON.parse(put.body) as { code: string; isImplemented: boolean; isActive: boolean };
    assert.equal(made.code, "novinpay");
    // ⚠️ بحرانی. ثبت یعنی «مستنداتش را داریم»، نه «کار می‌کند». اگر
    // این از صفحه تنظیمات روشن می‌شد، مالک پایانه را به دستگاهی وصل
    // می‌کرد که کدش نوشته نشده و اولین پرداخت واقعی در سکوت شکست
    // می‌خورد.
    assert.equal(made.isImplemented, false, "دستگاه تازه نباید پیاده‌شده باشد");
    assert.equal(made.isActive, true);

    // ویرایش: همان کد، مستندات تازه.
    const edit = await app.inject({
      method: "PUT",
      url: "/device-drivers/novinpay",
      ...s,
      payload: {
        label: "پرداخت نوین",
        deviceKind: "card_terminal",
        sdkDocUrl: "https://docs.example.com/novinpay/v3",
        reason: "مستندات تازه رسید",
      },
    });
    assert.equal(edit.statusCode, 200, edit.body);
    assert.equal(
      (JSON.parse(edit.body) as { sdkDocUrl: string }).sdkDocUrl,
      "https://docs.example.com/novinpay/v3",
    );

    // اتصال پایانه به دستگاهی که کدش نوشته نشده، رد می‌شود.
    const terms = await app.inject({ method: "GET", url: "/terminal-drivers", ...s });
    const t = (JSON.parse(terms.body) as { terminals: Array<{ accountId: string }> }).terminals[0];
    const bad = await app.inject({
      method: "PATCH",
      url: `/terminal-drivers/${t!.accountId}`,
      ...s,
      payload: { driverCode: "novinpay" },
    });
    assert.equal(bad.statusCode, 409, bad.body);

    // بازنشستگی: از فهرست انتخاب بیرون می‌رود ولی حذف نمی‌شود.
    const off = await app.inject({
      method: "PATCH",
      url: "/device-drivers/novinpay/active",
      ...s,
      payload: { isActive: false, reason: "قرارداد لغو شد" },
    });
    assert.equal(off.statusCode, 200, off.body);
    assert.equal((JSON.parse(off.body) as { isActive: boolean }).isActive, false);

    const live = await app.inject({ method: "GET", url: "/device-drivers", ...s });
    const liveCodes = (JSON.parse(live.body) as { drivers: Array<{ code: string }> })
      .drivers.map((d) => d.code);
    assert.ok(!liveCodes.includes("novinpay"), "بازنشسته در فهرست پیش‌فرض نمی‌آید");

    // ⚠️ بدون این، برگرداندن یک درایور بازنشسته فقط از psql ممکن بود.
    const withRetired = await app.inject({
      method: "GET", url: "/device-drivers?includeRetired=1", ...s,
    });
    const allCodes = (JSON.parse(withRetired.body) as { drivers: Array<{ code: string }> })
      .drivers.map((d) => d.code);
    assert.ok(allCodes.includes("novinpay"), "بازنشسته باید با پرچم دیده شود");

    const on = await app.inject({
      method: "PATCH",
      url: "/device-drivers/novinpay/active",
      ...s,
      payload: { isActive: true },
    });
    assert.equal(on.statusCode, 200, on.body);
  });

  test("ورودی بد رجیستری درایور ۴۰۹ می‌گیرد، نه ۵۰۰", async () => {
    // دفاعی که شبیه خرابی سرور گزارش شود، در عمل خاموش است.
    const s = await loginAs(admin);
    const cases: Array<[string, Record<string, unknown>]> = [
      // نشانی مستندات را مالک کلیک می‌کند — https اجباری است.
      ["httpurl", { label: "x", deviceKind: "card_terminal", sdkDocUrl: "http://a.example" }],
      // نوع ناشناخته: CHECK جدول ۲۳۵۱۴ می‌داد که ۵۰۰ گزارش می‌شود.
      ["badkind", { label: "x", deviceKind: "robot" }],
      // ⚠️ راز در `audit_log` می‌نشیند و صفحه تنظیمات نشانش می‌دهد.
      ["secretnote", { label: "x", deviceKind: "card_terminal", notes: "api_key: ABC123" }],
    ];
    for (const [code, payload] of cases) {
      const r = await app.inject({
        method: "PUT", url: `/device-drivers/${code}`, ...s, payload,
      });
      assert.equal(r.statusCode, 409, `${code}: ${r.body}`);
    }
    const live = await app.inject({
      method: "GET", url: "/device-drivers?includeRetired=1", ...s,
    });
    const codes = (JSON.parse(live.body) as { drivers: Array<{ code: string }> })
      .drivers.map((d) => d.code);
    for (const [code] of cases) {
      assert.ok(!codes.includes(code), `${code} نباید نشسته باشد`);
    }
  });

  test("حسابدار درایور اضافه نمی‌کند", async () => {
    // فهرست درایورها تعیین می‌کند مالک از میان چه چیزهایی کارت‌خوان
    // فروشگاه را انتخاب کند — پشت همان `settings.security`.
    const s = await loginAs(accountant);
    const r = await app.inject({
      method: "PUT",
      url: "/device-drivers/sneaky",
      ...s,
      payload: { label: "x", deviceKind: "card_terminal" },
    });
    assert.equal(r.statusCode, 403, r.body);
  });

  test("حسابدار کارمزد را نمی‌بیند-قابل-تغییر و نمی‌تواند عوضش کند", async () => {
    const s = await loginAs(accountant);
    const r = await app.inject({ method: "GET", url: "/settlement-terms", ...s });
    assert.equal(r.statusCode, 200, r.body);
    const terms = (JSON.parse(r.body) as { terms: Array<{ canEdit: boolean }> }).terms;
    assert.ok(terms.every((t) => !t.canEdit), "حسابدار settings.security ندارد");

    const pos = (JSON.parse(r.body) as { terms: Array<{ id: string }> }).terms[0];
    const upd = await app.inject({
      method: "PATCH",
      url: `/settlement-terms/${pos!.id}`,
      ...s,
      payload: { settlementDays: 5, feePercent: "1", reason: "تست" },
    });
    assert.equal(upd.statusCode, 403, upd.body);
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
  // ── کدینگ حساب ──────────────────────────────────────────────────

  test("درخت حساب چهارسطحی از API می‌آید", async () => {
    const s = await loginAs(admin);
    const r = await app.inject({ method: "GET", url: "/accounts", ...s });
    assert.equal(r.statusCode, 200, r.body);

    const accounts = r.json().accounts as Array<Record<string, unknown>>;
    assert.ok(accounts.length >= 50, `تعداد حساب: ${accounts.length}`);

    // چهار سطح، همان چیزی که هلو دارد
    const levels = new Set(accounts.map((a) => a.level));
    assert.ok(levels.has("group"), "سطح گروه نیست");
    assert.ok(levels.has("kol"), "سطح کل نیست");
    assert.ok(levels.has("moin"), "سطح معین نیست");

    // صفحه بدون این دو نمی‌داند اجازه چه تغییری بدهد
    const root = accounts.find((a) => a.code === "1");
    assert.equal(root?.hasChildren, true, "گروه ۱ باید فرزند داشته باشد");
    assert.equal(typeof root?.hasEntries, "boolean");
  });

  test("ساخت و ویرایش حساب از API", async () => {
    const s = await loginAs(admin);
    const put = (code: string, body: Record<string, unknown>) =>
      app.inject({ method: "PUT", url: `/accounts/${code}`, ...s, payload: body });

    const made = await put("8", {
      name: "گروه آزمایشی",
      level: "group",
      parentCode: null,
      nature: "debit",
      type: "asset",
      isPostable: false,
    });
    assert.equal(made.statusCode, 200, made.body);
    assert.equal(made.json().level, "group");

    // ویرایش نام، همان حساب را عوض می‌کند
    const edited = await put("8", {
      name: "گروه آزمایشی ویرایش‌شده",
      level: "group",
      parentCode: null,
      nature: "debit",
      type: "asset",
      isPostable: false,
    });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.equal(edited.json().name, "گروه آزمایشی ویرایش‌شده");

    // غیرفعال‌سازی به‌جای حذف
    const off = await app.inject({
      method: "PATCH",
      url: "/accounts/8/active",
      ...s,
      payload: { isActive: false },
    });
    assert.equal(off.statusCode, 200, off.body);
    assert.equal(off.json().isActive, false);
  });

  test("درختِ خراب ۴۰۹ می‌گیرد، نه ۵۰۰", async () => {
    // نگهبان‌های مهاجرت ۰۱۹ باید از راه API هم پیام فارسی بدهند، نه
    // «خطای داخلی» — همان الگویی که این مخزن سه بار اصلاحش کرده.
    const s = await loginAs(admin);
    const bad = await app.inject({
      method: "PUT",
      url: "/accounts/9999",
      ...s,
      payload: {
        name: "کدِ بی‌ربط به والد",
        level: "moin",
        parentCode: "11",
        nature: "debit",
        type: "asset",
        isPostable: true,
      },
    });
    assert.equal(bad.statusCode, 409, bad.body);
    assert.equal(bad.json().error.code, "rule_violation");
  });

  test("صندوق‌دار کدینگ حساب را عوض نمی‌کند", async () => {
    const s = await loginAs(cashier);
    const r = await app.inject({
      method: "PUT",
      url: "/accounts/8",
      ...s,
      payload: {
        name: "تلاش صندوق‌دار",
        level: "group",
        parentCode: null,
        nature: "debit",
        type: "asset",
        isPostable: false,
      },
    });
    assert.equal(r.statusCode, 403, r.body);
  });

  // ── سقف مجوزها ──────────────────────────────────────────────────

  test("ماتریس مجوز از API می‌آید و پول رشته است", async () => {
    const s = await loginAs(admin);
    const r = await app.inject({ method: "GET", url: "/permission-rules", ...s });
    assert.equal(r.statusCode, 200, r.body);

    const rules = r.json().rules as Array<Record<string, unknown>>;
    assert.ok(rules.length > 0, "ماتریس خالی است");

    for (const rule of rules) {
      if (rule.maxAmount !== null) {
        assert.equal(typeof rule.maxAmount, "string", `${rule.operation}: پول باید رشته باشد`);
      }
    }
  });

  test("سقف تخفیف از API عوض می‌شود", async () => {
    const s = await loginAs(admin);
    const r = await app.inject({
      method: "PUT",
      url: "/permission-rules/cashier/sale.discount",
      ...s,
      payload: {
        allowed: true,
        maxAmount: null,
        maxPercent: 15,
        needsApprovalFrom: null,
        reason: "تست سقف تخفیف",
      },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().maxPercent, 15);
  });

  test("بستن آخرین نقشِ دارای «settings.security» ۴۰۹ می‌گیرد", async () => {
    // مهم‌ترین نگهبان این صفحه: بی‌آن، یک کلیک می‌توانست همه را برای
    // همیشه از تغییر مجوزها بیرون بگذارد و تنها راه بازگشت psql بود.
    const s = await loginAs(admin);
    const r = await app.inject({
      method: "PUT",
      url: "/permission-rules/admin/settings.security",
      ...s,
      payload: {
        allowed: false,
        maxAmount: null,
        maxPercent: null,
        needsApprovalFrom: null,
        reason: "تست قفل‌شدن",
      },
    });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error.code, "rule_violation");
  });

  test("حسابدار سقف مجوز را عوض نمی‌کند", async () => {
    const s = await loginAs(accountant);
    const r = await app.inject({
      method: "PUT",
      url: "/permission-rules/cashier/sale.discount",
      ...s,
      payload: {
        allowed: true,
        maxAmount: null,
        maxPercent: 90,
        needsApprovalFrom: null,
      },
    });
    assert.equal(r.statusCode, 403, r.body);
  });
  // ── تفصیلی و افتتاحیه ───────────────────────────────────────────

  test("تفصیلی اشخاص از API می‌آید و پول رشته است", async () => {
    const s = await loginAs(admin);
    const r = await app.inject({ method: "GET", url: "/tafsili", ...s });
    assert.equal(r.statusCode, 200, r.body);
    const rows = r.json().rows as Array<Record<string, unknown>>;
    for (const row of rows) {
      assert.equal(typeof row.balance, "string", "مانده باید رشته باشد");
      assert.equal(typeof row.code, "string");
    }
  });

  test("سند افتتاحیه نامتوازن ۴۰۹ فارسی می‌گیرد", async () => {
    // توازن **پیش از ثبت** سنجیده می‌شود تا کاربر پیام قابل فهم
    // بگیرد، نه خطای فنی قید معوق دفتر.
    const s = await loginAs(admin);
    const r = await app.inject({
      method: "POST",
      url: "/opening-balance",
      ...s,
      payload: {
        branchId: BRANCH,
        fiscalYear: 1405,
        legs: [
          { leg: "cash", amount: "5000000" },
          { leg: "equity", amount: "4000000" },
        ],
      },
    });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error.code, "rule_violation");
    assert.match(r.json().error.message, /متوازن/);
  });

  test("سند افتتاحیه متوازن ثبت می‌شود", async () => {
    const s = await loginAs(admin);
    const r = await app.inject({
      method: "POST",
      url: "/opening-balance",
      ...s,
      payload: {
        branchId: BRANCH,
        fiscalYear: 1405,
        legs: [
          { leg: "cash", amount: "5000000" },
          { leg: "equity", amount: "5000000" },
        ],
      },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(typeof r.json().entryId, "string");
  });

  test("صندوق‌دار سند افتتاحیه نمی‌زند", async () => {
    const s = await loginAs(cashier);
    const r = await app.inject({
      method: "POST",
      url: "/opening-balance",
      ...s,
      payload: {
        branchId: BRANCH,
        fiscalYear: 1405,
        legs: [{ leg: "cash", amount: "1" }, { leg: "equity", amount: "1" }],
      },
    });
    assert.equal(r.statusCode, 403, r.body);
  });
});
