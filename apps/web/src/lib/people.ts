/**
 * لایه داده پرسنل و مشتری.
 *
 * ── رمز اینجا **ساخته نمی‌شود** ───────────────────────────────────
 *
 * هیچ تابعی رمز نمی‌فرستد. سرور می‌سازدش و **یک بار** در پاسخ
 * برمی‌گرداند. صفحه هم فقط نشانش می‌دهد و هیچ‌جا نگهش نمی‌دارد —
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
  tags: string[];
  internalNote: string | null;
  createdAt: string;
  invoiceCount: number;
  totalPurchased: string;
  balance: string;
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

  resetPassword: (id: string) =>
    api.post<{ password: string; note: string }>(`/users/${id}/reset-password`, {}),

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
    },
  ) => api.patch<Customer>(`/customers/${id}`, input),
};

export const CUSTOMER_STATUS: Record<string, string> = {
  active: "فعال",
  blocked: "مسدود",
  merged: "ادغام‌شده",
};
