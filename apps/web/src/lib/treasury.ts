/**
 * لایه داده خزانه و چک — تایپ‌ها و تماس‌ها، بدون منطق UI.
 *
 * ── سه چیزی که این لایه تضمین می‌کند ────────────────────────────────
 *
 * **پول رشته است.** هر مبلغی که می‌آید یا می‌رود `string` است.
 * تبدیل فقط در `lib/money.ts` و فقط برای نمایش.
 *
 * **شیفت را کلاینت تعیین نمی‌کند.** `shiftId` اختیاری است و در حالت
 * عادی فرستاده نمی‌شود: سرور خودش شیفت باز شعبه را پیدا می‌کند. فقط
 * وقتی دو کشو هم‌زمان باز باشند، سرور ۴۲۲ `ambiguous_shift` می‌دهد و
 * آن‌وقت صفحه می‌پرسد پول از کدام کشو رفته.
 *
 * **وضعیت چک را کلاینت عوض نمی‌کند.** فقط یک «عمل» می‌فرستد؛ اینکه آن
 * عمل مجاز است یا نه، `treasury.post_cheque_event()` تصمیم می‌گیرد.
 */
import { api, type RequestOptions } from "./api.ts";

export interface TreasuryAccount {
  id: string;
  code: string;
  name: string;
  kind: "cash_box" | "bank" | "card_terminal" | "gateway" | string;
  branchId: string | null;
  ledgerAccountCode: string;
  isActive: boolean;
}

export type Purpose =
  | "supplier_payment"
  | "customer_receipt"
  | "expense"
  | "capital"
  | "transfer";

export interface TreasuryTransaction {
  id: string;
  number: string | null;
  branchId: string;
  purpose: string;
  amount: string;
  fromAccountId: string | null;
  fromAccountName: string | null;
  toAccountId: string | null;
  toAccountName: string | null;
  partyType: string | null;
  partyId: string | null;
  partyName: string | null;
  expenseAccountCode: string | null;
  expenseAccountName: string | null;
  shiftId: string | null;
  occurredAt: string;
  status: string;
  entryId: string | null;
  refNo: string | null;
  note: string | null;
}

export interface Cheque {
  id: string;
  number: string | null;
  direction: "received" | "issued" | string;
  branchId: string;
  chequeNo: string;
  sayadId: string | null;
  bankName: string;
  bankBranch: string | null;
  drawerName: string | null;
  amount: string;
  issuedOn: string;
  dueOn: string;
  partyType: string;
  partyId: string;
  partyName: string | null;
  bankAccountId: string | null;
  depositAccountId: string | null;
  depositAccountName: string | null;
  status: string;
  note: string | null;
  createdAt: string;
}

export interface ChequeEvent {
  action: string;
  fromStatus: string | null;
  toStatus: string;
  occurredOn: string;
  note: string | null;
  byUser: string | null;
  entryId: string | null;
}

export interface ChequeDue {
  id: string;
  chequeNo: string;
  direction: string;
  bankName: string;
  amount: string;
  dueOn: string;
  status: string;
  partyName: string | null;
  /** `overdue` | `today` | `soon` | `future` — **دیتابیس** حسابش می‌کند. */
  urgency: string;
}

export type ChequeAction =
  | "receive"
  | "deposit"
  | "clear"
  | "bounce"
  | "endorse"
  | "settle"
  | "issue"
  | "pay"
  | "cancel";

/** برچسب فارسی هدف — «چه اتفاقی می‌افتد»، نه نام فنی عمل. */
export const ACTION_LABEL: Record<ChequeAction, string> = {
  receive: "دریافت شد",
  deposit: "به بانک واگذار شد",
  clear: "وصول شد",
  bounce: "برگشت خورد",
  endorse: "خرج شد",
  settle: "به بدهی عادی منتقل شد",
  issue: "صادر و تحویل شد",
  pay: "پاس شد",
  cancel: "ابطال",
};

export const CHEQUE_STATUS: Record<string, string> = {
  draft: "پیش‌نویس",
  in_hand: "نزد ما",
  deposited: "در جریان وصول",
  endorsed: "خرج‌شده",
  issued: "نزد دارنده",
  cleared: "وصول‌شده",
  bounced: "برگشتی",
  settled: "منتقل به بدهی",
  cancelled: "باطل",
};

export const PURPOSE_LABEL: Record<string, string> = {
  supplier_payment: "پرداخت به تأمین‌کننده",
  customer_receipt: "دریافت از مشتری",
  expense: "هزینه",
  capital: "آورده نقدی",
  transfer: "انتقال بین حساب",
};

export const ACCOUNT_KIND: Record<string, string> = {
  cash_box: "صندوق",
  bank: "بانک",
  card_terminal: "کارت‌خوان",
  gateway: "درگاه",
};

/**
 * کدام اعمال از وضعیت فعلی ممکن‌اند.
 *
 * ⚠️ این **دروازه نیست** — دروازه `treasury.post_cheque_event()` است و
 *    باید همان‌جا بماند. این فقط تعیین می‌کند کدام دکمه‌ها نشان داده
 *    شوند، تا کاربر دکمه‌ای نبیند که سرور بعداً ردش می‌کند. اگر روزی
 *    این دو از هم جدا افتادند، سرور همچنان مرجع است.
 */
export function actionsFor(cheque: Cheque): ChequeAction[] {
  if (cheque.direction === "received") {
    switch (cheque.status) {
      case "draft":
        return ["receive", "cancel"];
      case "in_hand":
        return ["deposit", "endorse"];
      case "deposited":
        return ["clear", "bounce"];
      case "endorsed":
        return ["bounce"];
      case "bounced":
        return ["settle"];
      default:
        return [];
    }
  }
  switch (cheque.status) {
    case "draft":
      return ["issue", "cancel"];
    case "issued":
      return ["pay", "bounce", "cancel"];
    default:
      return [];
  }
}

/** آیا این عمل حساب بانکی لازم دارد؟ همان شرطی که تابع دیتابیس دارد. */
export function needsAccount(action: ChequeAction): boolean {
  return action === "deposit" || action === "clear" || action === "pay";
}

export const treasury = {
  accounts: (kind?: string) =>
    api.get<{ accounts: TreasuryAccount[] }>(
      `/treasury/accounts${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`,
    ),

  transactions: (opts: { shiftId?: string; purpose?: Purpose } = {}) => {
    const q = new URLSearchParams();
    if (opts.shiftId) q.set("shiftId", opts.shiftId);
    if (opts.purpose) q.set("purpose", opts.purpose);
    const qs = q.toString();
    return api.get<{ transactions: TreasuryTransaction[] }>(
      `/treasury/transactions${qs ? `?${qs}` : ""}`,
    );
  },

  createTransaction: (
    input: {
      branchId: string;
      purpose: Purpose;
      amount: string;
      fromAccountId?: string;
      toAccountId?: string;
      partyType?: string;
      partyId?: string;
      expenseAccountCode?: string;
      shiftId?: string;
      refNo?: string;
      note?: string;
    },
    opts?: RequestOptions,
  ) =>
    api.post<{ id: string; replayed: boolean }>("/treasury/transactions", input, opts),

  cheques: (opts: { direction?: string; status?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.direction) q.set("direction", opts.direction);
    if (opts.status) q.set("status", opts.status);
    const qs = q.toString();
    return api.get<{ cheques: Cheque[] }>(`/cheques${qs ? `?${qs}` : ""}`);
  },

  chequeDue: () => api.get<{ due: ChequeDue[] }>("/cheques/due"),

  cheque: (id: string) =>
    api.get<{ cheque: Cheque; events: ChequeEvent[] }>(`/cheques/${id}`),

  createCheque: (
    input: {
      direction: "received" | "issued";
      branchId: string;
      chequeNo: string;
      sayadId?: string;
      bankName: string;
      bankBranch?: string;
      drawerName?: string;
      amount: string;
      issuedOn: string;
      dueOn: string;
      partyType: "customer" | "supplier";
      partyId: string;
      bankAccountId?: string;
      note?: string;
    },
    opts?: RequestOptions,
  ) => api.post<{ id: string; replayed: boolean }>("/cheques", input, opts),

  postChequeEvent: (
    id: string,
    input: { action: ChequeAction; accountId?: string; partyId?: string; note?: string },
    opts?: RequestOptions,
  ) => api.post<{ ok: boolean; replayed: boolean }>(`/cheques/${id}/events`, input, opts),
};
