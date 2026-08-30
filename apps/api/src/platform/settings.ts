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
