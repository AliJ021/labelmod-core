/**
 * تایپ‌های Kysely برای جدول‌هایی که API واقعاً لمس می‌کند.
 *
 * عمداً دست‌نویس و ناقص است — نه تولیدشده از کل اسکیما. دلیلش:
 * تولید خودکار تایپ برای ۳۸ جدول، فهرستی می‌سازد که هیچ‌کس نمی‌خواندش
 * و با هر مهاجرت بی‌صدا کهنه می‌شود. اینجا هر جدولی که اضافه شود، یعنی
 * کسی عمداً تصمیم گرفته API آن را ببیند.
 *
 * پول همه‌جا string است، نه number: پارسر NUMERIC در pg رشته می‌دهد و
 * ما همان را به bigint می‌بریم. هیچ مبلغی نباید حتی یک لحظه number شود.
 */
import type { Generated } from "kysely";

export interface AppUserTable {
  id: Generated<string>;
  username: string;
  full_name: string;
  mobile: string | null;
  password_hash: string | null;
  pin_hash: string | null;
  is_active: boolean;
  totp_secret: string | null;
  created_at: Generated<Date>;
}

export interface RoleTable {
  code: string;
  name: string;
}

export interface UserRoleTable {
  user_id: string;
  role_code: string;
  branch_id: string | null;
}

export interface ApiClientTable {
  id: Generated<string>;
  name: string;
  /** کاربر پشتی — همه مجوزها و ردّ حسابرسی از او می‌آید (مهاجرت ۰۳۰). */
  user_id: string;
  /** SHA-256 کلید. خودِ کلید هرگز ذخیره نمی‌شود. */
  key_hash: string;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
  created_by: string | null;
  last_used_at: Date | null;
  note: string | null;
}

export interface DeviceTable {
  id: Generated<string>;
  fingerprint: string;
  label: string;
  kind: "pos" | "desktop" | "mobile" | "other";
  branch_id: string | null;
  is_approved: boolean;
  approved_by: string | null;
  approved_at: Date | null;
  /** SHA-256 راز ثبت‌نام. NULL یعنی دستگاه هنوز PIN را باز نمی‌کند. */
  secret_hash: string | null;
  enrolled_at: Date | null;
  last_seen_at: Date | null;
  created_at: Generated<Date>;
}

export interface SessionTable {
  id: Generated<string>;
  token_hash: string;
  user_id: string;
  device_id: string | null;
  subject: "staff" | "customer";
  auth_method: "password" | "totp" | "webauthn" | "otp";
  ip: string | null;
  user_agent: string | null;
  issued_at: Generated<Date>;
  expires_at: Date;
  last_seen_at: Generated<Date>;
  locked_at: Date | null;
  pin_unlocked: boolean;
  revoked_at: Date | null;
  revoke_reason: string | null;
}

export interface AuthAttemptTable {
  id: Generated<number>;
  at: Generated<Date>;
  kind: "password" | "pin" | "totp" | "otp" | "webauthn";
  username: string | null;
  user_id: string | null;
  device_id: string | null;
  ip: string | null;
  succeeded: boolean;
  failure_code: string | null;
}

export interface SettingTable {
  key: string;
  value: unknown;
  description: string;
  requires_approval: boolean;
  updated_at: Generated<Date>;
  updated_by: string | null;
  /** نوع مقدار — تعیین‌کننده ویجت در رابط کاربری و اعتبارسنجی در set_setting. */
  kind: Generated<string>;
  label: string | null;
  group_key: Generated<string>;
  /** [{value,label}] برای choice و multichoice. */
  options: unknown;
  min_value: string | null;
  max_value: string | null;
  unit: string | null;
  help: string | null;
  sort_order: Generated<number>;
  /** عملیاتی که identity.can() برای تغییر این تنظیم می‌سنجد. */
  permission: Generated<string>;
  is_editable: Generated<boolean>;
}

export interface SettingGroupTable {
  key: string;
  title: string;
  subtitle: string | null;
  sort_order: Generated<number>;
}

export interface BranchTable {
  id: Generated<string>;
  code: string;
  name: string;
  is_active: boolean;
}

// ── کاتالوگ و انبار ───────────────────────────────────────────────

export interface ProductTable {
  id: Generated<string>;
  code: string;
  name_internal: string;
  name_web: string | null;
  brand_id: string | null;
  category_id: string | null;
  season: string | null;
  collection: string | null;
  fabric: string | null;
  /** جذب، رگولار، استریت، نیم‌بگ، بگ */
  fit: string | null;
  origin_country: string | null;
  /** پیش‌فرض `'standard'` در دیتابیس — روی درج لازم نیست. */
  tax_rate_code: Generated<string>;
  notes: string | null;
  /** پیش‌فرض `'active'` در دیتابیس (مهاجرت ۰۳۲). archived یعنی بایگانی، نه حذف. */
  status: Generated<string>;
}

/**
 * نمای `identity.device_overview` (مهاجرت ۰۳۳) — فقط خواندنی.
 *
 * ⚠️ `secret_hash` عمداً اینجا نیست. راز دستگاه است و حتی هشش هم به
 *    لایه API نمی‌آید؛ `enrolled` فقط می‌گوید هست یا نه.
 */
export interface DeviceOverviewView {
  id: string;
  fingerprint: string;
  label: string;
  kind: string;
  branch_id: string | null;
  branch_name: string | null;
  is_approved: boolean;
  approved_at: Date | null;
  approved_by: string | null;
  approved_by_name: string | null;
  enrolled: boolean;
  enrolled_at: Date | null;
  last_seen_at: Date | null;
  created_at: Date;
  active_sessions: number;
}

export interface BrandTable {
  id: Generated<string>;
  name: string;
}

export interface CategoryTable {
  id: Generated<string>;
  parent_id: string | null;
  name: string;
  path: string;
}

export interface VariationTable {
  id: Generated<string>;
  product_id: string;
  color: string | null;
  size: string | null;
  sku: string;
  barcode: string | null;
  /** پیش‌فرض `'active'` در دیتابیس. */
  status: Generated<string>;
}

/** فصل‌های مجاز کالا — داده مرجع، نه CHECK. */
export interface SeasonTable {
  code: string;
  label: string;
  /** warm | cold | all — «چهارفصل» نه گرم است نه سرد. */
  climate: string;
  sort_order: number;
  is_active: boolean;
}

/** کلیدهای مجاز اندازه بدن، با برچسب و بازه. */
export interface MeasureKeyTable {
  key: string;
  label: string;
  unit: string;
  min_value: string;
  max_value: string;
  group_key: string;
  sort_order: number;
  is_active: boolean;
}

export interface PriceTable {
  id: Generated<string>;
  variation_id: string;
  /** پیش‌فرض `'default'` در دیتابیس. */
  price_list: Generated<string>;
  /** رشته، نه عدد — پارسر NUMERIC رشته می‌دهد و همان‌جا می‌ماند. */
  amount: string;
  /** پیش‌فرض `'regular'` در دیتابیس. */
  kind: Generated<"regular" | "markdown" | "promo">;
  reason: string | null;
  /** پیش‌فرض `now()` در دیتابیس — روی درج لازم نیست. */
  valid_from: Generated<Date>;
  valid_to: Date | null;
  created_by: string | null;
}

export interface StockBalanceTable {
  variation_id: string;
  warehouse_id: string;
  on_hand: string;
  reserved: string;
  total_value: string;
  row_version: number;
  updated_at: Generated<Date>;
}

export interface WarehouseTable {
  id: Generated<string>;
  branch_id: string;
  code: string;
  name: string;
  kind: string;
  is_active: boolean;
}

// ── فروش ──────────────────────────────────────────────────────────

export interface CashShiftTable {
  id: Generated<string>;
  branch_id: string;
  user_id: string;
  opened_at: Generated<Date>;
  opening_cash: string;
  closed_at: Date | null;
  counted_cash: string | null;
  expected_cash: string | null;
  variance: string | null;
  variance_note: string | null;
  approved_by: string | null;
  status: string;
}

export interface InvoiceTable {
  id: Generated<string>;
  number: string | null;
  branch_id: string;
  warehouse_id: string;
  shift_id: string | null;
  customer_id: string | null;
  channel: string;
  status: string;
  gross_amount: string;
  discount_amount: string;
  net_amount: string;
  tax_amount: string;
  shipping_amount: string;
  payable_amount: string;
  paid_amount: string;
  cogs_amount: string;
  client_event_id: string | null;
  occurred_at: Generated<Date>;
  finalized_at: Date | null;
  created_by: string | null;
  note: string | null;
  posting_batch_id: string | null;
}

export interface InvoiceLineTable {
  id: Generated<string>;
  invoice_id: string;
  line_no: number;
  variation_id: string;
  qty: string;
  unit_price: string;
  discount_amount: string;
  tax_amount: string;
  net_amount: string;
  unit_cost: string;
  cogs_amount: string;
  returned_qty: string;
  discount_reason: string | null;
  /** قیمت فهرست — فقط وقتی قیمت دستی خورده باشد. NULL یعنی دست‌نخورده. */
  list_price: string | null;
  price_override_reason: string | null;
}

export interface SaleReturnTable {
  id: Generated<string>;
  number: string | null;
  branch_id: string;
  invoice_id: string;
  warehouse_id: string;
  shift_id: string | null;
  kind: string;
  net_amount: string;
  tax_amount: string;
  refund_amount: string;
  cogs_amount: string;
  reason_code: string;
  reason_note: string | null;
  status: string;
  occurred_at: Generated<Date>;
  created_by: string | null;
  approved_by: string | null;
  refund_method: string | null;
  receivable_applied: string;
  credit_applied: string;
}

export interface SaleReturnLineTable {
  id: Generated<string>;
  return_id: string;
  invoice_line_id: string;
  qty: string;
  unit_price: string;
  net_amount: string;
  tax_amount: string;
  unit_cost: string;
  cogs_amount: string;
  restock: boolean;
  condition: string;
}

/**
 * دوره ثبت — ADR-003. فاکتور صندوق به دوره شیفت می‌چسبد و فاکتور
 * آنلاین به دوره (شعبه، کانال، روز).
 */
export interface PostingBatchTable {
  id: Generated<string>;
  branch_id: string;
  kind: string;
  shift_id: string | null;
  channel: string | null;
  business_date: string;
  status: Generated<string>;
  sale_entry_id: string | null;
  cogs_entry_id: string | null;
  posted_at: Date | null;
  posted_by: string | null;
}

/**
 * View — درآمدی که هنوز سند نخورده. فقط خواندنی.
 *
 * `batch_id` تهی یعنی فاکتور به هیچ دوره‌ای نچسبیده؛ وضعیت غیر
 * `posted` یعنی دوره هست ولی هنوز بسته نشده.
 */
export interface UnpostedRevenueView {
  invoice_id: string;
  number: string | null;
  branch_id: string;
  channel: string;
  occurred_at: Date;
  payable_amount: string;
  cogs_amount: string;
  batch_id: string | null;
  batch_kind: string | null;
  business_date: Date | null;
}

/**
 * پرونده مشتری.
 *
 * ⚠️ `mobile_normalized` را **دیتابیس** می‌سازد
 *    (`sales.normalize_mobile`)، نه لایه اپلیکیشن. دو تعریف از
 *    نرمال‌سازی یعنی مشتری دو حساب پیدا کند و مانده‌اش بینشان گم شود.
 *
 * `consent_sms` و `consent_marketing` عمداً جدا هستند: پیامک فاکتور
 * با اولی می‌رود و تبلیغات با دومی.
 */
/**
 * راز TOTP در جریان ثبت‌نام (مهاجرت ۰۳۷).
 *
 * ⚠️ جدا از `app_user.totp_secret` است و باید بماند: آن ستون فقط راز
 *    **تأییدشده** را نگه می‌دارد. اگر یکی بودند، کاربری که وسط
 *    ثبت‌نام رها می‌کرد دفعه بعد پشت کدی قفل می‌شد که هرگز اسکن نکرده.
 */
export interface TotpEnrollmentTable {
  user_id: string;
  secret: string;
  created_at: Generated<Date>;
}

export interface RecoveryCodeTable {
  id: Generated<string>;
  user_id: string;
  /** SHA-256 — کد یک راز تصادفی است، نه رمز انسانی. */
  code_hash: string;
  used_at: Date | null;
  created_at: Generated<Date>;
}

export interface WebauthnCredentialTable {
  id: Generated<string>;
  user_id: string;
  credential_id: string;
  public_key: string;
  /** صعودی می‌ماند؛ نزولش یعنی کلید Clone شده. */
  counter: Generated<string>;
  transports: string[] | null;
  device_type: string | null;
  backed_up: Generated<boolean>;
  name: string | null;
  created_at: Generated<Date>;
  last_used_at: Date | null;
}

export interface WebauthnChallengeTable {
  id: Generated<string>;
  user_id: string;
  challenge: string;
  kind: "register" | "login";
  expires_at: Date;
  created_at: Generated<Date>;
}

/**
 * رمز درست بود، عامل دوم نه.
 *
 * **نشست نیست** و هیچ مسیری را باز نمی‌کند — فقط پل مرحله دوم است.
 */
export interface PendingLoginTable {
  id: Generated<string>;
  token_hash: string;
  user_id: string;
  device_id: string | null;
  ip: string | null;
  expires_at: Date;
  created_at: Generated<Date>;
}

export interface CustomerTable {
  id: Generated<string>;
  mobile_normalized: string;
  full_name: string | null;
  email: string | null;
  birth_date: Date | null;
  status: Generated<string>;
  merged_into: string | null;
  credit_limit: Generated<string>;
  due_days: Generated<number>;
  consent_sms: Generated<boolean>;
  consent_marketing: Generated<boolean>;
  tags: string[] | null;
  internal_note: string | null;
  created_at: Generated<Date>;
  tafsili_no: Generated<number>;
}

// ── خزانه ─────────────────────────────────────────────────────────

export interface PaymentTable {
  id: Generated<string>;
  invoice_id: string | null;
  return_id: string | null;
  shift_id: string | null;
  method_code: string;
  direction: "in" | "out";
  amount: string;
  ref_no: string | null;
  status: string;
  occurred_at: Generated<Date>;
  settled_at: Date | null;
  fee_amount: string;
  note: string | null;
  client_event_id: string | null;
  account_id: string | null;
  settlement_id: string | null;
}

export interface PaymentMethodTable {
  code: string;
  name: string;
  kind: string;
  settlement_days: number;
  fee_percent: string;
  requires_ref: boolean;
  is_active: boolean;
}

// ── پلتفرم ────────────────────────────────────────────────────────

export interface InboxMessageTable {
  source: string;
  event_id: string;
  received_at: Generated<Date>;
  payload: unknown;
  result_ref: string | null;
}

// ── خرید ──────────────────────────────────────────────────────────────

/**
 * سال مالی — دروازه‌ای که سند را از دوره بسته بیرون نگه می‌دارد.
 *
 * `id` عمداً `smallint` است و توسط دیتابیس ساخته **نمی‌شود**: سال مالی
 * ۱۴۰۵ را آدم تعریف می‌کند، نه یک Sequence.
 */
export interface FiscalYearTable {
  id: number;
  starts_on: Date;
  ends_on: Date;
  /** پیش‌فرض `'open'` در دیتابیس. */
  status: Generated<string>;
}

export interface SupplierTable {
  id: Generated<string>;
  code: string;
  name: string;
  mobile: string | null;
  phone: string | null;
  address: string | null;
  national_id: string | null;
  /** پیش‌فرض `true` در دیتابیس. */
  is_active: Generated<boolean>;
  tafsili_no: Generated<number>;
}

export interface ReceiptTable {
  id: Generated<string>;
  /** تا لحظه ثبت NULL است — پیش‌نویس رهاشده شماره نمی‌سوزاند (مهاجرت ۰۲۵). */
  number: string | null;
  branch_id: string;
  supplier_id: string;
  warehouse_id: string;
  supplier_invoice_no: string | null;
  occurred_at: Generated<Date>;
  goods_amount: Generated<string>;
  charges_amount: Generated<string>;
  tax_amount: Generated<string>;
  total_payable: Generated<string>;
  third_party_payable: Generated<string>;
  status: Generated<string>;
  posted_at: Date | null;
  created_by: string | null;
  note: string | null;
  /** سفارشی که این رسید بابتش آمده. تهی = خرید بدون سفارش. */
  order_id: string | null;
}

export interface ReceiptLineTable {
  id: Generated<string>;
  receipt_id: string;
  variation_id: string;
  qty: string;
  unit_price: string;
  line_amount: string;
  charge_alloc: Generated<string>;
  landed_unit_cost: Generated<string>;
  /** جمع برگشتی‌ها. فقط `post_purchase_return()` بالایش می‌برد (مهاجرت ۰۲۸). */
  returned_qty: Generated<string>;
  /** سطر سفارشی که این قلم بابتش آمده. باید به همان سفارشِ رسید باشد. */
  order_line_id: string | null;
}

export interface PurchaseOrderTable {
  id: Generated<string>;
  /** تا لحظه **فرستادن** NULL — پیش‌نویس رهاشده شماره نمی‌سوزاند. */
  number: string | null;
  branch_id: string;
  supplier_id: string;
  warehouse_id: string;
  status: Generated<string>;
  expected_at: string | null;
  note: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  sent_at: Date | null;
  closed_at: Date | null;
  close_reason: string | null;
}

export interface PurchaseOrderLineTable {
  id: Generated<string>;
  order_id: string;
  variation_id: string;
  qty: string;
  /** قیمت توافقی سفارش. بها را رسید تعیین می‌کند، نه این. */
  unit_price: string;
}

/** نما — «چقدرش رسیده» محاسبه است، نه ستون (مهاجرت ۰۲۹). */
export interface OrderProgressView {
  order_line_id: string;
  order_id: string;
  variation_id: string;
  ordered_qty: string;
  ordered_unit_price: string;
  received_qty: string;
  remaining_qty: string;
  over_qty: string;
}

export interface PurchaseReturnTable {
  id: Generated<string>;
  /** تا لحظه ثبت NULL — برگه رهاشده شماره نمی‌سوزاند. */
  number: string | null;
  branch_id: string;
  receipt_id: string;
  warehouse_id: string;
  goods_amount: Generated<string>;
  cost_amount: Generated<string>;
  tax_amount: Generated<string>;
  charge_loss: Generated<string>;
  reason_code: string;
  reason_note: string | null;
  status: Generated<string>;
  occurred_at: Generated<Date>;
  posted_at: Date | null;
  created_by: string | null;
}

export interface PurchaseReturnLineTable {
  id: Generated<string>;
  return_id: string;
  receipt_line_id: string;
  qty: string;
  /** Snapshot در لحظه ثبت. تا آن موقع NULL. */
  unit_price: string | null;
  unit_cost: string | null;
  goods_amount: string | null;
  cost_amount: string | null;
}

export interface ReceiptChargeTable {
  id: Generated<string>;
  receipt_id: string;
  charge_type: string;
  amount: string;
  allocation: Generated<string>;
  paid_from: string | null;
  payee_type: Generated<string>;
  payee_name: string | null;
  paid_account_id: string | null;
  /** فقط برای allocation = none — تهی یعنی حساب پیش‌فرض قاعده ثبت. */
  expense_account_code: string | null;
}

export interface LedgerAccountTable {
  code: string;
  parent_code: string | null;
  name: string;
  level: string;
  nature: string;
  type: string;
  is_postable: boolean;
  is_active: boolean;
}

/**
 * حرکت نقدِ غیرفروشی.
 *
 * ⚠️ `status` و `entry_id` را **فقط** `treasury.post_transaction()`
 *    عوض می‌کند. اینجا فقط برای درج پیش‌نویس و خواندن ثبت شده‌اند؛
 *    نوشتن مستقیم رویشان یعنی سندی که در دفتر نیست.
 */
export interface TreasuryTransactionTable {
  id: Generated<string>;
  /** تا لحظه ثبت NULL — پیش‌نویس رهاشده شماره نمی‌سوزاند. */
  number: string | null;
  branch_id: string;
  purpose:
    | "supplier_payment"
    | "customer_receipt"
    | "expense"
    | "capital"
    | "transfer";
  from_account_id: string | null;
  to_account_id: string | null;
  party_type: "supplier" | "customer" | "user" | "other" | null;
  party_id: string | null;
  expense_account_code: string | null;
  /** رشته، نه عدد — پارسر NUMERIC رشته می‌دهد و همان‌جا می‌ماند. */
  amount: string;
  /**
   * اگر پول از کشوی یک شیفت باز رد شده، شیفت باید بداند. بدون این،
   * هر هزینه نقدی یک مغایرت کاذب در شمارش پایان شیفت می‌سازد.
   */
  shift_id: string | null;
  occurred_at: Generated<Date>;
  status: Generated<"draft" | "posted" | "cancelled">;
  entry_id: string | null;
  client_event_id: string | null;
  ref_no: string | null;
  note: string | null;
  created_by: string | null;
}

/**
 * چک — دریافتی و پرداختی.
 *
 * ⚠️ `status` یک **Projection** از زنجیره `cheque_event` است، نه یک
 *    ستون آزاد. `UPDATE` مستقیم رویش با CONSTRAINT TRIGGER معوق رد
 *    می‌شود (ADR-004). تنها راه حرکتش `treasury.post_cheque_event()`.
 */
export interface ChequeTable {
  id: Generated<string>;
  number: string | null;
  direction: "received" | "issued";
  branch_id: string;
  cheque_no: string;
  sayad_id: string | null;
  bank_name: string;
  bank_branch: string | null;
  account_no: string | null;
  drawer_name: string | null;
  amount: string;
  issued_on: string;
  due_on: string;
  party_type: "customer" | "supplier";
  party_id: string;
  bank_account_id: string | null;
  deposit_account_id: string | null;
  status: Generated<string>;
  client_event_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
}

/** زنجیره رویداد چک — تغییرناپذیر، فقط از post_cheque_event پر می‌شود. */
export interface ChequeEventTable {
  id: Generated<string>;
  cheque_id: string;
  seq: number;
  action: string;
  from_status: string | null;
  to_status: string;
  occurred_on: string;
  amount: string;
  entry_id: string | null;
  account_id: string | null;
  party_type: string | null;
  party_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
}

/** نمای سررسید — `urgency` را دیتابیس حساب می‌کند، نه مرورگر. */
export interface ChequeDueView {
  id: string;
  number: string | null;
  direction: string;
  cheque_no: string;
  sayad_id: string | null;
  bank_name: string;
  amount: string;
  due_on: string;
  status: string;
  party_type: string;
  party_id: string;
  party_name: string | null;
  days_left: number;
  urgency: string;
}

export interface TreasuryAccountTable {
  id: Generated<string>;
  code: string;
  name: string;
  kind: string;
  branch_id: string | null;
  ledger_account_code: string;
  is_active: boolean;
}

// ── انبارگردانی ───────────────────────────────────────────────────────

export interface StockCountTable {
  id: Generated<string>;
  /** تا لحظه ثبت NULL — برگه رهاشده شماره نمی‌سوزاند (مهاجرت ۰۲۷). */
  number: string | null;
  branch_id: string;
  warehouse_id: string;
  status: Generated<string>;
  started_at: Generated<Date>;
  posted_at: Date | null;
  created_by: string | null;
  note: string | null;
}

/**
 * برگه انتقال بین انبارها (مهاجرت ۰۳۶).
 *
 * ⚠️ `number` تا لحظه ثبت `NULL` است — برگه رهاشده شماره نمی‌سوزاند.
 *    و `unit_cost`/`value_delta` روی سطر هم تا ثبت `NULL`اند: بها در
 *    لحظه خروج معلوم می‌شود، نه پیش از آن.
 */
export interface TransferTable {
  id: Generated<string>;
  number: string | null;
  branch_id: string;
  from_warehouse_id: string;
  to_warehouse_id: string;
  status: Generated<string>;
  occurred_at: Generated<Date>;
  posted_at: Date | null;
  note: string | null;
  created_by: string | null;
  posted_by: string | null;
  client_event_id: string | null;
}

export interface TransferLineTable {
  id: Generated<string>;
  transfer_id: string;
  variation_id: string;
  qty: string;
  unit_cost: string | null;
  value_delta: string | null;
}

export interface StockCountLineTable {
  id: Generated<string>;
  count_id: string;
  variation_id: string;
  counted_qty: string;
  /** این چهار ستون را فقط `post_stock_count()` پر می‌کند، در لحظه ثبت. */
  system_qty: string | null;
  diff_qty: string | null;
  unit_cost: string | null;
  value_delta: string | null;
}

export interface Database {
  "ledger.fiscal_year": FiscalYearTable;
  "identity.device_overview": DeviceOverviewView;
  "catalog.brand": BrandTable;
  "catalog.category": CategoryTable;
  "catalog.product": ProductTable;
  "catalog.variation": VariationTable;
  "catalog.price": PriceTable;
  "catalog.season": SeasonTable;
  "sales.measure_key": MeasureKeyTable;
  "inventory.stock_balance": StockBalanceTable;
  "inventory.warehouse": WarehouseTable;
  "sales.cash_shift": CashShiftTable;
  "sales.invoice": InvoiceTable;
  "sales.invoice_line": InvoiceLineTable;
  "identity.totp_enrollment": TotpEnrollmentTable;
  "identity.recovery_code": RecoveryCodeTable;
  "identity.webauthn_credential": WebauthnCredentialTable;
  "identity.webauthn_challenge": WebauthnChallengeTable;
  "identity.pending_login": PendingLoginTable;
  "sales.customer": CustomerTable;
  "sales.sale_return": SaleReturnTable;
  "sales.sale_return_line": SaleReturnLineTable;
  "sales.unposted_revenue": UnpostedRevenueView;
  "ledger.posting_batch": PostingBatchTable;
  "treasury.payment": PaymentTable;
  "treasury.payment_method": PaymentMethodTable;
  "platform.inbox_message": InboxMessageTable;
  "identity.app_user": AppUserTable;
  "identity.role": RoleTable;
  "identity.user_role": UserRoleTable;
  "identity.device": DeviceTable;
  "identity.api_client": ApiClientTable;
  "identity.session": SessionTable;
  "identity.auth_attempt": AuthAttemptTable;
  "platform.setting": SettingTable;
  "platform.setting_group": SettingGroupTable;
  "platform.branch": BranchTable;
  "purchasing.supplier": SupplierTable;
  "purchasing.receipt": ReceiptTable;
  "purchasing.receipt_line": ReceiptLineTable;
  "purchasing.receipt_charge": ReceiptChargeTable;
  "treasury.account": TreasuryAccountTable;
  "treasury.transaction": TreasuryTransactionTable;
  "treasury.cheque": ChequeTable;
  "treasury.cheque_event": ChequeEventTable;
  "treasury.cheque_due": ChequeDueView;
  "ledger.account": LedgerAccountTable;
  "inventory.stock_count": StockCountTable;
  "inventory.stock_count_line": StockCountLineTable;
  "inventory.transfer": TransferTable;
  "inventory.transfer_line": TransferLineTable;
  "purchasing.purchase_order": PurchaseOrderTable;
  "purchasing.purchase_order_line": PurchaseOrderLineTable;
  "purchasing.order_progress": OrderProgressView;
  "purchasing.purchase_return": PurchaseReturnTable;
  "purchasing.purchase_return_line": PurchaseReturnLineTable;
}
