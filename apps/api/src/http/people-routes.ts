/**
 * مسیرهای پرسنل و مشتری.
 *
 * ── چرا یک فایل برای دو موجودیت ──────────────────────────────────
 *
 * هر دو «آدم»اند و هر دو یک قاعده مشترک دارند که اگر جدا نوشته شوند
 * دیر یا زود از هم جدا می‌افتد: **حذف نمی‌شوند.** فاکتور پارسال هم به
 * `created_by` ارجاع می‌دهد هم به `customer_id`. غیرفعال‌کردن یک
 * وضعیت است، نه یک `DELETE`.
 *
 * ── مجوز ─────────────────────────────────────────────────────────
 *
 *   user.manage       ساخت و ویرایش پرسنل، نقش، رمز، PIN — فقط مدیر
 *   customer.manage   پرونده مشتری — مدیر، سرپرست، بازاریاب
 *
 * جدا هستند چون کارهای متفاوتی‌اند: بازاریاب باید پرونده مشتری را
 * ببیند و رضایت پیامکش را عوض کند، ولی هرگز نباید بتواند کاربر بسازد.
 *
 * هر دو در `auth.pin_forbidden_operations` هم می‌روند: نشستی که با PIN
 * باز شده نباید بتواند کاربر بسازد یا سقف اعتبار مشتری را بالا ببرد.
 *
 * ── رمز، یک بار و تمام ───────────────────────────────────────────
 *
 * `POST /users` و `POST /users/:id/reset-password` متن خام رمز را
 * **فقط در همان پاسخ** برمی‌گردانند. هیچ مسیری برای خواندن دوباره‌اش
 * نیست و هیچ‌جا ذخیره نمی‌شود.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AuthError } from "../auth/service.ts";
import { requireForSession } from "../auth/permission.ts";
import type { Db } from "../db/client.ts";
import { parseMoney } from "../lib/money.ts";
import { assertBranch, branchesOf, ScopeError } from "../sales/scope.ts";
import { UserError, type UserService } from "../people/user.ts";
import { CustomerError, type CustomerService } from "../people/customer.ts";

const uuid = z.string().uuid("شناسه نامعتبر");
const moneyString = z
  .string()
  .regex(/^\d+$/, "مبلغ باید رقم صحیح باشد (ریال، بدون اعشار)");

/**
 * نقش‌ها همیشه **فهرست کامل**اند، نه تفاضلی.
 *
 * `branchId` تهی یعنی «همه شعبه‌ها» — همان معنایی که
 * `identity.user_role.branch_id IS NULL` دارد و `branchesOf` می‌خواند.
 */
const roleAssignment = z.object({
  roleCode: z.string().min(1).max(32),
  branchId: uuid.nullable().default(null),
});

const createUserBody = z.object({
  username: z
    .string()
    .trim()
    .min(3, "نام کاربری حداقل ۳ کاراکتر")
    .max(32)
    // فاصله و حرف فارسی در نام کاربری یعنی کاربری که نمی‌تواند وارد
    // شود چون نمی‌داند دقیقاً چه تایپ کند.
    .regex(/^[a-z0-9._-]+$/, "نام کاربری فقط حروف کوچک انگلیسی، رقم، نقطه، خط تیره"),
  fullName: z.string().trim().min(2).max(120),
  mobile: z.string().trim().max(20).optional(),
  roles: z.array(roleAssignment).min(1, "حداقل یک نقش لازم است"),
});

const updateUserBody = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  mobile: z.string().trim().max(20).nullable().optional(),
  isActive: z.boolean().optional(),
});

const resetPasswordBody = z.object({
  password: z.string().min(12, "رمز عبور حداقل ۱۲ کاراکتر").max(256).optional(),
});

/**
 * PIN — چهار تا شش رقم، یا `null` برای برداشتن.
 *
 * طولش اینجا محدود می‌شود ولی **امنیتش از اینجا نمی‌آید**: چهار رقم
 * ۱۰٬۰۰۰ حالت دارد و هیچ الگوریتمی نجاتش نمی‌دهد. دفاع واقعی در
 * `docs/SECURITY.md` بند ۱ است — دستگاه ثبت‌شده، ورود کامل پیشین،
 * قفل پس از ۵ تلاش، و ممنوع‌بودن عملیات حساس.
 */
const pinBody = z.object({
  pin: z
    .string()
    .regex(/^\d{4,6}$/, "PIN باید ۴ تا ۶ رقم باشد")
    .nullable(),
});

const upsertCustomerBody = z.object({
  mobile: z.string().trim().min(8).max(20),
  fullName: z.string().trim().max(120).optional(),
  email: z.email("ایمیل نامعتبر").optional(),
  consentSms: z.boolean().optional(),
  consentMarketing: z.boolean().optional(),
});

const updateCustomerBody = z.object({
  fullName: z.string().trim().max(120).nullable().optional(),
  email: z.email("ایمیل نامعتبر").nullable().optional(),
  status: z.enum(["active", "blocked"]).optional(),
  creditLimit: moneyString.optional(),
  dueDays: z.number().int().min(0).max(365).optional(),
  consentSms: z.boolean().optional(),
  consentMarketing: z.boolean().optional(),
  internalNote: z.string().max(1000).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  // ⚠️ کد پستی اینجا فقط طول می‌گیرد، نه قالب: نرمال‌سازی و سنجش ده
  // رقم در `sales.normalize_postal_code` است. اگر Zod هم می‌سنجید، دو
  // تعریف داشتیم و آن که در psql دور زده می‌شود همان است که اهمیت
  // دارد — همان قاعده تنظیمات.
  postalCode: z.string().trim().max(20).nullable().optional(),
  city: z.string().trim().max(60).nullable().optional(),
  province: z.string().trim().max(60).nullable().optional(),
});

/**
 * اندازه‌های بدن — نگاشت کلید به عدد.
 *
 * مقدار `number` است نه رشته، و این با قاعده «پول رشته است» تعارضی
 * ندارد: اندازه پول نیست. `numeric(6,1)` است و در محدوده‌ای که
 * `number` جاوااسکریپت دقیق نگهش می‌دارد.
 *
 * بازه‌ها اینجا **سنجیده نمی‌شوند** — از `sales.measure_key` می‌آیند و
 * مالک می‌تواند عوضشان کند.
 */
const measuresBody = z.object({
  values: z.record(
    z.string().min(1).max(40),
    z.number().finite().min(0).max(10000),
  ),
});

export interface PeopleRouteDeps {
  db: Db;
  users: UserService;
  customers: CustomerService;
}

export function registerPeopleRoutes(app: FastifyInstance, deps: PeopleRouteDeps): void {
  const { db, users, customers } = deps;

  const session = (req: { session: unknown }) => {
    const s = req.session as
      | { userId: string; pinUnlocked: boolean; fullName: string }
      | null;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    return s;
  };

  /**
   * نقشی که به شعبه‌ای بند است، فقط از کسی که خودش آن شعبه را دارد.
   *
   * بدون این، کاربری با دامنه یک شعبه می‌توانست کاربر تازه‌ای برای
   * شعبه دیگر بسازد و از راه او داده‌ای را ببیند که خودش حق دیدنش را
   * ندارد. `branchId` تهی («همه شعبه‌ها») فقط از کسی که خودش دامنه
   * کامل دارد.
   */
  async function assertRolesInScope(
    userId: string,
    roles: Array<{ branchId: string | null }>,
  ): Promise<void> {
    for (const r of roles) {
      if (r.branchId === null) {
        // «همه شعبه‌ها» یعنی دامنه کامل. سنجشش با یک شعبه بی‌معناست،
        // پس دامنه خودِ دهنده خوانده می‌شود.
        const scope = await branchesOf(db, userId);
        if (scope !== "all") {
          throw new UserError(
            "scope_escalation",
            "نقش بدون شعبه (دسترسی همه شعبه‌ها) را فقط کسی می‌دهد که خودش این دامنه را دارد.",
            403,
          );
        }
        continue;
      }
      await assertBranch(db, userId, r.branchId);
    }
  }

  /**
   * Customer records are company-wide: the table has no branch key and a
   * single customer may buy from several branches.  Until that model carries
   * an explicit per-branch association, a branch-bound role must not read or
   * mutate the global record (or its cross-branch financial history).
   */
  async function requireGlobalCustomerAccess(
    s: { userId: string; pinUnlocked: boolean },
  ): Promise<void> {
    await requireForSession(db, s, "customer.manage");
    if ((await branchesOf(db, s.userId)) !== "all") {
      throw new ScopeError("پرونده مشتریان سراسری است و به دسترسی همه شعبه‌ها نیاز دارد");
    }
  }

  // ── پرسنل ────────────────────────────────────────────────────────

  app.get("/users", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "user.manage");
    const q = z
      .object({ includeInactive: z.coerce.boolean().default(false) })
      .parse(req.query);
    return { users: await users.list(q.includeInactive) };
  });

  app.get("/users/:id", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await requireForSession(db, s, "user.manage");
    const u = await users.byId(id);
    if (!u) throw new UserError("user_not_found", "کاربر یافت نشد", 404);
    return u;
  });

  app.get("/roles", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "user.manage");
    const rows = await db
      .selectFrom("identity.role")
      .select(["code", "name"])
      .orderBy("code")
      .execute();
    return { roles: rows.map((r) => ({ code: r.code, name: r.name })) };
  });

  app.post("/users", async (req, reply) => {
    const s = session(req);
    const body = createUserBody.parse(req.body);
    await requireForSession(db, s, "user.manage");
    await assertRolesInScope(s.userId, body.roles);

    const out = await users.create({
      username: body.username,
      fullName: body.fullName,
      roles: body.roles,
      actorId: s.userId,
      ...(body.mobile === undefined ? {} : { mobile: body.mobile }),
    });

    // ⚠️ تنها جایی که متن خام رمز دیده می‌شود. هیچ‌جا ذخیره نشده و
    //    هیچ مسیری برای خواندن دوباره‌اش نیست.
    return reply.code(201).send({
      id: out.id,
      password: out.password,
      note: "این رمز فقط همین یک بار نشان داده می‌شود. آن را به کاربر بدهید و ذخیره‌اش نکنید.",
    });
  });

  app.patch("/users/:id", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = updateUserBody.parse(req.body);
    await requireForSession(db, s, "user.manage");

    await users.update({
      id,
      actorId: s.userId,
      ...(body.fullName === undefined ? {} : { fullName: body.fullName }),
      ...(body.mobile === undefined ? {} : { mobile: body.mobile }),
      ...(body.isActive === undefined ? {} : { isActive: body.isActive }),
    });
    return await users.byId(id);
  });

  app.put("/users/:id/roles", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ roles: z.array(roleAssignment).min(1) }).parse(req.body);
    await requireForSession(db, s, "user.manage");
    await assertRolesInScope(s.userId, body.roles);

    await users.setRoles({ id, roles: body.roles, actorId: s.userId });
    return await users.byId(id);
  });

  app.post("/users/:id/reset-password", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = resetPasswordBody.parse(req.body ?? {});
    await requireForSession(db, s, "user.manage");

    const password = await users.resetPassword(id, s.userId, body.password);
    return {
      password,
      note: "این رمز فقط همین یک بار نشان داده می‌شود. همه نشست‌های این کاربر بسته شد.",
    };
  });

  app.put("/users/:id/pin", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = pinBody.parse(req.body);
    await requireForSession(db, s, "user.manage");

    await users.setPin(id, body.pin, s.userId);
    return { ok: true, hasPin: body.pin !== null };
  });

  // ── مشتری ────────────────────────────────────────────────────────

  app.get("/customers", async (req) => {
    const s = session(req);
    await requireGlobalCustomerAccess(s);
    const q = z
      .object({
        q: z.string().trim().max(64).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    return {
      customers: await customers.search({
        limit: q.limit,
        ...(q.q === undefined ? {} : { q: q.q }),
      }),
    };
  });

  app.get("/customers/:id", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await requireGlobalCustomerAccess(s);
    const c = await customers.byId(id);
    if (!c) throw new CustomerError("customer_not_found", "مشتری یافت نشد", 404);
    return { customer: c, invoices: await customers.invoices(id, 50) };
  });

  /**
   * ساخت یا یافتن با موبایل.
   *
   * `Idempotency-Key` نمی‌خواهد و نباید بخواهد: خودِ عملیات
   * تکرارپذیر است — شماره تکراری مشتری دوم نمی‌سازد، همان را
   * برمی‌گرداند. پاسخ می‌گوید ساخته شد یا پیدا.
   */
  app.post("/customers", async (req, reply) => {
    const s = session(req);
    const body = upsertCustomerBody.parse(req.body);
    await requireGlobalCustomerAccess(s);

    const out = await customers.upsert({
      mobile: body.mobile,
      actorId: s.userId,
      ...(body.fullName === undefined ? {} : { fullName: body.fullName }),
      ...(body.email === undefined ? {} : { email: body.email }),
      ...(body.consentSms === undefined ? {} : { consentSms: body.consentSms }),
      ...(body.consentMarketing === undefined
        ? {}
        : { consentMarketing: body.consentMarketing }),
    });

    const c = await customers.byId(out.id);
    return reply.code(out.created ? 201 : 200).send({ ...c, created: out.created });
  });

  app.patch("/customers/:id", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = updateCustomerBody.parse(req.body);
    await requireGlobalCustomerAccess(s);

    await customers.update({
      id,
      actorId: s.userId,
      ...(body.fullName === undefined ? {} : { fullName: body.fullName }),
      ...(body.email === undefined ? {} : { email: body.email }),
      ...(body.status === undefined ? {} : { status: body.status }),
      ...(body.creditLimit === undefined
        ? {}
        : { creditLimit: parseMoney(body.creditLimit) }),
      ...(body.dueDays === undefined ? {} : { dueDays: body.dueDays }),
      ...(body.consentSms === undefined ? {} : { consentSms: body.consentSms }),
      ...(body.consentMarketing === undefined
        ? {}
        : { consentMarketing: body.consentMarketing }),
      ...(body.internalNote === undefined ? {} : { internalNote: body.internalNote }),
      ...(body.address === undefined ? {} : { address: body.address }),
      ...(body.postalCode === undefined ? {} : { postalCode: body.postalCode }),
      ...(body.city === undefined ? {} : { city: body.city }),
      ...(body.province === undefined ? {} : { province: body.province }),
    });
    return await customers.byId(id);
  });

  /**
   * کلیدهای اندازه — برچسب، واحد و بازه.
   *
   * پشت `customer.manage` مثل بقیه پرونده مشتری. فرم شناسنامه از
   * همین پاسخ ساخته می‌شود، پس اندازه تازه‌ای که فردا در Seed اضافه
   * شود بدون یک خط کد UI دیده می‌شود.
   */
  /**
   * کالاهای مناسب یک مشتری — «برای خودش می‌خرد».
   *
   * ⚠️ این **پیشنهاد** است نه حکم، و **AI نیست**.
   *
   * CLAUDE.md صریح می‌گوید «AI پیشنهاد سایز» ساخته نشود، و درست
   * است: مدلی که سایز پیشنهاد دهد باید روی داده فروش و مرجوعیِ همین
   * فروشگاه آموزش ببیند، و آن داده هنوز وجود ندارد.
   *
   * آنچه اینجا هست حساب فاصله است: هر اندازه بدن با اندازه همان کلید
   * روی کالا مقایسه می‌شود، تقسیم بر تحملِ همان کلید. قابل توضیح،
   * قابل بازرسی، بدون ادعایی که نتواند اثباتش کند.
   *
   * ⚠️ کالای بدون اندازه **حذف نمی‌شود** — `matchScore: null` می‌گیرد
   * و آخر فهرست می‌نشیند. حذفش یعنی فروشگاه نصف ویترینش را نشان
   * ندهد چون انباردار هنوز اندازه‌ها را وارد نکرده.
   */
  app.get("/customers/:id/fitting", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const q = z
      .object({
        warehouseId: uuid.optional(),
        minScore: z.coerce.number().min(0).max(1).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    await requireGlobalCustomerAccess(s);

    const allowed = await branchesOf(db, s.userId);
    if (q.warehouseId !== undefined) {
      const warehouse = await db.selectFrom("inventory.warehouse")
        .select("branch_id").where("id", "=", q.warehouseId).executeTakeFirst();
      if (!warehouse) throw new ScopeError("انبار یافت نشد");
      if (allowed !== "all" && !allowed.includes(warehouse.branch_id)) {
        throw new ScopeError("به این شعبه دسترسی ندارید");
      }
    }
    // دامنه پیش از جمع موجودی و LIMIT اعمال می‌شود، نه روی نتیجه محدودشده.
    return { variations: await customers.fitting(id, q, allowed) };
  });

  app.get("/measure-keys", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "customer.manage");
    return { keys: await customers.measureKeys() };
  });

  app.get("/customers/:id/measures", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await requireGlobalCustomerAccess(s);
    return { measures: await customers.measuresOf(id) };
  });

  /**
   * جایگزینی کامل اندازه‌ها.
   *
   * `PUT` است نه `PATCH` و `Idempotency-Key` نمی‌خواهد — همان قاعده
   * انبارگردانی: «دوباره اندازه گرفتم و این عدد است». ارسال دوباره
   * همان بدنه، همان نتیجه را می‌دهد.
   */
  app.put("/customers/:id/measures", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = measuresBody.parse(req.body);
    await requireGlobalCustomerAccess(s);
    return {
      measures: await customers.setMeasures({
        id,
        values: body.values,
        actorId: s.userId,
      }),
    };
  });
}
