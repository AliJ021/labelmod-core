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
  tax_rate_code: string;
}

export interface VariationTable {
  id: Generated<string>;
  product_id: string;
  color: string | null;
  size: string | null;
  sku: string;
  barcode: string | null;
  status: string;
}

export interface PriceTable {
  id: Generated<string>;
  variation_id: string;
  price_list: string;
  /** رشته، نه عدد — پارسر NUMERIC رشته می‌دهد و همان‌جا می‌ماند. */
  amount: string;
  kind: "regular" | "markdown" | "promo";
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

export interface CustomerTable {
  id: Generated<string>;
  mobile_normalized: string;
  full_name: string | null;
  credit_limit: string;
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

export interface SupplierTable {
  id: Generated<string>;
  code: string;
  name: string;
  mobile: string | null;
  phone: string | null;
  address: string | null;
  national_id: string | null;
  is_active: boolean;
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
  "catalog.product": ProductTable;
  "catalog.variation": VariationTable;
  "catalog.price": PriceTable;
  "inventory.stock_balance": StockBalanceTable;
  "inventory.warehouse": WarehouseTable;
  "sales.cash_shift": CashShiftTable;
  "sales.invoice": InvoiceTable;
  "sales.invoice_line": InvoiceLineTable;
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
  "ledger.account": LedgerAccountTable;
  "inventory.stock_count": StockCountTable;
  "inventory.stock_count_line": StockCountLineTable;
}
