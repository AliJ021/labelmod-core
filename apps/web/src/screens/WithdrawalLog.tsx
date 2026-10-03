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
import type { Verdict } from "../lib/navigation.ts";
import { useLatestQuery } from "../lib/use-latest-query.ts";
import { useNavigationGuard, useUrlState } from "../lib/use-url-state.ts";
import {
  checkAmount, checkText, correctionLanded, correctionPayload, PAGE_SIZE, REASON_MAX, tomanDraft,
  type CorrectionPayload, type WithdrawalDetail, type WithdrawalItem, type WithdrawalPage,
} from "../lib/withdrawals.ts";

/**
 * دفتر برداشت پرسنل — بخش مدیریتی «کاربران و امنیت» (مهاجرت ۰۸۴).
 *
 * فقط با `withdrawal.view_all` دیده می‌شود (رجیستری تنظیمات) و فرم اصلاح فقط
 * با `withdrawal.correct` و `canCorrect` سرور. هر دو نمایش‌اند؛ دروازه سرور
 * و Trigger نسخه است: نشست کامل، دامنهٔ شعبه و شرط نسخه.
 *
 * ⚠️ اصلاح = نسخهٔ تازه با دلیل؛ نسخهٔ قبلی و حسابرسی‌اش می‌ماند. صفر مجاز است.
 * ⚠️ هیچ سند، برگشت یا حرکت صندوقی ساخته نمی‌شود — صفحه هم چنین ادعایی ندارد.
 * ⚠️ تعارض هم‌زمان (۴۰۹ `withdrawal_stale`): پیام سرور همان‌طور نشان داده و
 *    تاریخچه دوباره خوانده می‌شود؛ پیش‌نویس مدیر می‌ماند تا آگاهانه دوباره تأیید کند.
 */
export function WithdrawalLog({ currentUserId, write, writeState }: { currentUserId: string; write: Verdict; writeState: "loading" | "ready" | "degraded" }) {
  const [pageText, setPage] = useUrlState("settings.wdlPage", "1");
  const [selected, setSelected] = useUrlState("settings.wdl");
  const page = Math.max(1, Math.floor(Number(pageText)) || 1);
  const [reload, setReload] = useState(0);
  const loadList = useCallback((signal: AbortSignal) =>
    api.get<WithdrawalPage>(`/withdrawals?page=${page}&pageSize=${PAGE_SIZE}`, { signal }), [page]);
  const list = useLatestQuery({ key: String(page), version: reload, load: loadList });
  const listId = useId();

  const columns: Column<WithdrawalItem>[] = [
    { key: "owner", header: "کاربر", cell: r => r.owner.name },
    { key: "at", header: "زمان ثبت", cell: r => <span className="cell-nowrap">{formatJalaliMoment(r.createdAt)}</span> },
    { key: "amount", header: "مبلغ", numeric: true, cell: r => <Money rial={r.amount} exact size="sm" /> },
    { key: "reason", header: "دلیل", cell: r => r.reason },
    { key: "state", header: "وضعیت", cell: r => <>{<WithdrawalStatus item={r} />}{r.correctedBy ? <span className="cell-sub">آخرین اصلاح: {r.correctedBy}</span> : null}</> },
  ];
  const denied = list.error instanceof ApiError && list.error.status === 403;

  return <div className="settings-page">
    <PageHeader title="دفتر برداشت پرسنل"
      context="برداشت‌هایی که هر کاربر برای خودش ثبت کرده، در دامنهٔ شعبهٔ شما. این دفتر فقط ثبت است و هیچ اثری بر صندوق، حساب‌ها یا حقوق ندارد؛ اصلاح یک نسخهٔ تازه با دلیل است و نسخهٔ قبلی می‌ماند." />
    <Solid as="section" className="settings-section" aria-labelledby={listId}>
      <SectionHeader id={listId} title="همهٔ برداشت‌ها" description="تازه‌ترین بالا. مبالغ به تومان‌اند." />
      {list.loading ? <Skeleton variant="row" lines={5} label="در حال دریافت دفتر برداشت…" />
        : denied ? <ResultState kind="denied" title={(list.error as ApiError).message}
            description="دیدن دفتر همهٔ کاربران مجوز «withdrawal.view_all» و ورود کامل (نه PIN) می‌خواهد." />
        : list.error ? <ResultState kind="error" title={list.error instanceof ApiError ? list.error.message : "دریافت دفتر برداشت ممکن نشد."}
            reference={list.error instanceof ApiError ? list.error.correlationId : null} actionLabel="تلاش دوباره" onAction={() => setReload(v => v + 1)} />
        : list.data ? <>
          <DataTable caption="دفتر برداشت پرسنل" columns={columns} rows={list.data.items} rowKey={r => r.id} stack
            empty={page > 1 ? { title: "این صفحه خالی است." } : { title: "هنوز هیچ برداشتی ثبت نشده است." }}
            rowActions={r => <button type="button" className="link" aria-pressed={selected === r.id}
              aria-label={`تاریخچه و اصلاح برداشت ${r.owner.name}، ${formatJalaliMoment(r.createdAt)}`}
              onClick={() => setSelected(selected === r.id ? "" : r.id)}>تاریخچه و اصلاح</button>} />
          <Pager page={page} total={list.data.total} label="صفحه‌بندی دفتر برداشت" onPage={p => setPage(String(p))} />
        </> : null}
    </Solid>
    {selected ? <WithdrawalInspector key={selected} currentUserId={currentUserId} id={selected} write={write} writeState={writeState}
      onClose={() => setSelected("")} onCorrected={() => setReload(v => v + 1)} /> : null}
  </div>;
}

interface Draft { amount: string; reason: string; note: string }

function WithdrawalInspector({ currentUserId, id, write, writeState, onClose, onCorrected }: {
  currentUserId: string; id: string; write: Verdict; writeState: "loading" | "ready" | "degraded"; onClose: () => void; onCorrected: () => void;
}) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [version, setVersion] = useState(0);
  const load = useCallback((signal: AbortSignal) => api.get<WithdrawalDetail>(`/withdrawals/${encodeURIComponent(id)}`, { signal }), [id]);
  const q = useLatestQuery({ key: id, version, load });
  // آخرین پاسخ موفق در بازخوانی می‌ماند: پس از تعارض، پنجرهٔ عمل ایمن و پیام سرور
  // نباید با Skeleton از زیر دست مدیر کشیده شوند (تنظیم state هنگام رندر، نه اثر).
  const [kept, setKept] = useState<WithdrawalDetail | null>(null);
  if (q.data && q.data !== kept) setKept(q.data);
  const detail = q.data ?? kept;
  useEffect(() => { heading.current?.focus(); }, []);

  const [draft, setDraft] = useState<Draft | null>(null);
  const recovery = useWithdrawalOperation(currentUserId, id);
  const sent = recovery.pending?.body as CorrectionPayload | undefined;
  const [done, setDone] = useState<string | null>(null);
  const base: Draft | null = detail ? { amount: tomanDraft(detail.amount), reason: detail.reason, note: "" } : null;
  const form = sent ? { amount: tomanDraft(sent.amount), reason: sent.reason, note: sent.note } : draft ?? base;
  const dirty = draft !== null && base !== null && (draft.amount !== base.amount || draft.reason !== base.reason || draft.note !== "");
  useNavigationGuard(dirty, "اصلاحِ ثبت‌نشده دارید. صفحه را ترک کنید؟");
  const result = detail && form ? correctionPayload(detail, form) : null;
  const payload = sent ?? result?.payload ?? null;
  const edit = (patch: Partial<Draft>) => { if (form) setDraft({ ...form, ...patch }); setDone(null); };

  async function run() {
    if (!payload) throw new Error("فرم معتبر نیست");
    const operation = recovery.prepare(payload);
    try {
      await api.post(`/withdrawals/${encodeURIComponent(id)}/corrections`, operation.body, { idempotencyKey: operation.key });
      recovery.clear(operation.key);
    } catch (err) {
      if (err instanceof ApiError && [400, 409, 422].includes(err.status) && !["idempotency_in_flight", "idempotency_key_reused"].includes(err.code)) {
        recovery.clear(operation.key);
        // تعارض: دادهٔ تازه خوانده می‌شود؛ پیش‌نویس می‌ماند و شرط نسخه با آن به‌روز می‌شود.
        if (err.code === "withdrawal_stale") setVersion(v => v + 1);
      }
      throw err;
    }
  }
  async function verify() {
    if (!sent) return false;
    const fresh = await api.get<WithdrawalDetail>(`/withdrawals/${encodeURIComponent(id)}`);
    const landed = correctionLanded(fresh, sent) === "landed";
    // انجام‌نشده: تاریخچهٔ تازه دیده شود؛ اگر کسی دیگر اصلاح کرده، تأیید دوباره «قدیمی» می‌گیرد.
    if (!landed) setVersion(v => v + 1);
    return landed;
  }
  function finished(outcome: "done" | "verified") {
    recovery.clear(); setDraft(null);
    setDone(outcome === "verified" ? "بررسی شد: اصلاح پیش‌تر ثبت شده بود." : "اصلاح ثبت شد؛ نسخهٔ قبلی در تاریخچه می‌ماند.");
    setVersion(v => v + 1); onCorrected();
  }

  const amountCheck = form ? checkAmount(form.amount, true, true) : null;
  const canWrite = write === "allow" && detail?.canCorrect === true;
  return <Solid as="section" className="settings-section" aria-labelledby={headingId}>
    <div className="section-header">
      <div>
        <h2 className="section-title" id={headingId} ref={heading} tabIndex={-1}>
          {detail ? `برداشت ${detail.owner.name}` : "جزئیات برداشت"}
        </h2>
        {detail ? <p className="section-description">ثبت {formatJalaliMoment(detail.createdAt)} · مقدار فعلی <Money rial={detail.amount} exact size="sm" /></p> : null}
      </div>
      <div className="section-actions"><Button variant="quiet" onClick={onClose}>بستن</Button></div>
    </div>
    {!detail && q.loading ? <Skeleton variant="row" lines={3} label="در حال دریافت تاریخچه…" />
      : !detail && q.error ? <ResultState kind={q.error instanceof ApiError && q.error.status === 403 ? "denied" : "error"}
          title={q.error instanceof ApiError ? q.error.message : "دریافت تاریخچه ممکن نشد."}
          reference={q.error instanceof ApiError ? q.error.correlationId : null} actionLabel="تلاش دوباره" onAction={() => setVersion(v => v + 1)} />
      : detail && form ? <>
        <div><WithdrawalStatus item={detail} /></div>
        <WithdrawalHistory history={detail.history} caption={`تاریخچهٔ برداشت ${detail.owner.name}`} />
        <SectionHeader level={3} title="اصلاح مبلغ یا دلیل" description={`بر پایهٔ نسخهٔ ${formatCount(detail.version)}. اگر کسی پیش از شما اصلاح کند، این ثبت رد و تاریخچه تازه می‌شود.`} />
        {writeState === "loading" && write !== "allow" ? <p className="settings-note" role="status">در حال بررسی مجوز اصلاح…</p>
          : write !== "allow" ? <ResultState kind="denied" title="اصلاح برای شما باز نیست." description="اصلاح برداشت مجوز «withdrawal.correct» می‌خواهد." />
          : !detail.canCorrect ? <ResultState kind="denied" title="این برداشت را نمی‌توانید اصلاح کنید."
              description="مجوز جاری اصلاح این برداشت را بررسی کنید." />
          : <div className="settings-form">
            <Field label="مبلغ درست (تومان)" error={amountCheck?.error ?? null}
              hint={amountCheck?.rial !== null && amountCheck?.rial !== undefined ? <>ثبت می‌شود: <Money rial={amountCheck.rial} exact size="sm" /> · صفر مجاز است؛ دقت تا یک ریال.</> : "صفر مجاز است؛ حداکثر یک رقم اعشار تومان."}>
              <input type="text" inputMode="decimal" autoComplete="off" value={form.amount} disabled={!!sent}
                onChange={e => edit({ amount: e.target.value })} />
            </Field>
            <Field label="دلیل برداشت" error={checkText(form.reason, "دلیل")} hint={form.reason.trim() === "" ? "دلیل نمی‌تواند خالی باشد." : undefined}>
              <textarea className="set-input" rows={2} maxLength={REASON_MAX} value={form.reason} disabled={!!sent}
                onChange={e => edit({ reason: e.target.value })} />
            </Field>
            <Field label="دلیل اصلاح" error={checkText(form.note, "دلیل اصلاح")} hint="در تاریخچه و حسابرسی کنار نام شما می‌نشیند.">
              <textarea className="set-input" rows={2} maxLength={REASON_MAX} value={form.note} disabled={!!sent}
                onChange={e => edit({ note: e.target.value })} />
            </Field>
            {result?.blocker ? <p className="settings-note" role="status">{result.blocker}</p> : null}
            {sent ? <p className="settings-note" role="status">تا روشن‌شدن نتیجهٔ اصلاح قبلی، فرم قفل است. شناسهٔ عملیات با بستن صفحه حفظ می‌شود.</p> : null}
            {recovery.error ? <p role="alert">{recovery.error}</p> : null}
            <div className="settings-actions">
              <SafeAction trigger="ثبت اصلاح" triggerVariant="primary" disabled={!canWrite || !payload || !!recovery.error} initialUnknown={!!sent}
                title={`اصلاح برداشت ${detail.owner.name}`}
                summary={payload ? <dl className="settings-facts">
                  <div><dt>مبلغ فعلی</dt><dd><Money rial={detail.amount} exact /></dd></div>
                  <div><dt>مبلغ اصلاح‌شده</dt><dd><Money rial={payload.amount} exact /></dd></div>
                  <div><dt>دلیل</dt><dd>{payload.reason}</dd></div>
                  <div><dt>دلیل اصلاح</dt><dd>{payload.note}</dd></div>
                </dl> : null}
                consequence="نسخهٔ تازه با نام شما و زمان سرور ثبت می‌شود؛ نسخهٔ قبلی و ردّ حسابرسی‌اش پاک نمی‌شود. هیچ سند یا جابه‌جایی پولی ساخته نمی‌شود."
                confirmLabel="ثبت اصلاح" pendingLabel="در حال ثبت اصلاح…"
                run={run} verify={verify} onDone={finished} />
              {dirty && !sent ? <Button variant="quiet" onClick={() => { setDraft(null); setDone(null); }}>بازگردانی به مقدار فعلی</Button> : null}
            </div>
            {done ? <p className="set-msg set-msg--good" role="status">{done}</p> : null}
          </div>}
      </> : null}
  </Solid>;
}
