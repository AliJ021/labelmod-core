/**
 * پرونده مشتری.
 *
 * تا امروز مشتری فقط از یک مسیر ساخته می‌شد: سفارش سایت، با موبایل
 * (`web-order.ts`). یعنی مشتری حضوری اصلاً وارد سیستم نمی‌شد و
 * «دریافتنی از فلانی» هیچ نامی نداشت.
 *
 * ── موبایل کلید تطبیق است، نه کلید اصلی ──────────────────────────
 *
 * `mobile_normalized` را **دیتابیس** می‌سازد (`sales.normalize_mobile`)
 * تا «۰۹۱۲…»، «+۹۸۹۱۲…» و «۹۱۲…» یک نفر شوند. نرمال‌سازی در
 * TypeScript یعنی روزی دو تعریف داشته باشیم و همان روز مشتری دو حساب
 * پیدا کند — و مانده‌اش بین دو حساب گم شود.
 *
 * ── مشتری حذف نمی‌شود ────────────────────────────────────────────
 *
 * فاکتور پارسال به همین سطر ارجاع می‌دهد. `status` دارد و
 * `merged_into` برای وقتی دو حساب یکی می‌شوند.
 *
 * ── رضایت، صریح و قابل بازپس‌گیری ────────────────────────────────
 *
 * `consent_sms` و `consent_marketing` جدا هستند و پیش‌فرضشان خاموش.
 * پیامک فاکتور با اولی می‌رود و تبلیغات با دومی؛ یکی‌کردنشان یعنی
 * مشتری که فقط فاکتورش را می‌خواهد، تبلیغات هم بگیرد.
 */
import { sql } from "kysely";
import type { Db } from "../db/client.ts";
import { parseMoney, serializeMoney } from "../lib/money.ts";
import { setActor } from "../lib/idempotency.ts";

export class CustomerError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode = 409) {
    super(message);
    this.name = "CustomerError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** یک کلید اندازه، با فراداده‌ای که فرم از آن ساخته می‌شود. */
export interface MeasureKey {
  key: string;
  label: string;
  unit: string;
  minValue: string;
  maxValue: string;
  groupKey: string;
  sortOrder: number;
}

/** اندازه ثبت‌شده یک مشتری. */
export interface CustomerMeasure {
  key: string;
  valueCm: string;
}

export type CustomerBranchScope = readonly string[] | "all";

/** یک کالای پیشنهادی، با امتیاز تناسب. */
export interface FittingVariation {
  variationId: string;
  sku: string;
  productName: string;
  color: string;
  size: string;
  season: string | null;
  onHand: string;
  /** ۰ تا ۱. `null` یعنی اندازه مشترکی نبود — با «نمی‌خورد» یکی نیست. */
  matchScore: number | null;
  /** حکم بر چند پایه استوار است. */
  matchedKeys: number;
}

export interface Customer {
  id: string;
  mobile: string;
  fullName: string | null;
  email: string | null;
  status: string;
  creditLimit: string;
  dueDays: number;
  consentSms: boolean;
  consentMarketing: boolean;
  /** نشانی متن آزاد است — نشانی ایرانی قالب ثابت ندارد. */
  address: string | null;
  /** ده رقم، نرمال‌شده در دیتابیس. `null` یعنی نداریم، نه «خالی». */
  postalCode: string | null;
  city: string | null;
  province: string | null;
  tags: string[];
  internalNote: string | null;
  createdAt: string;
  /** جمع فروش و مانده — از دفتر، نه از یک ستون موازی. */
  invoiceCount: number;
  totalPurchased: string;
  balance: string;
}

interface Row {
  id: string;
  mobile_normalized: string;
  full_name: string | null;
  email: string | null;
  status: string;
  credit_limit: string;
  due_days: number;
  consent_sms: boolean;
  address: string | null;
  postal_code: string | null;
  city: string | null;
  province: string | null;
  consent_marketing: boolean;
  tags: string[] | null;
  internal_note: string | null;
  created_at: Date;
  invoice_count: string;
  total_purchased: string;
  balance: string;
}

function toJson(r: Row): Customer {
  return {
    id: r.id,
    mobile: r.mobile_normalized,
    fullName: r.full_name,
    email: r.email,
    status: r.status,
    creditLimit: serializeMoney(parseMoney(r.credit_limit)),
    dueDays: Number(r.due_days),
    consentSms: r.consent_sms,
    consentMarketing: r.consent_marketing,
    address: r.address,
    postalCode: r.postal_code,
    city: r.city,
    province: r.province,
    tags: r.tags ?? [],
    internalNote: r.internal_note,
    createdAt: r.created_at.toISOString(),
    invoiceCount: Number(r.invoice_count),
    totalPurchased: serializeMoney(parseMoney(r.total_purchased)),
    balance: serializeMoney(parseMoney(r.balance)),
  };
}

/**
 * جمع خرید و مانده — هر دو از منبع خودشان.
 *
 * خرید از فاکتور می‌آید و مانده از **دفتر** (`party_tafsili`). یک
 * ستون «مانده» روی خودِ مشتری یعنی دو مرجع برای یک عدد، و روزی یکی
 * از دیگری عقب می‌ماند — همان دلیلی که «چقدرش رسیده» هم یک نما است
 * نه یک ستون.
 */
const SELECT = sql`
  SELECT c.*,
         (SELECT count(*) FROM sales.invoice i
           WHERE i.customer_id = c.id
             AND i.status IN ('finalized','paid','partially_returned','returned'))::text
           AS invoice_count,
         coalesce((SELECT sum(i.net_amount) FROM sales.invoice i
                    WHERE i.customer_id = c.id
                      AND i.status IN ('finalized','paid','partially_returned','returned')), 0)::text
           AS total_purchased,
         coalesce((SELECT sum(t.balance) FROM ledger.party_tafsili t
                    WHERE t.party_type = 'customer' AND t.party_id = c.id), 0)::text
           AS balance
    FROM sales.customer c
`;

export class CustomerService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * جست‌وجو — **سمت سرور**، نه فیلتر روی فهرست.
   *
   * فهرست سقف دارد و مشتری‌ای که دو سال پیش خرید کرده در آن نمی‌آید؛
   * همان درسی که `GET /receipts/lookup` داد.
   */
  async search(input: {
    q?: string | undefined;
    limit: number;
    branches: CustomerBranchScope;
  }): Promise<Customer[]> {
    const term = (input.q ?? "").trim();
    const branchFilter = input.branches === "all"
      ? sql``
      : sql`AND (
          EXISTS (SELECT 1 FROM sales.customer_branch cb
                   WHERE cb.customer_id = c.id
                     AND cb.branch_id = ANY(${input.branches}::uuid[]))
          OR EXISTS (SELECT 1 FROM sales.invoice si
                      WHERE si.customer_id = c.id
                        AND si.branch_id = ANY(${input.branches}::uuid[]))
        )`;
    const rows = await sql<Row>`
      ${SELECT}
      ${
        term === ""
          ? sql`WHERE c.status <> 'merged' ${branchFilter}`
          : sql`WHERE c.status <> 'merged'
                  AND (c.mobile_normalized LIKE ${`%${term}%`}
                       OR c.full_name ILIKE ${`%${term}%`}
                       OR sales.normalize_mobile(${term}) = c.mobile_normalized)
                  ${branchFilter}`
      }
      ORDER BY c.created_at DESC
      LIMIT ${input.limit}
    `.execute(this.#db);
    return rows.rows.map(toJson);
  }

  /**
   * پرونده برای شعبه‌ای قابل دسترس است که مشتری در آن ساخته شده یا
   * فاکتوری (حتی پیش‌نویس) در آن دارد. مشتری بی‌شعبه فقط برای نقش‌های
   * سراسری قابل دسترس می‌ماند.
   */
  async isAccessible(id: string, branches: CustomerBranchScope): Promise<boolean> {
    if (branches === "all") return true;
    const r = await sql<{ allowed: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM sales.customer_branch cb
         WHERE cb.customer_id = ${id}::uuid
           AND cb.branch_id = ANY(${branches}::uuid[])
        UNION ALL
        SELECT 1 FROM sales.invoice i
         WHERE i.customer_id = ${id}::uuid
           AND i.branch_id = ANY(${branches}::uuid[])
      ) AS allowed
    `.execute(this.#db);
    return r.rows[0]?.allowed ?? false;
  }

  /**
   * کلیدهای اندازه — با برچسب، واحد و بازه.
   *
   * فرم شناسنامه از همین ساخته می‌شود. اگر لازم شد فهرست کلیدها در
   * React نوشته شود، یعنی یک ستون در `sales.measure_key` کم است.
   */
  async measureKeys(): Promise<MeasureKey[]> {
    const r = await sql<{
      key: string; label: string; unit: string;
      min_value: string; max_value: string;
      group_key: string; sort_order: number;
    }>`SELECT key, label, unit, min_value::text, max_value::text,
              group_key, sort_order
         FROM sales.measure_key WHERE is_active
        ORDER BY sort_order, key`.execute(this.#db);
    return r.rows.map((x) => ({
      key: x.key,
      label: x.label,
      unit: x.unit,
      minValue: x.min_value,
      maxValue: x.max_value,
      groupKey: x.group_key,
      sortOrder: Number(x.sort_order),
    }));
  }

  async measuresOf(customerId: string): Promise<CustomerMeasure[]> {
    const r = await sql<{ key: string; value_cm: string }>`
      SELECT m.key, m.value_cm::text
        FROM sales.customer_measure m
        JOIN sales.measure_key k ON k.key = m.key
       WHERE m.customer_id = ${customerId}::uuid
       ORDER BY k.sort_order, m.key
    `.execute(this.#db);
    return r.rows.map((x) => ({ key: x.key, valueCm: x.value_cm }));
  }

  /**
   * جایگزینی کامل اندازه‌ها.
   *
   * اعتبارسنجی بازه در **دیتابیس** است، نه در Zod: بازه از
   * `sales.measure_key` می‌آید و مالک می‌تواند عوضش کند. دو نسخه از
   * یک قاعده یعنی آن که در psql دور زده می‌شود همان است که اهمیت
   * دارد.
   */
  async setMeasures(input: {
    id: string;
    values: Record<string, number>;
    actorId: string;
  }): Promise<CustomerMeasure[]> {
    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, input.actorId);
      await sql`
        SELECT sales.set_customer_measures(
          ${input.id}::uuid, ${JSON.stringify(input.values)}::jsonb, ${input.actorId}::uuid)
      `.execute(trx);
    });
    return await this.measuresOf(input.id);
  }

  async fitting(
    customerId: string,
    q: { warehouseId?: string | undefined; minScore?: number | undefined; limit: number },
    allowedBranches: readonly string[] | "all",
  ): Promise<FittingVariation[]> {
    const r = await sql<{
      variation_id: string; sku: string; product_name: string;
      color: string; size: string; season: string | null;
      on_hand: string; match_score: string | null; matched_keys: number | null;
    }>`SELECT variation_id, sku, product_name, color, size, season,
              on_hand::text, match_score::text, matched_keys
         FROM catalog.fitting_variations(
           ${customerId}::uuid, ${q.warehouseId ?? null}::uuid,
           ${q.minScore ?? null}::numeric, ${q.limit}::int,
           ${allowedBranches === "all" ? null : allowedBranches}::uuid[])`
      .execute(this.#db);
    return r.rows.map((x) => ({
      variationId: x.variation_id,
      sku: x.sku,
      productName: x.product_name,
      color: x.color,
      size: x.size,
      season: x.season,
      // تعداد رشته می‌ماند: `platform.qty` اعشار دارد.
      onHand: x.on_hand,
      // امتیاز یک نسبت است نه پول — ولی `null` باید `null` بماند.
      matchScore: x.match_score === null ? null : Number(x.match_score),
      matchedKeys: Number(x.matched_keys ?? 0),
    }));
  }

  async byId(id: string): Promise<Customer | null> {
    const r = await sql<Row>`${SELECT} WHERE c.id = ${id}::uuid`.execute(this.#db);
    const row = r.rows[0];
    return row === undefined ? null : toJson(row);
  }

  /**
   * ساخت یا یافتن با موبایل.
   *
   * همان رفتار `web-order.ts`: شماره تکراری یک مشتری تازه نمی‌سازد.
   * اگر جدا بود، مشتری‌ای که یک بار آنلاین و یک بار حضوری خرید کند
   * دو حساب داشت و مانده‌اش بین آن دو گم می‌شد.
   */
  async upsert(input: {
    mobile: string;
    fullName?: string | undefined;
    email?: string | undefined;
    consentSms?: boolean | undefined;
    consentMarketing?: boolean | undefined;
    actorId: string;
    branches: CustomerBranchScope;
  }): Promise<{ id: string; created: boolean }> {
    return await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, input.actorId);

      // نرمال‌سازی در **دیتابیس**، نه اینجا.
      const norm = await sql<{ m: string | null }>`
        SELECT sales.normalize_mobile(${input.mobile}) AS m
      `.execute(trx);
      const mobile = norm.rows[0]?.m;
      if (!mobile) {
        throw new CustomerError("bad_mobile", "شماره موبایل معتبر نیست", 422);
      }

      const existing = await trx
        .selectFrom("sales.customer")
        .select(["id", "full_name"])
        .where("mobile_normalized", "=", mobile)
        .executeTakeFirst();

      if (existing) {
        if (input.branches !== "all") {
          const access = await sql<{ allowed: boolean }>`
            SELECT EXISTS (
              SELECT 1 FROM sales.customer_branch cb
               WHERE cb.customer_id = ${existing.id}::uuid
                 AND cb.branch_id = ANY(${input.branches}::uuid[])
              UNION ALL
              SELECT 1 FROM sales.invoice i
               WHERE i.customer_id = ${existing.id}::uuid
                 AND i.branch_id = ANY(${input.branches}::uuid[])
            ) AS allowed
          `.execute(trx);
          if (!(access.rows[0]?.allowed ?? false)) {
            throw new CustomerError(
              "customer_branch_forbidden",
              "به پرونده این مشتری دسترسی ندارید",
              403,
            );
          }
        }
        // نام تازه فقط وقتی می‌نشیند که قبلاً نامی نبوده. بازنویسی
        // نام یک مشتری قدیمی با نامی که صندوق‌دار عجله‌ای تایپ کرده،
        // پرونده را خراب می‌کند — ویرایش مسیر خودش را دارد.
        if (existing.full_name === null && input.fullName !== undefined) {
          await trx
            .updateTable("sales.customer")
            .set({ full_name: input.fullName })
            .where("id", "=", existing.id)
            .execute();
        }
        return { id: existing.id, created: false };
      }

      const c = await trx
        .insertInto("sales.customer")
        .values({
          mobile_normalized: mobile,
          full_name: input.fullName ?? null,
          email: input.email ?? null,
          consent_sms: input.consentSms ?? false,
          consent_marketing: input.consentMarketing ?? false,
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      if (input.branches !== "all" && input.branches.length > 0) {
        await sql`
          INSERT INTO sales.customer_branch (customer_id, branch_id)
          SELECT ${c.id}::uuid, unnest(${input.branches}::uuid[])
          ON CONFLICT DO NOTHING
        `.execute(trx);
      }

      await sql`
        SELECT platform.audit('customer.create', 'customer', ${c.id}::text,
          ${JSON.stringify({ mobile })}::jsonb, ${input.actorId}::uuid)
      `.execute(trx);

      return { id: c.id, created: true };
    });
  }

  async update(input: {
    id: string;
    fullName?: string | null | undefined;
    email?: string | null | undefined;
    status?: string | undefined;
    creditLimit?: bigint | undefined;
    dueDays?: number | undefined;
    consentSms?: boolean | undefined;
    consentMarketing?: boolean | undefined;
    internalNote?: string | null | undefined;
    address?: string | null | undefined;
    /** خام از کاربر — نرمال‌سازی در دیتابیس انجام می‌شود، نه اینجا. */
    postalCode?: string | null | undefined;
    city?: string | null | undefined;
    province?: string | null | undefined;
    actorId: string;
  }): Promise<void> {
    const before = await this.byId(input.id);
    if (!before) throw new CustomerError("customer_not_found", "مشتری یافت نشد", 404);

    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, input.actorId);
      // ⚠️ کد پستی **پیش از درج** نرمال می‌شود و اگر ده رقم نبود رد
      // می‌شود — نه اینکه نصفه بنشیند. کد پستی نصفه یعنی برچسب پستی
      // غلط چاپ شود و بسته برنگردد؛ بدتر از خالی بودنش.
      let postal: string | null | undefined = input.postalCode;
      if (typeof input.postalCode === "string" && input.postalCode.trim() !== "") {
        const n = await sql<{ p: string | null }>`
          SELECT sales.normalize_postal_code(${input.postalCode}) AS p
        `.execute(trx);
        postal = n.rows[0]?.p ?? null;
        if (postal === null) {
          throw new CustomerError("bad_postal_code", "کد پستی باید ده رقم باشد", 422);
        }
      } else if (input.postalCode !== undefined) {
        postal = null;
      }

      await trx
        .updateTable("sales.customer")
        .set({
          ...(input.fullName === undefined ? {} : { full_name: input.fullName }),
          ...(input.email === undefined ? {} : { email: input.email }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.creditLimit === undefined
            ? {}
            : { credit_limit: serializeMoney(input.creditLimit) }),
          ...(input.dueDays === undefined ? {} : { due_days: input.dueDays }),
          ...(input.consentSms === undefined ? {} : { consent_sms: input.consentSms }),
          ...(input.consentMarketing === undefined
            ? {}
            : { consent_marketing: input.consentMarketing }),
          ...(input.internalNote === undefined ? {} : { internal_note: input.internalNote }),
          ...(input.address === undefined ? {} : { address: input.address }),
          ...(postal === undefined ? {} : { postal_code: postal }),
          ...(input.city === undefined ? {} : { city: input.city }),
          ...(input.province === undefined ? {} : { province: input.province }),
        })
        .where("id", "=", input.id)
        .execute();

      // سقف اعتبار و رضایت، هر دو تصمیم‌اند و ردّ حسابرسی می‌خواهند:
      // اولی پول است، دومی یک الزام قانونی.
      await sql`
        SELECT platform.audit('customer.update', 'customer', ${input.id}::text,
          ${JSON.stringify({
            creditLimit:
              input.creditLimit === undefined ? null : serializeMoney(input.creditLimit),
            consentSms: input.consentSms ?? null,
            consentMarketing: input.consentMarketing ?? null,
            status: input.status ?? null,
          })}::jsonb,
          ${input.actorId}::uuid, NULL,
          ${JSON.stringify({
            creditLimit: before.creditLimit,
            consentSms: before.consentSms,
            consentMarketing: before.consentMarketing,
            status: before.status,
          })}::jsonb)
      `.execute(trx);
    });
  }

  /** فاکتورهای یک مشتری — تازه‌ترین اول. */
  async invoices(id: string, limit: number, branches: CustomerBranchScope = "all"): Promise<
    Array<{
      id: string;
      number: string | null;
      channel: string;
      status: string;
      netAmount: string;
      paidAmount: string;
      occurredAt: string;
    }>
  > {
    const r = await sql<{
      id: string;
      number: string | null;
      channel: string;
      status: string;
      net_amount: string;
      paid_amount: string;
      occurred_at: Date;
    }>`
      SELECT id, number, channel, status, net_amount::text, paid_amount::text, occurred_at
        FROM sales.invoice
       WHERE customer_id = ${id}::uuid AND status <> 'draft'
         ${branches === "all" ? sql`` : sql`AND branch_id = ANY(${branches}::uuid[])`}
       ORDER BY occurred_at DESC
       LIMIT ${limit}
    `.execute(this.#db);

    return r.rows.map((x) => ({
      id: x.id,
      number: x.number,
      channel: x.channel,
      status: x.status,
      netAmount: serializeMoney(parseMoney(x.net_amount)),
      paidAmount: serializeMoney(parseMoney(x.paid_amount)),
      occurredAt: x.occurred_at.toISOString(),
    }));
  }
}
