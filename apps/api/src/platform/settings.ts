/**
 * تنظیمات — خواندن با فراداده، نوشتن فقط از `platform.set_setting()`.
 *
 * سه قاعده پروژه اینجا به هم می‌رسند و هر سه در دیتابیس‌اند نه اینجا:
 *
 *   • **هیچ شرط دسترسی در کد نیست.** اینکه چه مجوزی برای تغییر یک
 *     تنظیم لازم است، ستون `permission` همان سطر است. این فایل فقط
 *     آن رشته را به `identity.can()` می‌دهد — و هرگز خودش تصمیم
 *     نمی‌گیرد کدام تنظیم حساس است.
 *
 *   • **اعتبارسنجی در دیتابیس.** نوع، گزینه و بازه را
 *     `platform.set_setting()` می‌سنجد، نه Zod. اگر اینجا هم
 *     می‌سنجیدیم، دو نسخه از یک قاعده داشتیم که دیر یا زود از هم جدا
 *     می‌شدند — و آن که در psql دور زده می‌شود، همان است که اهمیت
 *     دارد.
 *
 *   • **کاربر عامل در همان تراکنش.** بدون `platform.set_actor()`،
 *     تابع خطا می‌دهد.
 */
import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { Db } from "../db/client.ts";
import type { Database } from "../db/types.ts";

/** یک تنظیم، همان‌طور که صفحه تنظیمات لازمش دارد. */
export interface SettingView {
  key: string;
  value: unknown;
  kind: string;
  label: string;
  description: string;
  help: string | null;
  group: string;
  options: Array<{ value: string; label: string }> | null;
  min: number | null;
  max: number | null;
  unit: string | null;
  requiresApproval: boolean;
  /** false یعنی از هیچ مسیر API عوض نمی‌شود — قاعده است، نه پیش‌فرض. */
  isEditable: boolean;
  /** آیا **این کاربر** می‌تواند عوضش کند. از identity.can() می‌آید. */
  canEdit: boolean;
  permission: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface SettingGroupView {
  key: string;
  title: string;
  subtitle: string | null;
  settings: SettingView[];
}

interface Row {
  key: string;
  value: unknown;
  description: string;
  requires_approval: boolean;
  kind: string;
  label: string | null;
  group_key: string;
  options: unknown;
  min_value: string | null;
  max_value: string | null;
  unit: string | null;
  help: string | null;
  sort_order: number;
  permission: string;
  is_editable: boolean;
  updated_at: Date;
  updated_by: string | null;
  updated_by_name: string | null;
  group_title: string | null;
  group_subtitle: string | null;
  group_sort: number | null;
}

export class SettingError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "SettingError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function parseNum(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseOptions(v: unknown): Array<{ value: string; label: string }> | null {
  if (!Array.isArray(v)) return null;
  return v
    .filter((o): o is { value: unknown; label?: unknown } => typeof o === "object" && o !== null)
    .map((o) => ({
      value: String(o.value),
      label: typeof o.label === "string" ? o.label : String(o.value),
    }));
}

/** شرایط تسویه یک پایانه — کارت‌خوان یا درگاه. */
export interface SettlementTermsView {
  id: string;
  code: string;
  name: string;
  kind: string;
  settlementDays: number;
  /** درصد، به‌صورت رشته: `numeric(5,3)` است و اعشار دارد. */
  feePercent: string;
  isActive: boolean;
  settlesTo: string | null;
  canEdit: boolean;
}

/** یک درایور شناخته‌شده. */
export interface DeviceDriverView {
  code: string;
  label: string;
  deviceKind: string;
  vendor: string | null;
  sdkDocUrl: string | null;
  notes: string | null;
  /** ⚠️ `false` یعنی مستنداتش ثبت شده ولی کدش نوشته نشده. */
  isImplemented: boolean;
  /** `false` یعنی بازنشسته — در فهرست انتخاب پایانه نمی‌آید. */
  isActive: boolean;
}

/** ورودی افزودن یا ویرایش یک درایور. */
export interface DriverInput {
  code: string;
  label: string;
  deviceKind: string;
  vendor: string | null;
  sdkDocUrl: string | null;
  notes: string | null;
  sortOrder: number;
}

/** یک پایانه و درایورش. */
export interface TerminalDriverView {
  accountId: string;
  accountCode: string;
  accountName: string;
  kind: string;
  driverCode: string | null;
  driverLabel: string | null;
  vendor: string | null;
  sdkDocUrl: string | null;
  isImplemented: boolean | null;
  driverConfig: Record<string, unknown>;
  canEdit: boolean;
}

export class SettingService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** یک سطر خام — برای تصمیم مجوز پیش از نوشتن. */
  async find(key: string): Promise<{ permission: string; isEditable: boolean } | null> {
    const r = await this.#db
      .selectFrom("platform.setting")
      .select(["permission", "is_editable"])
      .where("key", "=", key)
      .executeTakeFirst();
    if (!r) return null;
    return { permission: r.permission, isEditable: r.is_editable };
  }

  /**
   * همه تنظیمات، گروه‌بندی‌شده و مرتب.
   *
   * `allowed` مجموعه عملیاتی است که این کاربر اجازه‌شان را دارد. عمداً
   * از بیرون می‌آید و یک بار برای هر عملیات **متمایز** حساب می‌شود، نه
   * یک بار برای هر تنظیم — وگرنه یک بار باز کردن صفحه، سی بار
   * `identity.can()` می‌زد.
   */
  async list(allowed: ReadonlySet<string>): Promise<SettingGroupView[]> {
    const r = await sql<Row>`
      SELECT s.*,
             u.full_name AS updated_by_name,
             g.title      AS group_title,
             g.subtitle   AS group_subtitle,
             g.sort_order AS group_sort
        FROM platform.setting s
        LEFT JOIN platform.setting_group g ON g.key = s.group_key
        LEFT JOIN identity.app_user u      ON u.id  = s.updated_by
       ORDER BY coalesce(g.sort_order, 999), s.group_key, s.sort_order, s.key
    `.execute(this.#db);

    const groups = new Map<string, SettingGroupView>();
    for (const row of r.rows) {
      let g = groups.get(row.group_key);
      if (!g) {
        g = {
          key: row.group_key,
          title: row.group_title ?? "سایر",
          subtitle: row.group_subtitle,
          settings: [],
        };
        groups.set(row.group_key, g);
      }
      g.settings.push({
        key: row.key,
        value: row.value,
        kind: row.kind,
        // برچسب فارسی اجباری است و تست SQL نبودش را می‌گیرد؛ این
        // fallback فقط برای آن لحظه‌ای است که مهاجرت اجرا شده و seed
        // هنوز نه — و آنجا هم کلید فنی بهتر از خالی است.
        label: row.label ?? row.key,
        description: row.description,
        help: row.help,
        group: row.group_key,
        options: parseOptions(row.options),
        min: parseNum(row.min_value),
        max: parseNum(row.max_value),
        unit: row.unit,
        requiresApproval: row.requires_approval,
        isEditable: row.is_editable,
        canEdit: row.is_editable && allowed.has(row.permission),
        permission: row.permission,
        updatedAt: row.updated_at.toISOString(),
        updatedBy: row.updated_by_name,
      });
    }
    return [...groups.values()];
  }

  /**
   * شرایط تسویه کارت‌خوان و درگاه.
   *
   * عمداً در `platform.setting` نیست: این دو عدد از قبل در
   * `treasury.account` وجود دارند و همان‌جاست که `settle_batch`
   * می‌خواندشان. یک کلید سراسری یعنی کارت‌خوان فروشگاه و درگاه سایت
   * ناچار یک کارمزد داشته باشند — که تقریباً هرگز درست نیست.
   */
  async settlementTerms(canEdit: boolean): Promise<SettlementTermsView[]> {
    const r = await sql<{
      id: string;
      code: string;
      name: string;
      kind: string;
      settlement_days: number;
      fee_percent: string;
      is_active: boolean;
      settles_to: string | null;
    }>`SELECT * FROM treasury.settlement_terms ORDER BY kind, code`.execute(this.#db);

    return r.rows.map((t) => ({
      id: t.id,
      code: t.code,
      name: t.name,
      kind: t.kind,
      settlementDays: Number(t.settlement_days),
      feePercent: t.fee_percent,
      isActive: t.is_active,
      settlesTo: t.settles_to,
      canEdit,
    }));
  }

  /**
   * درایورهای شناخته‌شده.
   *
   * ⚠️ `isImplemented` را حتماً به کاربر نشان دهید. ثبت یک درایور
   * یعنی «مستنداتش را داریم»، نه «کار می‌کند» — و آن تفاوت، تفاوتِ
   * یک پرداخت موفق با یک پرداخت معلق است.
   */
  async deviceDrivers(includeRetired = false): Promise<DeviceDriverView[]> {
    let q = this.#db
      .selectFrom("platform.device_driver")
      .select([
        "code", "label", "device_kind", "vendor",
        "sdk_doc_url", "notes", "is_implemented", "is_active",
      ]);
    // ⚠️ پیش‌فرض فقط فعال‌ها — همان فهرستی که پایانه از رویش انتخاب
    //    می‌کند. صفحه مدیریت درایورها `includeRetired` می‌فرستد تا
    //    بتوان یک درایور بازنشسته را برگرداند؛ اگر بازنشسته‌ها اصلاً
    //    دیده نمی‌شدند، برگرداندنشان فقط از psql ممکن بود.
    if (!includeRetired) q = q.where("is_active", "=", true);
    const r = await q.orderBy("sort_order").orderBy("code").execute();
    return r.map((x) => ({
      code: x.code,
      label: x.label,
      deviceKind: x.device_kind,
      vendor: x.vendor,
      sdkDocUrl: x.sdk_doc_url,
      notes: x.notes,
      isImplemented: x.is_implemented,
      isActive: x.is_active,
    }));
  }

  /**
   * افزودن یا ویرایش یک درایور و مستندات SDK آن.
   *
   * ── چرا این مسیر وجود دارد ────────────────────────────────────────
   *
   * خواسته مالک: «مستندات SDK درایور کارت‌خوان باید از طریق تنظیمات
   * قابل جایگزاری یا تغییر باشد، چون هم ممکن است کارت‌خوان‌ها عوض
   * شوند و هم ممکن است زیادتر شوند.» بدون این، رسیدن یک PSP تازه
   * یک مهاجرت و یک Deploy می‌خواست.
   *
   * ⚠️ `isImplemented` پارامتر نیست و از هیچ ورودی‌ای خوانده
   * نمی‌شود. آن ستون یک واقعیت درباره **کد این مخزن** است، نه یک
   * تنظیم؛ روشن‌شدنش از صفحه تنظیمات یعنی دور زدن همان نگهبانی که
   * `treasury.set_device_driver()` دارد.
   *
   * اعتبارسنجی — کد، نوع، https، طول، نویسه کنترلی، و نبودِ راز —
   * همه در دیتابیس‌اند. یک تعریف، نه دو.
   */
  async upsertDriverIn(
    trx: Transaction<Database>,
    input: DriverInput,
    reason: string | null,
    actorId: string,
  ): Promise<void> {
    await sql`
      SELECT platform.upsert_device_driver(
        ${input.code}::text, ${input.label}::text, ${input.deviceKind}::text,
        ${input.vendor}::text, ${input.sdkDocUrl}::text, ${input.notes}::text,
        ${input.sortOrder}::smallint, ${reason}::text, ${actorId}::uuid)
    `.execute(trx);
  }

  /**
   * بازنشستگی یا بازگرداندن یک درایور.
   *
   * حذف نیست: `treasury.account.driver_code` به آن ارجاع دارد.
   * درایوری که پایانه‌ای به آن وصل است، بازنشسته نمی‌شود — دیتابیس
   * ردش می‌کند.
   */
  async setDriverActiveIn(
    trx: Transaction<Database>,
    code: string,
    isActive: boolean,
    reason: string | null,
    actorId: string,
  ): Promise<void> {
    await sql`
      SELECT platform.set_device_driver_active(
        ${code}::text, ${isActive}::boolean, ${reason}::text, ${actorId}::uuid)
    `.execute(trx);
  }

  async terminalDrivers(canEdit: boolean): Promise<TerminalDriverView[]> {
    const r = await sql<{
      account_id: string; account_code: string; account_name: string;
      kind: string; driver_code: string | null; driver_label: string | null;
      vendor: string | null; sdk_doc_url: string | null;
      is_implemented: boolean | null; driver_config: Record<string, unknown>;
    }>`SELECT * FROM treasury.terminal_driver ORDER BY kind, account_code`
      .execute(this.#db);
    return r.rows.map((x) => ({
      accountId: x.account_id,
      accountCode: x.account_code,
      accountName: x.account_name,
      kind: x.kind,
      driverCode: x.driver_code,
      driverLabel: x.driver_label,
      vendor: x.vendor,
      sdkDocUrl: x.sdk_doc_url,
      isImplemented: x.is_implemented,
      driverConfig: x.driver_config,
      canEdit,
    }));
  }

  /**
   * اتصال یک پایانه به یک درایور.
   *
   * سنجش‌ها در دیتابیس‌اند: پایانه بودن، پیاده‌شده بودن درایور، و
   * نبودِ راز در `config`. یک تعریف، نه دو.
   */
  async setDriverIn(
    trx: Transaction<Database>,
    accountId: string,
    driverCode: string | null,
    config: Record<string, unknown>,
    reason: string | null,
    actorId: string,
  ): Promise<void> {
    await sql`
      SELECT treasury.set_device_driver(
        ${accountId}::uuid, ${driverCode}::text,
        ${JSON.stringify(config)}::jsonb, ${reason}::text, ${actorId}::uuid)
    `.execute(trx);
  }

  /** نوشتن شرایط تسویه — تنها از مسیر `treasury.set_settlement_terms()`. */
  async setTermsIn(
    trx: Transaction<Database>,
    accountId: string,
    settlementDays: number,
    feePercent: string,
    reason: string | null,
  ): Promise<{ id: string; settlementDays: number; feePercent: string }> {
    const r = await sql<{ id: string; settlement_days: number; fee_percent: string }>`
      SELECT id, settlement_days, fee_percent
        FROM treasury.set_settlement_terms(
          ${accountId}::uuid, ${settlementDays}::smallint, ${feePercent}::numeric, ${reason})
    `.execute(trx);

    const row = r.rows[0];
    if (!row) throw new SettingError("terms_failed", "شرایط تسویه ذخیره نشد", 500);
    return {
      id: row.id,
      settlementDays: Number(row.settlement_days),
      feePercent: row.fee_percent,
    };
  }

  /**
   * نوشتن — تنها از مسیر `platform.set_setting()`.
   *
   * هیچ `UPDATE` مستقیمی اینجا نیست و نباید باشد: اعتبارسنجی، قفل سطر
   * و ثبت حسابرسی همه داخل همان تابع‌اند.
   */
  async setIn(
    trx: Transaction<Database>,
    key: string,
    value: unknown,
    reason: string | null,
  ): Promise<{ key: string; value: unknown; updatedAt: string }> {
    const r = await sql<{ key: string; value: unknown; updated_at: Date }>`
      SELECT key, value, updated_at
        FROM platform.set_setting(${key}, ${JSON.stringify(value)}::jsonb, ${reason})
    `.execute(trx);

    const row = r.rows[0];
    if (!row) throw new SettingError("setting_failed", "تنظیم ذخیره نشد", 500);
    return { key: row.key, value: row.value, updatedAt: row.updated_at.toISOString() };
  }
}
