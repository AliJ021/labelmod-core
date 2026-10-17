import { AmountInput } from "../components/ui/AmountInput.tsx";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { ResultState } from "../components/ResultState.tsx";
import { BonusStatus, BonusTimeline } from "../components/BonusParts.tsx";
import { Pager } from "../components/WithdrawalHistory.tsx";
import { Button, Field } from "../components/ui/Controls.tsx";
import { DataTable, type Column } from "../components/ui/DataTable.tsx";
import { Money } from "../components/ui/Money.tsx";
import { PageHeader, SectionHeader } from "../components/ui/PageHeader.tsx";
import { SafeAction } from "../components/ui/SafeAction.tsx";
import { Skeleton } from "../components/ui/Skeleton.tsx";
import { useBonusOperation } from "../lib/use-withdrawal-operation.ts";
import { api, ApiError } from "../lib/api.ts";
import { ORIGIN_LABEL, requestPayload, type BonusDetail, type BonusItem, type BonusPage, type RequestBody } from "../lib/bonuses.ts";
import { formatCount, formatJalaliMoment } from "../lib/format.ts";
import { useLatestQuery } from "../lib/use-latest-query.ts";
import { useNavigationGuard, useUrlState } from "../lib/use-url-state.ts";
import { checkAmount, checkText, PAGE_SIZE, REASON_MAX, tomanDraft } from "../lib/withdrawals.ts";

/**
 * پاداش‌های من — بخش شخصی «برداشت و پاداش» (مهاجرت ۰۹۸).
 *
 * هر کاربر واردشده درخواست پاداش خودش را با مبلغ و دلیل ثبت می‌کند و فقط
 * پاداش‌های خودش را — درخواستی یا اعطایی مدیر — با وضعیت و نام بررسی‌کننده
 * می‌بیند. ذی‌نفع و زمان از سرور؛ این صفحه هیچ شناسهٔ کاربری نمی‌فرستد.
 *
 * ⚠️ **دفتر است، نه پرداخت:** نه صندوق، نه دفتر حسابداری، نه حقوق.
 * ⚠️ نتیجهٔ نامعلوم «ارسال دوباره» ندارد: فقط با همان شناسهٔ عملیات
 *    (`/bonuses/mine/by-key/:key`) بررسی می‌شود و تا روشن‌شدن، فرم قفل است.
 */
export function MyBonuses({ currentUserId }: { currentUserId: string }) {
  const [pageText, setPage] = useUrlState("personnel.bnPage", "1");
  const [selected, setSelected] = useUrlState("personnel.bn");
  const page = Math.max(1, Math.floor(Number(pageText)) || 1);
  const [reload, setReload] = useState(0);
  const loadList = useCallback((signal: AbortSignal) =>
    api.get<BonusPage>(`/bonuses/mine?page=${page}&pageSize=${PAGE_SIZE}`, { signal }), [page]);
  const list = useLatestQuery({ key: String(page), version: reload, load: loadList });

  const [amount, setAmount] = useState(""), [reason, setReason] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const recovery = useBonusOperation(currentUserId, "request");
  const frozen = (recovery.pending?.body ?? null) as RequestBody | null;
  const shown = frozen ?? requestPayload(amount, reason);
  const amountCheck = checkAmount(amount, false);
  const reasonError = checkText(reason, "دلیل");
  useNavigationGuard(amount !== "" || reason !== "", "درخواست پاداشِ ثبت‌نشده دارید. صفحه را ترک کنید؟");

  const formId = useId(), listId = useId();
  async function create() {
    if (!shown) throw new Error("فرم معتبر نیست");
    const operation = recovery.prepare(shown);
    try {
      await api.post("/bonuses", operation.body, { idempotencyKey: operation.key });
      recovery.clear(operation.key);
    } catch (err) {
      if (err instanceof ApiError && [400, 409, 422].includes(err.status) && !["idempotency_in_flight", "idempotency_key_reused"].includes(err.code)) {
        recovery.clear(operation.key);
      }
      throw err;
    }
  }
  async function verify() {
    if (!recovery.pending) return false;
    const found = await api.get<{ status: "recorded" | "not_found" }>(`/bonuses/mine/by-key/${encodeURIComponent(recovery.pending.key)}`);
    return found.status === "recorded";
  }
  function finished(outcome: "done" | "verified") {
    recovery.clear(); setAmount(""); setReason("");
    setDone(outcome === "verified" ? "بررسی شد: درخواست پیش‌تر ثبت شده بود." : "درخواست پاداش ثبت شد و در انتظار بررسی مدیر است.");
    setPage("1"); setReload(v => v + 1);
  }

  const columns: Column<BonusItem>[] = [
    { key: "at", header: "زمان ثبت", cell: r => <span className="cell-nowrap">{formatJalaliMoment(r.createdAt)}</span> },
    { key: "origin", header: "منشأ", cell: r => ORIGIN_LABEL[r.origin] },
    { key: "amount", header: "مبلغ", numeric: true, cell: r => <Money rial={r.amount} exact size="sm" /> },
    { key: "reason", header: "دلیل", cell: r => r.reason },
    { key: "state", header: "وضعیت", cell: r => <BonusStatus status={r.status} /> },
  ];

  return <div className="settings-page">
    <PageHeader title="پاداش‌های من"
      context="درخواست پاداش خود را با مبلغ و دلیل ثبت کنید؛ مدیر مجاز تأیید یا رد می‌کند. پاداش‌هایی که مدیر مستقیم به شما داده هم همین‌جاست. این دفتر فقط ثبت است: هیچ اثری بر صندوق، حساب‌ها یا حقوق ندارد." />

    <Solid as="section" className="settings-section" aria-labelledby={formId}>
      <SectionHeader id={formId} title="درخواست پاداش تازه" description="زمان و نام شما را سرور ثبت می‌کند؛ پس از ثبت، مبلغ و دلیل تغییر نمی‌کنند." />
      <div className="settings-form">
        <Field label="مبلغ (تومان)" error={amountCheck.error}
          hint={amountCheck.rial ? <>ثبت می‌شود: <Money rial={amountCheck.rial} exact size="sm" /></> : "بدون اعشار؛ رقم فارسی یا لاتین."}>
          <AmountInput type="text" inputMode="numeric" autoComplete="off" value={frozen ? tomanDraft(frozen.amount) : amount} disabled={!!frozen}
            onChange={e => { setAmount(e.target.value); setDone(null); }} />
        </Field>
        <Field label="دلیل پاداش" error={reasonError} hint={`اجباری؛ حداکثر ${formatCount(REASON_MAX)} نویسه.`}>
          <textarea className="set-input" rows={3} maxLength={REASON_MAX} value={frozen?.reason ?? reason} disabled={!!frozen}
            onChange={e => { setReason(e.target.value); setDone(null); }} />
        </Field>
        {frozen ? <p className="settings-note" role="status">تا روشن‌شدن نتیجهٔ ثبت قبلی، فرم قفل است. شناسهٔ عملیات با بستن صفحه حفظ می‌شود.</p> : null}
        {recovery.error ? <p role="alert">{recovery.error}</p> : null}
        <div className="settings-actions">
          <SafeAction trigger="ثبت درخواست پاداش" triggerVariant="primary" disabled={!shown || !!recovery.error} initialUnknown={!!frozen}
            title="ثبت درخواست پاداش"
            summary={shown ? <dl className="settings-facts">
              <div><dt>مبلغ</dt><dd><Money rial={shown.amount} exact /></dd></div>
              <div><dt>دلیل</dt><dd>{shown.reason}</dd></div>
            </dl> : null}
            consequence="به نام شما و با زمان سرور ثبت می‌شود و تا بررسی مدیر «در انتظار» می‌ماند؛ ویرایش یا حذف ندارد. هیچ پولی جابه‌جا نمی‌شود."
            confirmLabel="ثبت درخواست" pendingLabel="در حال ثبت…"
            run={create} verify={verify} onDone={finished} />
        </div>
        {done ? <p className="set-msg set-msg--good" role="status">{done}</p> : null}
      </div>
    </Solid>

    <Solid as="section" className="settings-section" aria-labelledby={listId}>
      <SectionHeader id={listId} title="پاداش‌های من" description="تازه‌ترین بالا. مبالغ به تومان‌اند." />
      {list.loading ? <Skeleton variant="row" lines={4} label="در حال دریافت پاداش‌ها…" />
        : list.error ? <ResultState kind="error" title={list.error instanceof ApiError ? list.error.message : "دریافت پاداش‌ها ممکن نشد."}
            reference={list.error instanceof ApiError ? list.error.correlationId : null} actionLabel="تلاش دوباره" onAction={() => setReload(v => v + 1)} />
        : list.data ? <>
          <DataTable caption="پاداش‌های من" columns={columns} rows={list.data.items} rowKey={r => r.id} stack
            empty={page > 1 ? { title: "این صفحه خالی است." } : { title: "هنوز پاداشی ندارید.", description: "درخواست تازه را از فرم بالا ثبت کنید." }}
            rowActions={r => <button type="button" className="link" aria-pressed={selected === r.id}
              aria-label={`جزئیات پاداش ${formatJalaliMoment(r.createdAt)}`} onClick={() => setSelected(selected === r.id ? "" : r.id)}>جزئیات</button>} />
          <Pager page={page} total={list.data.total} label="صفحه‌بندی پاداش‌های من" onPage={p => setPage(String(p))} />
        </> : null}
    </Solid>

    {selected ? <MyBonusDetail id={selected} version={reload} onClose={() => setSelected("")} /> : null}
  </div>;
}

function MyBonusDetail({ id, version, onClose }: { id: string; version: number; onClose: () => void }) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const load = useCallback((signal: AbortSignal) => api.get<BonusDetail>(`/bonuses/mine/${encodeURIComponent(id)}`, { signal }), [id]);
  const q = useLatestQuery({ key: id, version, load });
  useEffect(() => { heading.current?.focus(); }, [id]);
  return <Solid as="section" className="settings-section" aria-labelledby={headingId}>
    <div className="section-header">
      <h2 className="section-title" id={headingId} ref={heading} tabIndex={-1}>جزئیات پاداش</h2>
      <div className="section-actions"><Button variant="quiet" onClick={onClose}>بستن جزئیات</Button></div>
    </div>
    {q.loading ? <Skeleton variant="row" lines={2} label="در حال دریافت جزئیات…" />
      : q.error ? <ResultState kind="error" title={q.error instanceof ApiError ? q.error.message : "دریافت جزئیات ممکن نشد."}
          reference={q.error instanceof ApiError ? q.error.correlationId : null} />
      : q.data ? <BonusTimeline item={q.data} /> : null}
  </Solid>;
}
