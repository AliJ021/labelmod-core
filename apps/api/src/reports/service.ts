/**
 * گزارش‌ها — هشت پرسشی که مالک هر ماه می‌پرسد.
 *
 * ── چرا این فایل تقریباً هیچ منطقی ندارد ──────────────────────────
 *
 * هر تابع اینجا یک `SELECT * FROM <تابع دیتابیس>` است و بس. **عمداً.**
 * محاسبه مالی در SQL انجام می‌شود؛ اگر همین‌جا یک جمع یا یک درصد
 * حساب می‌شد، دو مرجع برای یک عدد داشتیم و روزی یکی‌شان عقب می‌ماند.
 * کاری که این لایه می‌کند فقط سه چیز است:
 *
 *   ۱. پارامتر را با تایپ درست به دیتابیس بدهد
 *   ۲. پول را **رشته** نگه دارد تا مرز JSON خرابش نکند
 *   ۳. `snake_case` دیتابیس را به `camelCase` پاسخ ترجمه کند
 *
 * ── دامنه شعبه اینجا نیست ─────────────────────────────────────────
 *
 * `branchId` که به توابع می‌رود، همان چیزی است که مسیر HTTP **پس از**
 * `assertBranch` می‌فرستد. دیتابیس نمی‌داند کدام کاربر به کدام شعبه
 * دسترسی دارد و نباید بداند؛ همان جدایی که در `treasury-routes.ts` هست.
 */
import { sql } from "kysely";
import type { Db } from "../db/client.ts";

/** یک بازه تاریخ — همیشه شامل هر دو سر. */
/** یک ساعت از یک روز، به تفکیک کانال. */
export interface HourlyRow {
  businessDate: string;
  hourOfDay: number;
  channel: string;
  invoiceCount: number;
  itemQty: string;
  netAmount: string;
}

/** دو دوره کنار هم. `deltaPercent` وقتی مبنا صفر است `null` می‌شود. */
export interface CompareRow {
  channel: string;
  invoiceCount: number;
  netAmount: string;
  profitAmount: string;
  prevInvoiceCount: number;
  prevNetAmount: string;
  prevProfitAmount: string;
  deltaAmount: string;
  deltaPercent: number | null;
  direction: "up" | "down" | "flat";
}

/** «ده قلم را چند نفر بردند؟» */
export interface BasketRow {
  businessDate: string;
  channel: string;
  invoiceCount: number;
  knownCustomers: number;
  anonymousCount: number;
  itemQty: string;
  lineCount: number;
  netAmount: string;
  qtyPerInvoice: string;
}

/** همان پرسش، در سطح شخص. */
export interface CustomerBasketRow {
  customerId: string;
  fullName: string | null;
  mobile: string | null;
  invoiceCount: number;
  itemQty: string;
  netAmount: string;
  lastPurchase: string;
}

export interface Period {
  from: string;
  to: string;
  branchId?: string | undefined;
}

export interface SalesRow {
  businessDate: string;
  channel: string;
  invoiceCount: number;
  grossAmount: string;
  discountAmount: string;
  netAmount: string;
  returnCount: number;
  returnAmount: string;
  cogsAmount: string;
  profitAmount: string;
}

export interface ProfitRow {
  variationId: string;
  sku: string;
  productName: string;
  color: string;
  size: string;
  qtySold: string;
  qtyReturned: string;
  netAmount: string;
  cogsAmount: string;
  profitAmount: string;
  /** `null` یعنی فروش خالص صفر شده — درصد بی‌معناست، نه صفر. */
  marginPercent: number | null;
}

export interface ValuationRow {
  warehouseId: string;
  warehouseName: string;
  variationId: string;
  sku: string;
  productName: string;
  color: string;
  size: string;
  onHand: string;
  totalValue: string;
  unitCost: string | null;
}

export interface MovementRow {
  occurredAt: string;
  warehouseName: string;
  kind: string;
  qty: string;
  unitCost: string;
  valueDelta: string;
  runningQty: string;
  refType: string | null;
  refId: string | null;
  note: string | null;
}

export interface LedgerRow {
  entryDate: string;
  entryNumber: string;
  description: string | null;
  partyName: string | null;
  debit: string;
  credit: string;
  running: string;
}

export interface TrialRow {
  code: string;
  name: string;
  accountType: string;
  openingBalance: string;
  debit: string;
  credit: string;
  closingBalance: string;
}

export interface PartyRow {
  partyType: string;
  partyId: string;
  partyName: string | null;
  code: string;
  parentName: string;
  debit: string;
  credit: string;
  balance: string;
}

export interface ShiftRow {
  shiftId: string;
  branchName: string;
  userName: string;
  openedAt: string;
  closedAt: string | null;
  openingCash: string;
  cashSales: string;
  cashRefunds: string;
  cashIn: string;
  cashOut: string;
  expectedCash: string | null;
  countedCash: string | null;
  variance: string | null;
  status: string;
}

export class ReportService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async sales(p: Period): Promise<SalesRow[]> {
    const r = await sql<{
      business_date: string;
      channel: string;
      invoice_count: string;
      gross_amount: string;
      discount_amount: string;
      net_amount: string;
      return_count: string;
      return_amount: string;
      cogs_amount: string;
      profit_amount: string;
    }>`SELECT business_date::text, channel, invoice_count, gross_amount::text,
              discount_amount::text, net_amount::text, return_count,
              return_amount::text, cogs_amount::text, profit_amount::text
         FROM sales.report_summary(${p.from}::date, ${p.to}::date,
                                   ${p.branchId ?? null}::uuid)`
      .execute(this.#db);
    return r.rows.map((x) => ({
      businessDate: x.business_date,
      channel: x.channel,
      invoiceCount: Number(x.invoice_count),
      grossAmount: x.gross_amount,
      discountAmount: x.discount_amount,
      netAmount: x.net_amount,
      returnCount: Number(x.return_count),
      returnAmount: x.return_amount,
      cogsAmount: x.cogs_amount,
      profitAmount: x.profit_amount,
    }));
  }

  /**
   * فروش به تفکیک ساعتِ کاری.
   *
   * ساعت را دیتابیس می‌دهد، نه `new Date().getHours()` — سرور تولید
   * UTC است و ساعت مرورگر هم دست کاربر. یک تعریف: `business_hour`.
   */
  async hourly(p: Period): Promise<HourlyRow[]> {
    const r = await sql<{
      business_date: string;
      hour_of_day: number;
      channel: string;
      invoice_count: string;
      item_qty: string;
      net_amount: string;
    }>`SELECT business_date::text, hour_of_day, channel, invoice_count,
              item_qty::text, net_amount::text
         FROM sales.report_hourly(${p.from}::date, ${p.to}::date,
                                  ${p.branchId ?? null}::uuid)`
      .execute(this.#db);
    return r.rows.map((x) => ({
      businessDate: x.business_date,
      hourOfDay: Number(x.hour_of_day),
      channel: x.channel,
      invoiceCount: Number(x.invoice_count),
      itemQty: x.item_qty,
      netAmount: x.net_amount,
    }));
  }

  /**
   * مقایسه دو دوره.
   *
   * هر دو بازه از بالادست می‌آیند. تقویم این فروشگاه جلالی است و
   * «ماه قبلِ» میلادی با آن نمی‌خواند؛ انتخاب دوره جای دیگری است.
   */
  async compare(p: Period, prev: { from: string; to: string }): Promise<CompareRow[]> {
    const r = await sql<{
      channel: string;
      invoice_count: string;
      net_amount: string;
      profit_amount: string;
      prev_invoice_count: string;
      prev_net_amount: string;
      prev_profit_amount: string;
      delta_amount: string;
      delta_percent: string | null;
      direction: string;
    }>`SELECT channel, invoice_count, net_amount::text, profit_amount::text,
              prev_invoice_count, prev_net_amount::text, prev_profit_amount::text,
              delta_amount::text, delta_percent::text, direction
         FROM sales.report_compare(${p.from}::date, ${p.to}::date,
                                   ${prev.from}::date, ${prev.to}::date,
                                   ${p.branchId ?? null}::uuid)`
      .execute(this.#db);
    return r.rows.map((x) => ({
      channel: x.channel,
      invoiceCount: Number(x.invoice_count),
      netAmount: x.net_amount,
      profitAmount: x.profit_amount,
      prevInvoiceCount: Number(x.prev_invoice_count),
      prevNetAmount: x.prev_net_amount,
      prevProfitAmount: x.prev_profit_amount,
      deltaAmount: x.delta_amount,
      // درصد یک نسبت است نه پول، پس `number` می‌شود — ولی `null` باید
      // `null` بماند: «مبنا صفر بود» با «صفر درصد» یکی نیست.
      deltaPercent: x.delta_percent === null ? null : Number(x.delta_percent),
      direction: x.direction as CompareRow["direction"],
    }));
  }

  async basket(p: Period): Promise<BasketRow[]> {
    const r = await sql<{
      business_date: string;
      channel: string;
      invoice_count: string;
      known_customers: string;
      anonymous_count: string;
      item_qty: string;
      line_count: string;
      net_amount: string;
      qty_per_invoice: string;
    }>`SELECT business_date::text, channel, invoice_count, known_customers,
              anonymous_count, item_qty::text, line_count, net_amount::text,
              qty_per_invoice::text
         FROM sales.report_basket(${p.from}::date, ${p.to}::date,
                                  ${p.branchId ?? null}::uuid)`
      .execute(this.#db);
    return r.rows.map((x) => ({
      businessDate: x.business_date,
      channel: x.channel,
      invoiceCount: Number(x.invoice_count),
      knownCustomers: Number(x.known_customers),
      anonymousCount: Number(x.anonymous_count),
      itemQty: x.item_qty,
      lineCount: Number(x.line_count),
      netAmount: x.net_amount,
      qtyPerInvoice: x.qty_per_invoice,
    }));
  }

  async customerBasket(p: Period, limit: number): Promise<CustomerBasketRow[]> {
    const r = await sql<{
      customer_id: string;
      full_name: string | null;
      mobile: string | null;
      invoice_count: string;
      item_qty: string;
      net_amount: string;
      last_purchase: string;
    }>`SELECT customer_id, full_name, mobile, invoice_count, item_qty::text,
              net_amount::text, last_purchase::text
         FROM sales.report_customer_basket(${p.from}::date, ${p.to}::date,
                                           ${p.branchId ?? null}::uuid,
                                           ${limit}::int)`
      .execute(this.#db);
    return r.rows.map((x) => ({
      customerId: x.customer_id,
      fullName: x.full_name,
      mobile: x.mobile,
      invoiceCount: Number(x.invoice_count),
      itemQty: x.item_qty,
      netAmount: x.net_amount,
      lastPurchase: x.last_purchase,
    }));
  }

  async profitByProduct(p: Period, limit: number): Promise<ProfitRow[]> {
    const r = await sql<{
      variation_id: string;
      sku: string;
      product_name: string;
      color: string;
      size: string;
      qty_sold: string;
      qty_returned: string;
      net_amount: string;
      cogs_amount: string;
      profit_amount: string;
      margin_percent: string | null;
    }>`SELECT variation_id, sku, product_name, color, size,
              qty_sold::text, qty_returned::text, net_amount::text,
              cogs_amount::text, profit_amount::text, margin_percent::text
         FROM sales.report_profit_by_product(${p.from}::date, ${p.to}::date,
                                             ${p.branchId ?? null}::uuid, ${limit}::int)`
      .execute(this.#db);
    return r.rows.map((x) => ({
      variationId: x.variation_id,
      sku: x.sku,
      productName: x.product_name,
      color: x.color,
      size: x.size,
      qtySold: x.qty_sold,
      qtyReturned: x.qty_returned,
      netAmount: x.net_amount,
      cogsAmount: x.cogs_amount,
      profitAmount: x.profit_amount,
      // درصد **عدد** است نه پول: از محدوده دقیق `number` رد نمی‌شود و
      // نمودار و مرتب‌سازی رویش کار می‌کند.
      marginPercent: x.margin_percent === null ? null : Number(x.margin_percent),
    }));
  }

  async valuation(warehouseId?: string | undefined): Promise<ValuationRow[]> {
    const r = await sql<{
      warehouse_id: string;
      warehouse_name: string;
      variation_id: string;
      sku: string;
      product_name: string;
      color: string;
      size: string;
      on_hand: string;
      total_value: string;
      unit_cost: string | null;
    }>`SELECT warehouse_id, warehouse_name, variation_id, sku, product_name,
              color, size, on_hand::text, total_value::text, unit_cost::text
         FROM inventory.report_valuation(${warehouseId ?? null}::uuid)`
      .execute(this.#db);
    return r.rows.map((x) => ({
      warehouseId: x.warehouse_id,
      warehouseName: x.warehouse_name,
      variationId: x.variation_id,
      sku: x.sku,
      productName: x.product_name,
      color: x.color,
      size: x.size,
      onHand: x.on_hand,
      totalValue: x.total_value,
      unitCost: x.unit_cost,
    }));
  }

  async movements(input: {
    variationId: string;
    from: string;
    to: string;
    warehouseId?: string | undefined;
  }): Promise<MovementRow[]> {
    const r = await sql<{
      occurred_at: Date;
      warehouse_name: string;
      kind: string;
      qty: string;
      unit_cost: string;
      value_delta: string;
      running_qty: string;
      ref_type: string | null;
      ref_id: string | null;
      note: string | null;
    }>`SELECT occurred_at, warehouse_name, kind, qty::text, unit_cost::text,
              value_delta::text, running_qty::text, ref_type, ref_id, note
         FROM inventory.report_movements(${input.variationId}::uuid,
                ${input.from}::date, ${input.to}::date,
                ${input.warehouseId ?? null}::uuid)`
      .execute(this.#db);
    return r.rows.map((x) => ({
      occurredAt: x.occurred_at.toISOString(),
      warehouseName: x.warehouse_name,
      kind: x.kind,
      qty: x.qty,
      unitCost: x.unit_cost,
      valueDelta: x.value_delta,
      runningQty: x.running_qty,
      refType: x.ref_type,
      refId: x.ref_id,
      note: x.note,
    }));
  }

  async accountLedger(code: string, p: Period): Promise<LedgerRow[]> {
    const r = await sql<{
      entry_date: string;
      entry_number: string;
      description: string | null;
      party_name: string | null;
      debit: string;
      credit: string;
      running: string;
    }>`SELECT entry_date::text, entry_number, description, party_name,
              debit::text, credit::text, running::text
         FROM ledger.report_account_ledger(${code}::text, ${p.from}::date,
                ${p.to}::date, ${p.branchId ?? null}::uuid)`
      .execute(this.#db);
    return r.rows.map((x) => ({
      entryDate: x.entry_date,
      entryNumber: x.entry_number,
      description: x.description,
      partyName: x.party_name,
      debit: x.debit,
      credit: x.credit,
      running: x.running,
    }));
  }

  async trialBalance(p: Period): Promise<TrialRow[]> {
    const r = await sql<{
      code: string;
      name: string;
      account_type: string;
      opening_balance: string;
      debit: string;
      credit: string;
      closing_balance: string;
    }>`SELECT code, name, account_type, opening_balance::text, debit::text,
              credit::text, closing_balance::text
         FROM ledger.report_trial_balance(${p.from}::date, ${p.to}::date,
                                          ${p.branchId ?? null}::uuid)`
      .execute(this.#db);
    return r.rows.map((x) => ({
      code: x.code,
      name: x.name,
      accountType: x.account_type,
      openingBalance: x.opening_balance,
      debit: x.debit,
      credit: x.credit,
      closingBalance: x.closing_balance,
    }));
  }

  async partyBalances(partyType?: string | undefined): Promise<PartyRow[]> {
    const r = await sql<{
      party_type: string;
      party_id: string;
      party_name: string | null;
      code: string;
      parent_name: string;
      debit: string;
      credit: string;
      balance: string;
    }>`SELECT party_type, party_id, party_name, code, parent_name,
              debit::text, credit::text, balance::text
         FROM ledger.report_party_balances(${partyType ?? null}::text)`
      .execute(this.#db);
    return r.rows.map((x) => ({
      partyType: x.party_type,
      partyId: x.party_id,
      partyName: x.party_name,
      code: x.code,
      parentName: x.parent_name,
      debit: x.debit,
      credit: x.credit,
      balance: x.balance,
    }));
  }

  async cashReconciliation(p: Period): Promise<ShiftRow[]> {
    const r = await sql<{
      shift_id: string;
      branch_name: string;
      user_name: string;
      opened_at: Date;
      closed_at: Date | null;
      opening_cash: string;
      cash_sales: string;
      cash_refunds: string;
      cash_in: string;
      cash_out: string;
      expected_cash: string | null;
      counted_cash: string | null;
      variance: string | null;
      status: string;
    }>`SELECT shift_id, branch_name, user_name, opened_at, closed_at,
              opening_cash::text, cash_sales::text, cash_refunds::text,
              cash_in::text, cash_out::text, expected_cash::text,
              counted_cash::text, variance::text, status
         FROM treasury.report_cash_reconciliation(${p.from}::date, ${p.to}::date,
                                                  ${p.branchId ?? null}::uuid)`
      .execute(this.#db);
    return r.rows.map((x) => ({
      shiftId: x.shift_id,
      branchName: x.branch_name,
      userName: x.user_name,
      openedAt: x.opened_at.toISOString(),
      closedAt: x.closed_at === null ? null : x.closed_at.toISOString(),
      openingCash: x.opening_cash,
      cashSales: x.cash_sales,
      cashRefunds: x.cash_refunds,
      cashIn: x.cash_in,
      cashOut: x.cash_out,
      expectedCash: x.expected_cash,
      countedCash: x.counted_cash,
      variance: x.variance,
      status: x.status,
    }));
  }
}
