/**
 * نگاشت حساب — «درآمد به کدام حساب بخورد، بهای تمام‌شده به کدام».
 *
 * زبانهٔ «کدینگ حساب» از قبل بود و حساب می‌ساخت. این یکی نبود، و
 * نبودنش یعنی حسابدار می‌توانست حساب ۴۱۰۲ را بسازد ولی نمی‌توانست
 * بگوید «تخفیف را به آن بزن» — آن یک `UPDATE` دستی در psql بود، بی ردّ
 * حسابرسی و بی نگهبان.
 *
 * ── سه چیزی که این صفحه عوض نمی‌کند ─────────────────────────────────
 *
 * `eventType`، `leg` و `side` قرارداد کدند: `sales.post_batch()`
 * مؤلفه را به نام می‌خواند. پس کلید قاعده فقط **نمایش** داده می‌شود و
 * تنها ورودی صفحه، حساب مقصد است. `is_active` و
 * `allow_account_override` هم اینجا نیستند — دلایلشان در مهاجرت ۰۵۳.
 *
 * ── و فهرست حساب‌های مجاز را صفحه نمی‌سازد ───────────────────────────
 *
 * از سرور می‌آید و همان‌جا هم اجبار می‌شود: هم‌نوع، قابل ثبت، فعال.
 * اگر صفحه خودش فیلتر می‌کرد، دو تعریف از یک قاعده داشتیم و آن که در
 * psql دور زده می‌شود همان است که اهمیت دارد. فیلترِ هم‌نوعیِ این
 * صفحه فقط برای این است که کاربر گزینهٔ محکوم‌به‌رد نبیند.
 */
import { useEffect, useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { ApiError } from "../lib/api.ts";
import { admin, type PostingAccount, type PostingRule } from "../lib/admin.ts";

/**
 * برچسب فارسی رویدادها.
 *
 * فهرستش اینجاست چون **متن صفحه** است نه داده — `posting_rule` ستون
 * برچسب رویداد ندارد و هر سطرش `description` خودش را دارد. و عمداً
 * Fallback دارد: رویداد تازه با کد خامش دیده می‌شود، نه اینکه نامرئی
 * بماند. اگر روزی این فهرست عقب بماند، نتیجه‌اش یک عنوان نازیباست نه
 * یک قاعدهٔ گم‌شده.
 */
const EVENT_LABEL: Record<string, string> = {
  sale_shift: "فروش دوره ثبت",
  shift_cogs: "بهای تمام‌شده فروش",
  sale_return: "مرجوعی فروش",
  return_cogs: "بازگشت بهای تمام‌شده",
  purchase_receipt: "رسید خرید",
  purchase_return: "برگشت از خرید",
  settlement: "تسویه پایانه",
  treasury_transfer: "انتقال خزانه",
  supplier_payment: "پرداخت به تأمین‌کننده",
  customer_receipt: "دریافت از مشتری",
  expense_payment: "پرداخت هزینه",
  capital_injection: "آوردهٔ سرمایه",
  cheque_clear: "وصول چک",
  cheque_pay: "پرداخت چک",
  cheque_receive: "دریافت چک",
  cheque_issue: "صدور چک",
  stock_count: "انبارگردانی",
  revaluation: "تجدید ارزیابی",
  opening: "سند افتتاحیه",
};

const SIDE_LABEL: Record<string, string> = { debit: "بدهکار", credit: "بستانکار" };

function message(e: unknown): string {
  return e instanceof ApiError ? e.message : "ارتباط با سرور برقرار نشد";
}

export function PostingRules() {
  const [rules, setRules] = useState<PostingRule[] | null>(null);
  const [accounts, setAccounts] = useState<PostingAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const r = await admin.postingRules();
    setRules(r.rules);
    setAccounts(r.accounts);
  };

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        await load();
      } catch (e: unknown) {
        if (alive) setError(message(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function save(rule: PostingRule, code: string, reason: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await admin.setPostingRule(
        { eventType: rule.eventType, leg: rule.leg, side: rule.side },
        code,
        reason,
      );
      // بازخوانی کامل، نه تغییر موضعی: `entryCount` و نام حساب هر دو از
      // سرور می‌آیند و ساختنشان در مرورگر یعنی دو تعریف.
      await load();
      setNote(`نگاشت «${rule.description}» به حساب ${code} تغییر کرد.`);
    } catch (e: unknown) {
      // پیام نگهبان دیتابیس فارسی و برای کاربر است — «نوع حساب باید یکی
      // بماند» دقیقاً همان چیزی است که باید خوانده شود.
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  if (error !== null && rules === null) {
    return (
      <Solid as="section" className="pad">
        <p className="pos-alert" role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> {error}
        </p>
      </Solid>
    );
  }

  if (rules === null) {
    return (
      <Solid as="section" className="pad">
        <p className="muted">در حال بارگذاری نگاشت حساب‌ها…</p>
      </Solid>
    );
  }

  // ترتیب رویدادها همان ترتیبی است که سرور داد (event_type, sort_order).
  const events: string[] = [];
  for (const r of rules) {
    if (!events.includes(r.eventType)) events.push(r.eventType);
  }

  return (
    <div className="stack" style={{ gap: "var(--s-4)" }}>
      {error !== null ? (
        <p className="solid pos-alert" role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> {error}
        </p>
      ) : null}
      {note !== null ? (
        <p className="solid pos-alert" role="status">
          <span className="dot dot--good" aria-hidden="true">●</span> {note}
        </p>
      ) : null}

      <Solid as="section" className="pad">
        <h2 style={{ marginTop: 0, marginBottom: "var(--s-1)" }}>نگاشت حساب</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          هر رویداد مالی به چند مؤلفه می‌شکند و هر مؤلفه به یک حساب می‌نشیند.
          اینجا تعیین می‌شود کدام حساب. تغییرش دلیل می‌خواهد و در دفتر حسابرسی
          با مقدار پیش و پس ثبت می‌شود.
        </p>
        <p className="muted small">
          ⚠️ تغییر نگاشت <strong>سندهای قبلی را عوض نمی‌کند</strong> و نباید
          بکند — سند مالی تغییرناپذیر است. فقط سندهای بعدی روی حساب تازه
          می‌نشینند.
        </p>
        <p className="muted small">
          نوع حساب مقصد باید با نوع حساب فعلی یکی باشد: «فروش کالا» می‌تواند به
          سرفصل درآمد دیگری برود، ولی نه به یک حساب دارایی. تغییر نگاشت جای
          حساب را عوض می‌کند، نه ماهیتش.
        </p>
      </Solid>

      {events.map((ev) => (
        <Solid as="section" className="pad" key={ev}>
          <h3 style={{ marginTop: 0, marginBottom: "var(--s-1)" }}>
            {EVENT_LABEL[ev] ?? ev}{" "}
            <span className="muted small" dir="ltr">
              {ev}
            </span>
          </h3>
          <ul className="term-list">
            {rules
              .filter((r) => r.eventType === ev)
              .map((r) => (
                <RuleRow
                  key={r.id}
                  rule={r}
                  accounts={accounts}
                  busy={busy}
                  onSave={save}
                />
              ))}
          </ul>
        </Solid>
      ))}
    </div>
  );
}

function RuleRow({
  rule,
  accounts,
  busy,
  onSave,
}: {
  rule: PostingRule;
  accounts: PostingAccount[];
  busy: boolean;
  onSave: (rule: PostingRule, code: string, reason: string) => Promise<void>;
}) {
  const [code, setCode] = useState(rule.accountCode);
  const [reason, setReason] = useState("");

  // حساب فعلی همیشه در فهرست است، حتی اگر امروز غیرفعال شده باشد —
  // وگرنه `<select>` مقداری را نشان می‌داد که کاربر انتخابش نکرده.
  const same = accounts.filter(
    (a) => a.type === rule.accountType || a.code === rule.accountCode,
  );
  const changed = code !== rule.accountCode;

  return (
    <li className="term-row">
      <div className="term-id" style={{ minWidth: "22ch" }}>
        <strong>{rule.description}</strong>
        <span className="muted small">
          {SIDE_LABEL[rule.side] ?? rule.side} · <span dir="ltr">{rule.leg}</span>
        </span>
      </div>

      <label className="term-field">
        <span>حساب مقصد</span>
        <select
          value={code}
          disabled={busy}
          onChange={(e) => setCode(e.target.value)}
          style={{ minWidth: "24ch" }}
        >
          {same.map((a) => (
            <option key={a.code} value={a.code}>
              {a.code} — {a.name}
            </option>
          ))}
        </select>
      </label>

      <label className="term-field term-reason">
        <span>دلیل تغییر</span>
        <input
          type="text"
          value={reason}
          disabled={busy}
          placeholder="اجباری است"
          onChange={(e) => setReason(e.target.value)}
        />
      </label>

      <button
        type="button"
        disabled={busy || !changed || reason.trim().length < 3}
        onClick={() => void onSave(rule, code, reason.trim())}
      >
        ذخیره
      </button>

      <p className="acct-hint muted small">
        {rule.entryCount > 0 ? (
          <>
            حساب فعلی <span dir="ltr">{rule.accountCode}</span> تا امروز{" "}
            {rule.entryCount.toLocaleString("fa-IR")} سطر سند دارد؛ آن‌ها
            دست‌نخورده می‌مانند.
          </>
        ) : (
          <>حساب فعلی هنوز سطر سندی ندارد.</>
        )}
        {rule.allowAccountOverride ? (
          <> این مؤلفه می‌تواند از خودِ تراکنش هم تعیین شود (کدام صندوق، کدام بانک)؛ مقدار اینجا پیش‌فرض است.</>
        ) : null}
      </p>
    </li>
  );
}
