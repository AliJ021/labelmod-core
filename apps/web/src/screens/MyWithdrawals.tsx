import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { ResultState } from "../components/ResultState.tsx";
import { Pager, WithdrawalHistory, WithdrawalStatus } from "../components/WithdrawalHistory.tsx";
import { Button, Field } from "../components/ui/Controls.tsx";
import { DataTable, type Column } from "../components/ui/DataTable.tsx";
import { Money } from "../components/ui/Money.tsx";
import { PageHeader, SectionHeader } from "../components/ui/PageHeader.tsx";
import { SafeAction } from "../components/ui/SafeAction.tsx";
import { Skeleton } from "../components/ui/Skeleton.tsx";
import { useWithdrawalOperation } from "../lib/use-withdrawal-operation.ts";
import { api, ApiError } from "../lib/api.ts";
import { formatCount, formatJalaliMoment } from "../lib/format.ts";
import { useLatestQuery } from "../lib/use-latest-query.ts";
import { useNavigationGuard, useUrlState } from "../lib/use-url-state.ts";
import { checkAmount, checkText, createPayload, PAGE_SIZE, REASON_MAX, tomanDraft, type WithdrawalDetail, type WithdrawalItem, type WithdrawalPage } from "../lib/withdrawals.ts";

/**
 * برداشت‌های من — بخش شخصی «حساب من» (مهاجرت ۰۸۴).
 *
 * هر کاربر واردشده، بی‌توجه به نقش، برداشت خودش را با مبلغ و دلیل ثبت
 * می‌کند و فقط برداشت‌های خودش را می‌بیند. مالک و زمان از سرور می‌آیند؛
 * این صفحه هیچ شناسهٔ کاربری نمی‌فرستد. پس از ثبت، فقط مدیر کل اصلاح
 * می‌کند و همان اصلاح با نام و دلیلش در تاریخچه دیده می‌شود.
 *
 * ⚠️ **دفتر است، نه پرداخت:** نه صندوق، نه دفتر حسابداری، نه حقوق.
 * ⚠️ نتیجهٔ نامعلوم «ارسال دوباره» ندارد: `SafeAction` فقط با همان شناسهٔ
 *    عملیات از سرور می‌پرسد (`/withdrawals/mine/by-key/:key`) و تا روشن‌شدن،
 *    فرم قفل می‌ماند تا بدنهٔ دیگری با کلید تازه ثبت دوم نسازد.
 */
export function MyWithdrawals({ currentUserId }: { currentUserId: string }) {
  const [pageText, setPage] = useUrlState("settings.wdPage", "1");
  const [selected, setSelected] = useUrlState("settings.wd");
  const page = Math.max(1, Math.floor(Number(pageText)) || 1);
  const [reload, setReload] = useState(0);
  const loadList = useCallback((signal: AbortSignal) =>
    api.get<WithdrawalPage>(`/withdrawals/mine?page=${page}&pageSize=${PAGE_SIZE}`, { signal }), [page]);
  const list = useLatestQuery({ key: String(page), version: reload, load: loadList });

  const [amount, setAmount] = useState(""), [reason, setReason] = useState("");
  const [done, setDone] = useState<string | null>(null);
  // بدنهٔ فرستاده‌شده‌ای که نتیجه‌اش هنوز روشن نیست؛ تا آن زمان فرم قفل است.
  const recovery = useWithdrawalOperation(currentUserId, "create");
  const frozen = recovery.pending?.body ?? null;
  const payload = createPayload(amount, reason);
  const locked = frozen !== null;
  const shown = frozen ?? payload;
  const amountCheck = checkAmount(amount, false);
  const reasonError = checkText(reason, "دلیل");
  useNavigationGuard(amount !== "" || reason !== "", "برداشتِ ثبت‌نشده دارید. صفحه را ترک کنید؟");

  const formId = useId(), listId = useId();
  async function create() {
    const body = shown;
    if (!body) throw new Error("فرم معتبر نیست");
    const operation = recovery.prepare(body);
    try {
      await api.post("/withdrawals", operation.body, { idempotencyKey: operation.key });
      recovery.clear(operation.key);
    } catch (err) {
      // ردِ قطعی (۴xx): اثری نمانده و فرم دوباره قابل ویرایش است. «در حال پردازش»
      // قطعی نیست، پس قفل و کلید می‌مانند.
      if (err instanceof ApiError && [400, 409, 422].includes(err.status) && !["idempotency_in_flight", "idempotency_key_reused"].includes(err.code)) {
        recovery.clear(operation.key);
      }
      throw err;
    }
  }
  async function verify() {
    const body = frozen;
    if (!body) return false;
    const key = recovery.pending!.key;
    const found = await api.get<{ status: "recorded" | "not_found" }>(`/withdrawals/mine/by-key/${encodeURIComponent(key)}`);
    return found.status === "recorded";
  }
  function finished(outcome: "done" | "verified") {
    recovery.clear(); setAmount(""); setReason("");
    setDone(outcome === "verified" ? "بررسی شد: برداشت پیش‌تر ثبت شده بود." : "برداشت ثبت شد.");
    setPage("1"); setReload(v => v + 1);
  }

  const columns: Column<WithdrawalItem>[] = [
    { key: "at", header: "زمان ثبت", cell: r => <span className="cell-nowrap">{formatJalaliMoment(r.createdAt)}</span> },
    { key: "amount", header: "مبلغ", numeric: true, cell: r => <Money rial={r.amount} exact size="sm" /> },
    { key: "reason", header: "دلیل", cell: r => r.reason },
    { key: "state", header: "وضعیت", cell: r => <WithdrawalStatus item={r} /> },
  ];

  return <div className="settings-page">
    <PageHeader title="برداشت‌های من"
      context="مبلغ و دلیل هر برداشت خود را ثبت کنید. این دفتر فقط ثبت است: هیچ اثری بر صندوق، حساب‌ها یا حقوق ندارد. پس از ثبت، فقط مدیر کل می‌تواند مبلغ یا دلیل را اصلاح کند." />

    <Solid as="section" className="settings-section" aria-labelledby={formId}>
      <SectionHeader id={formId} title="ثبت برداشت تازه" description="زمان و نام شما را سرور ثبت می‌کند." />
      <div className="settings-form">
        <Field label="مبلغ (تومان)" error={amountCheck.error}
          hint={amountCheck.rial ? <>ثبت می‌شود: <Money rial={amountCheck.rial} exact size="sm" /></> : "بدون اعشار؛ رقم فارسی یا لاتین."}>
          <input type="text" inputMode="numeric" autoComplete="off" value={frozen ? tomanDraft(frozen.amount) : amount} disabled={locked}
            onChange={e => { setAmount(e.target.value); setDone(null); }} />
        </Field>
        <Field label="دلیل برداشت" error={reasonError} hint={`حداکثر ${formatCount(REASON_MAX)} نویسه.`}>
          <textarea className="set-input" rows={3} maxLength={REASON_MAX} value={frozen?.reason ?? reason} disabled={locked}
            onChange={e => { setReason(e.target.value); setDone(null); }} />
        </Field>
        {locked ? <p className="settings-note" role="status">تا روشن‌شدن نتیجهٔ ثبت قبلی، فرم قفل است. شناسهٔ عملیات با بستن صفحه حفظ می‌شود.</p> : null}
        {recovery.error ? <p role="alert">{recovery.error}</p> : null}
        <div className="settings-actions">
          <SafeAction trigger="ثبت برداشت" triggerVariant="primary" disabled={!shown || !!recovery.error} initialUnknown={!!frozen}
            title="ثبت برداشت"
            summary={shown ? <dl className="settings-facts">
              <div><dt>مبلغ</dt><dd><Money rial={shown.amount} exact /></dd></div>
              <div><dt>دلیل</dt><dd>{shown.reason}</dd></div>
            </dl> : null}
            consequence="به نام شما و با زمان سرور ثبت می‌شود؛ ویرایش مستقیم یا حذف ندارد و اصلاح فقط با مجوز مدیر کل و حفظ تاریخچه است. هیچ پولی جابه‌جا نمی‌شود."
            confirmLabel="ثبت برداشت" pendingLabel="در حال ثبت…"
            run={create} verify={verify} onDone={finished} />
        </div>
        {done ? <p className="set-msg set-msg--good" role="status">{done}</p> : null}
      </div>
    </Solid>

    <Solid as="section" className="settings-section" aria-labelledby={listId}>
      <SectionHeader id={listId} title="برداشت‌های ثبت‌شده" description="تازه‌ترین بالا. مبالغ به تومان‌اند." />
      {list.loading ? <Skeleton variant="row" lines={4} label="در حال دریافت برداشت‌ها…" />
        : list.error ? <ResultState kind="error" title={list.error instanceof ApiError ? list.error.message : "دریافت برداشت‌ها ممکن نشد."}
            reference={list.error instanceof ApiError ? list.error.correlationId : null} actionLabel="تلاش دوباره" onAction={() => setReload(v => v + 1)} />
        : list.data ? <>
          <DataTable caption="برداشت‌های من" columns={columns} rows={list.data.items} rowKey={r => r.id} stack
            empty={page > 1 ? { title: "این صفحه خالی است." } : { title: "هنوز برداشتی ثبت نکرده‌اید.", description: "نخستین برداشت را از فرم بالا ثبت کنید." }}
            rowActions={r => <button type="button" className="link" aria-pressed={selected === r.id}
              aria-label={`تاریخچهٔ برداشت ${formatJalaliMoment(r.createdAt)}`} onClick={() => setSelected(selected === r.id ? "" : r.id)}>تاریخچه</button>} />
          <Pager page={page} total={list.data.total} label="صفحه‌بندی برداشت‌های من" onPage={p => setPage(String(p))} />
        </> : null}
    </Solid>

    {selected ? <MyWithdrawalDetail id={selected} version={reload} onClose={() => setSelected("")} /> : null}
  </div>;
}

function MyWithdrawalDetail({ id, version, onClose }: { id: string; version: number; onClose: () => void }) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const load = useCallback((signal: AbortSignal) => api.get<WithdrawalDetail>(`/withdrawals/mine/${encodeURIComponent(id)}`, { signal }), [id]);
  const q = useLatestQuery({ key: id, version, load });
  useEffect(() => { heading.current?.focus(); }, [id]);
  return <Solid as="section" className="settings-section" aria-labelledby={headingId}>
    <div className="section-header">
      <div>
        <h2 className="section-title" id={headingId} ref={heading} tabIndex={-1}>تاریخچهٔ برداشت</h2>
        {q.data ? <p className="section-description">ثبت {formatJalaliMoment(q.data.createdAt)} · مقدار فعلی <Money rial={q.data.amount} exact size="sm" /></p> : null}
      </div>
      <div className="section-actions"><Button variant="quiet" onClick={onClose}>بستن تاریخچه</Button></div>
    </div>
    {q.loading ? <Skeleton variant="row" lines={2} label="در حال دریافت تاریخچه…" />
      : q.error ? <ResultState kind="error" title={q.error instanceof ApiError ? q.error.message : "دریافت تاریخچه ممکن نشد."}
          reference={q.error instanceof ApiError ? q.error.correlationId : null} />
      : q.data ? <>
        <div><WithdrawalStatus item={q.data} /></div>
        <WithdrawalHistory history={q.data.history} caption="تاریخچهٔ نسخه‌های این برداشت" />
      </> : null}
  </Solid>;
}
