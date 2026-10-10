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
import { useCallback, useEffect, useRef, useState } from "react";
import { useLatestQuery } from "../lib/use-latest-query.ts";
import { useNavigationGuard } from "../lib/use-url-state.ts";
import { PageHeader, SectionHeader } from "../components/ui/PageHeader.tsx";
import { Button, Field } from "../components/ui/Controls.tsx";
import { Ltr } from "../components/ui/Bidi.tsx";
import { ResultState } from "../components/ResultState.tsx";
import "../styles/accounts-mapping.css";
import { Solid } from "../components/Glass.tsx";
import { session } from "../lib/session.ts";
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

  const [canEdit, setCanEdit] = useState<boolean | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void session.can("ledger.mapping", {signal: controller.signal})
      .then(result => {if (!controller.signal.aborted) setCanEdit(result.verdict === "allow");})
      .catch(() => {if (!controller.signal.aborted) setCanEdit(false);});
    return () => controller.abort();
  }, []);
  const working = useRef(false);
  const [needsRead, setNeedsRead] = useState(false);
  const [version, refresh] = useState(0);
  const load = useCallback((signal: AbortSignal) => admin.postingRules(signal), []);
  const query = useLatestQuery({key: "posting-rules", version, load});
  useEffect(() => {
    if (query.data) {
      setRules(query.data.rules);
      setAccounts(query.data.accounts);
      setNeedsRead(false);setError(null);
    }
  }, [query.data]);
  const blocked = canEdit !== true || busy || query.loading || !!query.error || needsRead;

  async function save(rule: PostingRule, code: string, reason: string) {
    if (working.current || blocked) return false;
    working.current = true;
    setBusy(true);
    setError(null);
    setNote(null);
    let written = false;
    try {
      await admin.setPostingRule(
        { eventType: rule.eventType, leg: rule.leg, side: rule.side },
        code,
        reason,
      );
      written = true;
      // بازخوانی کامل، نه تغییر موضعی: `entryCount` و نام حساب هر دو از
      // سرور می‌آیند و ساختنشان در مرورگر یعنی دو تعریف.
      const result = await admin.postingRules();
      setRules(result.rules);
      setAccounts(result.accounts);
      setNote(`نگاشت «${rule.description}» به حساب ${code} تغییر کرد.`);
      return true;
    } catch (e: unknown) {
      // پیام نگهبان دیتابیس فارسی و برای کاربر است — «نوع حساب باید یکی
      // بماند» دقیقاً همان چیزی است که باید خوانده شود.
      setError(message(e));
      if (written || !(e instanceof ApiError) || e.status >= 500) setNeedsRead(true);
      return false;
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  // ترتیب رویدادها همان ترتیبی است که سرور داد (event_type, sort_order).
  const events: string[] = [];
  for (const r of rules ?? []) {
    if (!events.includes(r.eventType)) events.push(r.eventType);
  }

  return (
    <div className="account-workspace">
      <PageHeader title="نگاشت حساب" context="حساب مقصد هر رویداد مالی را با ثبت دلیل تغییر مشخص کنید."
        actions={<Button disabled={query.loading || busy} onClick={() => refresh(v => v + 1)}>بررسی دوباره</Button>} />
      {canEdit === false && <p className="muted small">فقط مشاهده؛ دسترسی ثبت تغییرات تأیید نشده است.</p>}
      {query.error ? <ResultState kind="error" title={message(query.error)} description="تا خواندن موفق اطلاعات، ثبت تغییرات متوقف است؛ ورودی‌های شما حفظ شده‌اند."
        actionLabel="تلاش دوباره" onAction={() => refresh(v => v + 1)} /> : null}
      {needsRead ? <p className="solid pad" role="alert">نتیجهٔ ذخیره هنوز روشن نیست؛ «بررسی دوباره» را بزنید و حساب فعلی را پیش از ثبت تازه بررسی کنید.</p> : null}
      {query.loading ? <p role="status" className="muted">در حال بارگذاری نگاشت حساب‌ها…</p> : null}
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

      <Solid as="section" className="pad mapping-guidance">
        <SectionHeader title="تغییر برای سندهای آینده" description="سندهای قبلی دست‌نخورده می‌مانند. فقط حساب‌های هم‌نوع مقصد نمایش داده می‌شوند؛ سرور فعال و قابل ثبت بودن حساب را بررسی می‌کند." />
        <p className="muted small">دلیل تغییر همراه مقدار پیش و پس در دفتر حسابرسی ثبت می‌شود.</p>
      </Solid>
      {rules?.length === 0 && <ResultState title="نگاشتی برای نمایش وجود ندارد." />}

      {events.map((ev) => (
        <Solid as="section" className="pad" key={ev}>
          <SectionHeader title={EVENT_LABEL[ev] ?? ev} />
          <p className="muted small mapping-event-code"><Ltr>{ev}</Ltr></p>
          <ul className="mapping-list">
            {rules?.filter((r) => r.eventType === ev)
              .map((r) => (
                <RuleRow
                  key={r.id}
                  rule={r}
                  accounts={accounts}
                  busy={blocked}
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
  onSave: (rule: PostingRule, code: string, reason: string) => Promise<boolean>;
}) {
  const [code, setCode] = useState(rule.accountCode);
  const [reason, setReason] = useState("");

  // حساب فعلی همیشه در فهرست است، حتی اگر امروز غیرفعال شده باشد —
  // وگرنه `<select>` مقداری را نشان می‌داد که کاربر انتخابش نکرده.
  const same = accounts.filter(
    (a) => a.type === rule.accountType || a.code === rule.accountCode,
  );
  const changed = code !== rule.accountCode;
  useNavigationGuard(changed || reason !== "", "تغییر نگاشت ذخیره نشده است. از این صفحه خارج می‌شوید؟");

  return (
    <li className="mapping-row">
      <div className="mapping-row-heading">
        <strong>{rule.description}</strong>
        <span className="muted small">{SIDE_LABEL[rule.side] ?? rule.side} · <Ltr>{rule.leg}</Ltr></span>
      </div>
      <Field label="حساب مقصد">
        <select value={code} disabled={busy} onChange={e => setCode(e.target.value)}>
          {same.map(a => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
        </select>
      </Field>
      <Field label="دلیل تغییر" hint="حداقل ۳ نویسه؛ در سابقهٔ حسابرسی ثبت می‌شود.">
        <input value={reason} disabled={busy} onChange={e => setReason(e.target.value)} />
      </Field>
      <Button variant="primary" disabled={busy || !changed || reason.trim().length < 3}
        onClick={() => {void onSave(rule, code, reason.trim()).then(saved => {if(saved)setReason("");});}}>ذخیره نگاشت</Button>

      <p className="acct-hint muted small">
        {rule.entryCount > 0 ? (
          <>
            حساب فعلی <Ltr>{rule.accountCode}</Ltr> تا امروز{" "}
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
