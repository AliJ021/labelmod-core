/**
 * کلاینت کدینگ حساب، پایانه‌ها و سقف مجوزها.
 *
 * سه چیزی که مالک خواست از صفحه عوض شوند و **کلید تنظیم نیستند،
 * جدول‌اند** — پس صفحه خودکارِ `platform.setting` جوابشان نمی‌داد.
 *
 * مثل بقیه کلاینت‌های این پروژه، اینجا هیچ قاعده‌ای تکرار نمی‌شود:
 * سلسله‌مراتب حساب، سقف درصد و نگهبان قفل‌شدن همه در دیتابیس‌اند و
 * پیام خطایشان فارسی و برای کاربر است. این فایل فقط شکل داده را
 * می‌داند.
 */
import { api } from "./api.ts";

export type AccountLevel = "group" | "kol" | "moin" | "tafsili";
export type AccountNature = "debit" | "credit";
export type AccountType =
  | "asset"
  | "liability"
  | "equity"
  | "revenue"
  | "expense"
  | "contra_revenue";

export interface Account {
  code: string;
  parentCode: string | null;
  name: string;
  level: AccountLevel;
  nature: AccountNature;
  type: AccountType;
  isPostable: boolean;
  isActive: boolean;
  /** حسابی که فرزند دارد نمی‌تواند سند بپذیرد. */
  hasChildren: boolean;
  /** حسابی که سند خورده، ماهیت و نوعش قفل است. */
  hasEntries: boolean;
}

export interface AccountInput {
  name: string;
  level: AccountLevel;
  parentCode: string | null;
  nature: AccountNature;
  type: AccountType;
  isPostable: boolean;
}

export interface SettlementTerm {
  id: string;
  code: string;
  name: string;
  kind: string;
  /** رشته است، نه عدد: `numeric(5,3)` و `number` جاوااسکریپت ۰٫۲۳۵ را دقیق نگه نمی‌دارد. */
  feePercent: string;
  settlementDays: number;
}

export interface PermissionRule {
  roleCode: string;
  roleName: string;
  operation: string;
  allowed: boolean;
  /** پول در JSON رشته است. `null` یعنی بی‌سقف — که با «۰» یکی نیست. */
  maxAmount: string | null;
  maxPercent: number | null;
  needsApprovalFrom: string | null;
  hasRule: boolean;
}

export interface Tafsili {
  parentCode: string;
  parentName: string;
  code: string;
  partyType: string;
  partyId: string;
  partyName: string | null;
  debit: string;
  credit: string;
  balance: string;
}

export interface OpeningLeg {
  leg: string;
  amount: string;
}

/**
 * مؤلفه‌های سند افتتاحیه.
 *
 * این فهرست از `db/seed/020_posting_rules.sql` می‌آید و همان‌جا هم
 * اجبار می‌شود؛ اگر روزی مؤلفه‌ای اضافه شود، سرور مؤلفه ناشناخته را رد
 * می‌کند و اینجا هم باید اضافه شود. برچسب فارسی‌اش اینجاست چون
 * **متن رابط کاربری** است، نه قاعده مالی.
 */
export const OPENING_LEGS: Array<{ leg: string; label: string; side: "debit" | "credit" }> = [
  { leg: "cash", label: "موجودی صندوق", side: "debit" },
  { leg: "bank", label: "موجودی بانک", side: "debit" },
  { leg: "inventory", label: "موجودی کالا", side: "debit" },
  { leg: "receivable", label: "مانده بدهکاران", side: "debit" },
  { leg: "payable", label: "مانده بستانکاران", side: "credit" },
  { leg: "equity", label: "سود و زیان انباشته", side: "credit" },
];

export const admin = {
  tafsili: () => api.get<{ rows: Tafsili[] }>("/tafsili"),

  postOpening: (input: { branchId: string; fiscalYear: number; legs: OpeningLeg[] }) =>
    api.post<{ entryId: string }>("/opening-balance", input),

  accounts: () => api.get<{ accounts: Account[] }>("/accounts"),

  saveAccount: (code: string, input: AccountInput) =>
    api.put<Account>(`/accounts/${encodeURIComponent(code)}`, input),

  setAccountActive: (code: string, isActive: boolean) =>
    api.patch<{ code: string; isActive: boolean }>(
      `/accounts/${encodeURIComponent(code)}/active`,
      { isActive },
    ),

  settlementTerms: () => api.get<{ terms: SettlementTerm[] }>("/settlement-terms"),

  saveTerms: (
    id: string,
    input: { settlementDays: number; feePercent: string; reason?: string },
  ) => api.patch<SettlementTerm>(`/settlement-terms/${encodeURIComponent(id)}`, input),

  permissionRules: () => api.get<{ rules: PermissionRule[] }>("/permission-rules"),

  savePermissionRule: (
    role: string,
    operation: string,
    input: {
      allowed: boolean;
      maxAmount: string | null;
      maxPercent: number | null;
      needsApprovalFrom: string | null;
      reason?: string;
    },
  ) =>
    api.put<PermissionRule>(
      `/permission-rules/${encodeURIComponent(role)}/${encodeURIComponent(operation)}`,
      input,
    ),
};

/** برچسب فارسی سطح — ترتیبش همان ترتیب درخت است. */
export const LEVEL_LABEL: Record<AccountLevel, string> = {
  group: "گروه",
  kol: "کل",
  moin: "معین",
  tafsili: "تفصیلی",
};

export const NATURE_LABEL: Record<AccountNature, string> = {
  debit: "بدهکار",
  credit: "بستانکار",
};

export const TYPE_LABEL: Record<AccountType, string> = {
  asset: "دارایی",
  liability: "بدهی",
  equity: "سرمایه",
  revenue: "درآمد",
  expense: "هزینه",
  contra_revenue: "کاهنده درآمد",
};

/** سطحی که فرزندِ یک سطح می‌شود. `null` یعنی تفصیلی، که ته درخت است. */
export function childLevel(level: AccountLevel): AccountLevel | null {
  return level === "group"
    ? "kol"
    : level === "kol"
      ? "moin"
      : level === "moin"
        ? "tafsili"
        : null;
}

/**
 * مرتب‌سازی درختی: هر حساب زیر والدش، و خواهرها بر اساس کد.
 *
 * مرتب‌سازی ساده بر اساس کد **تقریباً** همین را می‌دهد، ولی نه همیشه:
 * اگر کسی حساب کل «۱۰» بسازد، الفبایی پیش از «۱۱۰۱» می‌آید ولی زیر
 * گروه دیگری است. این نسخه از خودِ `parentCode` می‌سازد، پس با هر
 * کدینگی درست می‌ماند.
 */
export function sortTree(accounts: Account[]): Account[] {
  const byParent = new Map<string | null, Account[]>();
  for (const a of accounts) {
    const key = a.parentCode;
    const list = byParent.get(key);
    if (list) list.push(a);
    else byParent.set(key, [a]);
  }
  for (const list of byParent.values()) {
    list.sort((x, y) => x.code.localeCompare(y.code, "en"));
  }

  const out: Account[] = [];
  const seen = new Set<string>();

  function walk(parent: string | null) {
    for (const a of byParent.get(parent) ?? []) {
      // حلقه در درخت نباید صفحه را برای همیشه معلق کند. دیتابیس
      // جلویش را می‌گیرد، ولی صفحه نباید به آن تکیه کند.
      if (seen.has(a.code)) continue;
      seen.add(a.code);
      out.push(a);
      walk(a.code);
    }
  }
  walk(null);

  // حسابی که والدش در پاسخ نیامده (نباید پیش بیاید) هم باید دیده شود،
  // وگرنه از صفحه ناپدید می‌شود بی‌آنکه کسی بفهمد.
  for (const a of accounts) {
    if (!seen.has(a.code)) out.push(a);
  }
  return out;
}
