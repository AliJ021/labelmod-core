/**
 * لایه داده پرسنل و مشتری.
 *
 * ── رمز اینجا **ساخته نمی‌شود** ───────────────────────────────────
 *
 * در ساخت کاربر، سرور رمز را می‌سازد. در تغییر رمز، مدیر می‌تواند رمز
 * دلخواه یا پیشنهاد محلیِ مرورگر را پس از تأیید بفرستد. پاسخ آن را **یک بار**
 * برمی‌گرداند و صفحه فقط نشانش می‌دهد و هیچ‌جا نگهش نمی‌دارد —
 * نه در `localStorage`، نه در State پس از بسته‌شدن پنجره.
 *
 * ── راز خوانده نمی‌شود ────────────────────────────────────────────
 *
 * `hasPin` و `hasTotp` بولی‌اند: «دارد یا ندارد»، نه خودِ مقدار.
 */
import { api } from "./api.ts";

export interface UserRole {
  roleCode: string;
  roleName: string;
  branchId: string | null;
  branchName: string | null;
}

export interface AppUser {
  id: string;
  username: string;
  fullName: string;
  mobile: string | null;
  isActive: boolean;
  createdAt: string;
  hasPin: boolean;
  hasTotp: boolean;
  roles: UserRole[];
  activeSessions: number;
}

export interface Role {
  code: string;
  name: string;
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
  address: string | null;
  postalCode: string | null;
  city: string | null;
  province: string | null;
  tags: string[];
  internalNote: string | null;
  createdAt: string;
  invoiceCount: number;
  totalPurchased: string;
  balance: string;
}

/** فراداده یک اندازه — فرم از همین ساخته می‌شود، نه از فهرستی در React. */
export interface MeasureKey {
  key: string;
  label: string;
  unit: string;
  minValue: string;
  maxValue: string;
  groupKey: string;
  sortOrder: number;
}

export interface CustomerMeasure {
  key: string;
  valueCm: string;
}

export const MEASURE_GROUP: Record<string, string> = {
  general: "عمومی",
  upper: "بالاتنه",
  lower: "پایین‌تنه",
  foot: "پا",
};

/** یک کالای پیشنهادی. `matchScore = null` یعنی اندازه‌اش ثبت نشده. */
export interface FittingVariation {
  variationId: string;
  sku: string;
  productName: string;
  color: string;
  size: string;
  season: string | null;
  onHand: string;
  matchScore: number | null;
  matchedKeys: number;
}

export interface CustomerInvoice {
  id: string;
  number: string | null;
  channel: string;
  status: string;
  netAmount: string;
  paidAmount: string;
  occurredAt: string;
}

export type RoleAssignment = { roleCode: string; branchId: string | null };

export const people = {
  users: (includeInactive = false) =>
    api.get<{ users: AppUser[] }>(`/users?includeInactive=${includeInactive}`),

  user: (id: string) => api.get<AppUser>(`/users/${id}`),

  roles: () => api.get<{ roles: Role[] }>("/roles"),

  /** پاسخ شامل **متن خام رمز** است — یک بار و تمام. */
  createUser: (input: {
    username: string;
    fullName: string;
    mobile?: string;
    roles: RoleAssignment[];
  }) => api.post<{ id: string; password: string; note: string }>("/users", input),

  updateUser: (
    id: string,
    input: { fullName?: string; mobile?: string | null; isActive?: boolean },
  ) => api.patch<AppUser>(`/users/${id}`, input),

  setRoles: (id: string, roles: RoleAssignment[]) =>
    api.put<AppUser>(`/users/${id}/roles`, { roles }),

  resetPassword: (id: string, password?: string) =>
    api.post<{ password: string; note: string }>(
      `/users/${id}/reset-password`,
      password === undefined ? {} : { password },
    ),

  setPin: (id: string, pin: string | null) =>
    api.put<{ ok: boolean; hasPin: boolean }>(`/users/${id}/pin`, { pin }),

  customers: (q = "") =>
    api.get<{ customers: Customer[] }>(
      `/customers${q.trim() === "" ? "" : `?q=${encodeURIComponent(q.trim())}`}`,
    ),

  customer: (id: string) =>
    api.get<{ customer: Customer; invoices: CustomerInvoice[] }>(`/customers/${id}`),

  /** شماره تکراری مشتری دوم نمی‌سازد — `created` می‌گوید کدام شد. */
  upsertCustomer: (input: {
    mobile: string;
    fullName?: string;
    email?: string;
    consentSms?: boolean;
    consentMarketing?: boolean;
  }) => api.post<Customer & { created: boolean }>("/customers", input),

  updateCustomer: (
    id: string,
    input: {
      fullName?: string | null;
      email?: string | null;
      status?: string;
      creditLimit?: string;
      dueDays?: number;
      consentSms?: boolean;
      consentMarketing?: boolean;
      internalNote?: string | null;
      address?: string | null;
      /** خام فرستاده می‌شود — نرمال‌سازی و سنجش ده رقم در دیتابیس است. */
      postalCode?: string | null;
      city?: string | null;
      province?: string | null;
    },
  ) => api.patch<Customer>(`/customers/${id}`, input),

  measureKeys: () => api.get<{ keys: MeasureKey[] }>("/measure-keys"),

  /**
   * کالاهای مناسب این مشتری — «برای خودش می‌خرد».
   *
   * پیشنهاد است نه حکم: کالای بدون اندازه حذف نمی‌شود و
   * `matchScore: null` می‌گیرد.
   */
  fitting: (id: string, opts: { minScore?: number; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.minScore !== undefined) q.set("minScore", String(opts.minScore));
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return api.get<{ variations: FittingVariation[] }>(
      `/customers/${id}/fitting${qs === "" ? "" : `?${qs}`}`,
    );
  },

  measures: (id: string) =>
    api.get<{ measures: CustomerMeasure[] }>(`/customers/${id}/measures`),

  /** جایگزینی کامل — همان قاعده انبارگردانی: مطلق است، نه افزایشی. */
  setMeasures: (id: string, values: Record<string, number>) =>
    api.put<{ measures: CustomerMeasure[] }>(`/customers/${id}/measures`, { values }),
};

export const CUSTOMER_STATUS: Record<string, string> = {
  active: "فعال",
  blocked: "مسدود",
  merged: "ادغام‌شده",
};
