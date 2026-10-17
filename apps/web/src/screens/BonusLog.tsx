import { AmountInput } from "../components/ui/AmountInput.tsx";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { ResultState } from "../components/ResultState.tsx";
import { BonusStatus, BonusTimeline } from "../components/BonusParts.tsx";
import { Pager } from "../components/WithdrawalHistory.tsx";
import { Button, Field, Segmented } from "../components/ui/Controls.tsx";
import { DataTable, type Column } from "../components/ui/DataTable.tsx";
import { Money } from "../components/ui/Money.tsx";
import { PageHeader, SectionHeader } from "../components/ui/PageHeader.tsx";
import { SafeAction } from "../components/ui/SafeAction.tsx";
import { Skeleton } from "../components/ui/Skeleton.tsx";
import { useBonusOperation } from "../lib/use-withdrawal-operation.ts";
import { api, ApiError } from "../lib/api.ts";
import {
  awardPayload, decisionPayload, ORIGIN_LABEL, selectable, STATUS_LABEL,
  type AwardBody, type BonusDetail, type BonusItem, type BonusPage, type BonusSettlementBody, type DecisionBody,
} from "../lib/bonuses.ts";
import { formatCount, formatJalaliMoment } from "../lib/format.ts";
import type { Verdict } from "../lib/navigation.ts";
import { useLatestQuery } from "../lib/use-latest-query.ts";
import { useNavigationGuard, useUrlState } from "../lib/use-url-state.ts";
import { checkAmount, checkText, PAGE_SIZE, REASON_MAX, tomanDraft } from "../lib/withdrawals.ts";

/**
 * دفتر پاداش پرسنل — بخش مدیریتی «برداشت و پاداش» (مهاجرت ۰۹۸).
 *
 * فقط با `bonus.view_all` دیده می‌شود؛ تأیید/رد، اعطای مستقیم و تسویهٔ گروهی
 * فقط با `bonus.manage`. هر دو نمایش‌اند؛ دروازه سرور و Trigger است: نشست
 * کامل، دامنهٔ شعبه، منع بررسی/اعطا/تسویهٔ خود، وضعیت.
 *
 * ⚠️ هیچ سند، پرداخت یا حرکت صندوقی ساخته نمی‌شود — صفحه هم چنین ادعایی ندارد.
 * ⚠️ تعارض (۴۰۹ `bonus_stale`): پیام سرور نشان داده و فهرست تازه می‌شود.
 * ⚠️ نتیجهٔ نامعلوم «ارسال دوباره» ندارد؛ فقط با همان شناسهٔ عملیات بررسی می‌شود.
 * ⚠️ ۴۰۳ هنگام ارسال (مجوز گرفته شد) قطعی است: سرور مجوز را **پیش از** Inbox و اثر
 *    می‌سنجد، پس عملیات ذخیره‌شده آزاد می‌شود و فرم قفل نمی‌ماند.
 */
export function BonusLog({ currentUserId, write, writeState }: { currentUserId: string; write: Verdict; writeState: "loading" | "ready" | "degraded" }) {
  const [pageText, setPage] = useUrlState("personnel.bnlPage", "1");
  const [selected, setSelected] = useUrlState("personnel.bnl");
  const [ownerId, setOwnerId] = useUrlState("personnel.bnlOwner", "");
  const [filter, setFilter] = useUrlState("personnel.bnlStatus", "all");
  const page = Math.max(1, Math.floor(Number(pageText)) || 1);
  const [reload, setReload] = useState(0);
  const filterQuery = `${ownerId ? `ownerId=${encodeURIComponent(ownerId)}&` : ""}status=${encodeURIComponent(filter)}`;
  const loadList = useCallback((signal: AbortSignal) =>
    api.get<BonusPage>(`/bonuses?page=${page}&pageSize=${PAGE_SIZE}&${filterQuery}`, { signal }), [page, filterQuery]);
  const list = useLatestQuery({ key: `${page}:${filterQuery}`, version: reload, load: loadList });
  const loadOwners = useCallback((signal: AbortSignal) => api.get<{ owners: Array<{ id: string; name: string }> }>("/bonuses/owners", { signal }), []);
  const owners = useLatestQuery({ key: "owners", version: reload, load: loadOwners });

  const recovery = useBonusOperation(currentUserId, "settle");
  const sent = recovery.pending?.body as BonusSettlementBody | undefined;
  const [chosen, setChosen] = useState<BonusItem[]>([]);
  const [note, setNote] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [bulkError, setBulkError] = useState("");
  const [bulkDone, setBulkDone] = useState("");
  const canWrite = write === "allow";
  const locked = !!sent || selecting || !!recovery.error;
  const payload: BonusSettlementBody | null = sent ?? (chosen.length && note.trim() && !checkText(note, "یادداشت تسویه")
    ? { items: chosen.map(r => ({ id: r.id, amount: r.amount, ownerName: r.owner.name })), note: note.trim() } : null);
  const total = (sent?.items ?? chosen).reduce((sum, r) => sum + BigInt(r.amount), 0n).toString();
  const clearChoice = () => { setChosen([]); setBulkError(""); setBulkDone(""); };
  async function selectAll() {
    setSelecting(true); setBulkError("");
    try { const found = await api.get<{ items: BonusItem[] }>(`/bonuses/selection?${filterQuery}`); setChosen(found.items); }
    catch (err) { setBulkError(err instanceof ApiError ? err.message : "انتخاب همه ممکن نشد؛ دوباره تلاش کنید."); }
    finally { setSelecting(false); }
  }
  async function settle() {
    if (!payload) throw new Error("انتخاب یا یادداشت تسویه کامل نیست.");
    const op = recovery.prepare(payload);
    const body = op.body as BonusSettlementBody;
    try {
      await api.post("/bonuses/settlements", { items: body.items.map(i => i.id), note: body.note }, { idempotencyKey: op.key });
      recovery.clear(op.key);
    } catch (err) {
      if (err instanceof ApiError && [400, 403, 404, 409, 422].includes(err.status) && !["idempotency_in_flight", "idempotency_key_reused"].includes(err.code)) {
        recovery.clear(op.key); clearChoice(); setReload(v => v + 1);
      }
      throw err;
    }
  }
  async function verifySettlement() {
    if (!recovery.pending) return false;
    const result = await api.get<{ status: string }>(`/bonuses/settlements/by-key/${encodeURIComponent(recovery.pending.key)}`);
    return result.status === "recorded";
  }
  function settlementFinished() {
    recovery.clear(); setChosen([]); setNote(""); setReload(v => v + 1);
    setBulkDone("انتخاب‌ها تسویه شدند؛ زمان و نام مدیر برای هر پاداش ثبت شد. هیچ پولی جابه‌جا نشد.");
  }
  const listId = useId();

  const columns: Column<BonusItem>[] = [
    ...(canWrite ? [{ key: "select", header: "انتخاب", cell: (r: BonusItem) => <input type="checkbox"
      aria-label={`انتخاب پاداش ${r.owner.name}، ${r.reason}`} checked={sent ? sent.items.some(i => i.id === r.id) : chosen.some(i => i.id === r.id)}
      disabled={locked || !selectable(r, currentUserId) || (chosen.length >= 500 && !chosen.some(i => i.id === r.id))}
      onChange={e => { setBulkDone(""); setChosen(current => e.target.checked ? [...current, r] : current.filter(i => i.id !== r.id)); }} /> }] : []),
    { key: "owner", header: "کارمند", cell: r => r.owner.name },
    { key: "at", header: "زمان ثبت", cell: r => <span className="cell-nowrap">{formatJalaliMoment(r.createdAt)}</span> },
    { key: "origin", header: "منشأ", cell: r => <>{ORIGIN_LABEL[r.origin]}{r.origin === "award" ? <span className="cell-sub">{r.createdBy}</span> : null}</> },
    { key: "amount", header: "مبلغ", numeric: true, cell: r => <Money rial={r.amount} exact size="sm" /> },
    { key: "reason", header: "دلیل", cell: r => r.reason },
    { key: "state", header: "وضعیت", cell: r => <BonusStatus status={r.status} /> },
  ];
  const denied = list.error instanceof ApiError && list.error.status === 403;

  return <div className="settings-page">
    <PageHeader title="دفتر پاداش پرسنل"
      context="درخواست‌های پاداش کارمندان و پاداش‌های اعطایی مدیر، در دامنهٔ شعبهٔ شما. این دفتر فقط ثبت است و هیچ اثری بر صندوق، حساب‌ها یا حقوق ندارد؛ «تسویه» فقط وضعیت دفتر است." />

    {canWrite ? <AwardForm currentUserId={currentUserId} onAwarded={() => setReload(v => v + 1)} /> : null}

    <Solid as="section" className="settings-section" aria-labelledby={listId}>
      <SectionHeader id={listId} title="همهٔ پاداش‌ها" description="تازه‌ترین بالا. مبالغ به تومان‌اند. فقط پاداش تأییدشده تسویه می‌شود و هیچ‌کس پاداش خودش را بررسی یا تسویه نمی‌کند." />
      <div className="settings-form">
        <Field label="کارمند"><select value={ownerId} disabled={locked} onChange={e => { setOwnerId(e.target.value); setPage("1"); clearChoice(); }}>
          <option value="">همهٔ کارمندان در دامنهٔ من</option>{owners.data?.owners.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select></Field>
        <Field label="وضعیت پاداش"><select value={filter} disabled={locked} onChange={e => { setFilter(e.target.value); setPage("1"); clearChoice(); }}>
          <option value="all">همه</option>{(["pending", "approved", "rejected", "settled"] as const).map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select></Field>
        {canWrite ? <>
          <div className="settings-actions">
            <Button disabled={locked || !list.data?.items.some(r => selectable(r, currentUserId))}
              onClick={() => { setChosen(list.data!.items.filter(r => selectable(r, currentUserId))); setBulkDone(""); }}>انتخاب تأییدشده‌های این صفحه</Button>
            <Button disabled={locked || !["all", "approved"].includes(filter) || list.loading || !list.data?.items.length}
              onClick={() => void selectAll()}>انتخاب همهٔ تأییدشده‌های این فیلتر</Button>
            <Button disabled={locked || !chosen.length} onClick={clearChoice}>لغو انتخاب</Button>
          </div>
          <p role="status">{formatCount(sent?.items.length ?? chosen.length)} پاداش انتخاب شده · جمع <Money rial={total} exact size="sm" />. انتخاب همه شامل صفحه‌های دیگر همین فیلتر است و پاداش خود شما را ندارد؛ حداکثر ۵۰۰.</p>
          <Field label="یادداشت تسویه" error={checkText(sent?.note ?? note, "یادداشت تسویه")} hint="همراه نام مدیر و زمان سرور برای هر پاداش حفظ می‌شود.">
            <textarea rows={2} maxLength={REASON_MAX} value={sent?.note ?? note} disabled={locked} onChange={e => setNote(e.target.value)} />
          </Field>
          {sent ? <p role="status">نتیجهٔ تسویهٔ قبلی هنوز روشن نیست؛ انتخاب قفل است. ابتدا نتیجه را بررسی کنید.</p> : null}
          {bulkError || recovery.error ? <p role="alert">{bulkError || recovery.error}</p> : null}
          <SafeAction trigger="تسویهٔ پاداش‌های انتخاب‌شده" title="تأیید تسویهٔ پاداش‌های انتخاب‌شده" triggerVariant="primary"
            disabled={!payload || !!recovery.error || selecting} initialUnknown={!!sent}
            summary={payload ? <><p>{formatCount(payload.items.length)} پاداش · جمع <Money rial={total} exact /></p>
              <p>کارمندان: {[...new Set(payload.items.map(i => i.ownerName))].join("، ")}</p><p>یادداشت: {payload.note}</p></> : null}
            consequence="همه یا هیچ: اگر یکی از انتخاب‌ها در این فاصله تغییر کرده یا تسویه شده باشد، هیچ‌کدام تسویه نمی‌شود. مبلغ و سابقه پاک نمی‌شود و هیچ اثر مالی ندارد."
            confirmLabel="تأیید و ثبت تسویه" pendingLabel="در حال ثبت تسویه…" run={settle} verify={verifySettlement} onDone={settlementFinished} />
          {bulkDone ? <p role="status">{bulkDone}</p> : null}
        </> : null}
      </div>
      {list.loading ? <Skeleton variant="row" lines={5} label="در حال دریافت دفتر پاداش…" />
        : denied ? <ResultState kind="denied" title={(list.error as ApiError).message}
            description="دیدن دفتر پاداش مجوز «bonus.view_all» و ورود کامل (نه PIN) می‌خواهد." />
        : list.error ? <ResultState kind="error" title={list.error instanceof ApiError ? list.error.message : "دریافت دفتر پاداش ممکن نشد."}
            reference={list.error instanceof ApiError ? list.error.correlationId : null} actionLabel="تلاش دوباره" onAction={() => setReload(v => v + 1)} />
        : list.data ? <>
          <DataTable caption="دفتر پاداش پرسنل" columns={columns} rows={list.data.items} rowKey={r => r.id} stack
            empty={page > 1 ? { title: "این صفحه خالی است." } : { title: "هنوز پاداشی ثبت نشده است." }}
            rowActions={r => <button type="button" className="link" aria-pressed={selected === r.id}
              aria-label={`جزئیات و بررسی پاداش ${r.owner.name}، ${formatJalaliMoment(r.createdAt)}`}
              onClick={() => setSelected(selected === r.id ? "" : r.id)}>جزئیات و بررسی</button>} />
          <Pager page={page} total={list.data.total} label="صفحه‌بندی دفتر پاداش" onPage={p => setPage(String(p))} />
        </> : null}
    </Solid>
    {selected ? <BonusInspector key={selected} currentUserId={currentUserId} id={selected} write={write} writeState={writeState}
      onClose={() => setSelected("")} onDecided={() => setReload(v => v + 1)} /> : null}
  </div>;
}

/** اعطای مستقیم: کارمند فعال در دامنه (از سرور)، مبلغ و دلیل اجباری؛ از ابتدا تأییدشده. */
function AwardForm({ currentUserId, onAwarded }: { currentUserId: string; onAwarded: () => void }) {
  const formId = useId();
  const load = useCallback((signal: AbortSignal) => api.get<{ beneficiaries: Array<{ id: string; name: string }> }>("/bonuses/beneficiaries", { signal }), []);
  const people = useLatestQuery({ key: "beneficiaries", load });
  const [ownerId, setOwnerId] = useState(""), [amount, setAmount] = useState(""), [reason, setReason] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const recovery = useBonusOperation(currentUserId, "award");
  const frozen = (recovery.pending?.body ?? null) as AwardBody | null;
  const owner = people.data?.beneficiaries.find(p => p.id === ownerId) ?? null;
  const shown = frozen ?? awardPayload(owner, amount, reason);
  const amountCheck = checkAmount(amount, false);
  useNavigationGuard(ownerId !== "" || amount !== "" || reason !== "", "اعطای پاداشِ ثبت‌نشده دارید. صفحه را ترک کنید؟");

  async function run() {
    if (!shown) throw new Error("فرم معتبر نیست");
    const op = recovery.prepare(shown);
    const body = op.body as AwardBody;
    try {
      await api.post("/bonuses/awards", { ownerId: body.ownerId, amount: body.amount, reason: body.reason }, { idempotencyKey: op.key });
      recovery.clear(op.key);
    } catch (err) {
      if (err instanceof ApiError && [400, 403, 404, 409, 422].includes(err.status) && !["idempotency_in_flight", "idempotency_key_reused"].includes(err.code)) {
        recovery.clear(op.key);
      }
      throw err;
    }
  }
  async function verify() {
    if (!recovery.pending) return false;
    const found = await api.get<{ status: string }>(`/bonuses/awards/by-key/${encodeURIComponent(recovery.pending.key)}`);
    return found.status === "recorded";
  }
  function finished(outcome: "done" | "verified") {
    recovery.clear(); setOwnerId(""); setAmount(""); setReason("");
    setDone(outcome === "verified" ? "بررسی شد: پاداش پیش‌تر اعطا شده بود." : "پاداش اعطا شد و تأییدشده است.");
    onAwarded();
  }

  return <Solid as="section" className="settings-section" aria-labelledby={formId}>
    <SectionHeader id={formId} title="اعطای مستقیم پاداش" description="فقط کارمند فعال در دامنهٔ شما؛ به خودتان نمی‌توانید پاداش بدهید." />
    <div className="settings-form">
      <Field label="کارمند ذی‌نفع">
        <select value={frozen?.ownerId ?? ownerId} disabled={!!frozen || !people.data} onChange={e => { setOwnerId(e.target.value); setDone(null); }}>
          <option value="">{people.loading ? "در حال دریافت…" : "انتخاب کارمند"}</option>
          {frozen && !people.data?.beneficiaries.some(p => p.id === frozen.ownerId) ? <option value={frozen.ownerId}>{frozen.ownerName}</option> : null}
          {people.data?.beneficiaries.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Field>
      {people.error ? <p role="alert">{people.error instanceof ApiError ? people.error.message : "فهرست کارمندان دریافت نشد."}</p> : null}
      <Field label="مبلغ پاداش (تومان)" error={amountCheck.error}
        hint={amountCheck.rial ? <>ثبت می‌شود: <Money rial={amountCheck.rial} exact size="sm" /></> : "بدون اعشار؛ رقم فارسی یا لاتین."}>
        <AmountInput type="text" inputMode="numeric" autoComplete="off" value={frozen ? tomanDraft(frozen.amount) : amount} disabled={!!frozen}
          onChange={e => { setAmount(e.target.value); setDone(null); }} />
      </Field>
      <Field label="دلیل اعطا" error={checkText(frozen?.reason ?? reason, "دلیل")} hint={`اجباری؛ حداکثر ${formatCount(REASON_MAX)} نویسه.`}>
        <textarea className="set-input" rows={2} maxLength={REASON_MAX} value={frozen?.reason ?? reason} disabled={!!frozen}
          onChange={e => { setReason(e.target.value); setDone(null); }} />
      </Field>
      {frozen ? <p className="settings-note" role="status">تا روشن‌شدن نتیجهٔ اعطای قبلی، فرم قفل است.</p> : null}
      {recovery.error ? <p role="alert">{recovery.error}</p> : null}
      <div className="settings-actions">
        <SafeAction trigger="اعطای پاداش" triggerVariant="primary" disabled={!shown || !!recovery.error} initialUnknown={!!frozen}
          title="تأیید اعطای پاداش"
          summary={shown ? <dl className="settings-facts">
            <div><dt>کارمند</dt><dd>{shown.ownerName}</dd></div>
            <div><dt>مبلغ</dt><dd><Money rial={shown.amount} exact /></dd></div>
            <div><dt>دلیل</dt><dd>{shown.reason}</dd></div>
          </dl> : null}
          consequence="با نام شما و زمان سرور، از ابتدا «تأییدشده» ثبت می‌شود؛ ویرایش یا حذف ندارد. هیچ پولی جابه‌جا نمی‌شود."
          confirmLabel="ثبت اعطا" pendingLabel="در حال ثبت…" run={run} verify={verify} onDone={finished} />
      </div>
      {done ? <p className="set-msg set-msg--good" role="status">{done}</p> : null}
    </div>
  </Solid>;
}

function BonusInspector({ currentUserId, id, write, writeState, onClose, onDecided }: {
  currentUserId: string; id: string; write: Verdict; writeState: "loading" | "ready" | "degraded"; onClose: () => void; onDecided: () => void;
}) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [version, setVersion] = useState(0);
  const load = useCallback((signal: AbortSignal) => api.get<BonusDetail>(`/bonuses/${encodeURIComponent(id)}`, { signal }), [id]);
  const q = useLatestQuery({ key: id, version, load });
  const [kept, setKept] = useState<BonusDetail | null>(null);
  if (q.data && q.data !== kept) setKept(q.data);
  const detail = q.data ?? kept;
  useEffect(() => { heading.current?.focus(); }, []);

  const recovery = useBonusOperation(currentUserId, `decide.${id}`);
  const sent = recovery.pending?.body as DecisionBody | undefined;
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");
  const [note, setNote] = useState("");
  const [done, setDone] = useState<string | null>(null);
  useNavigationGuard(note !== "", "یادداشت بررسیِ ثبت‌نشده دارید. صفحه را ترک کنید؟");
  const payload = sent ?? decisionPayload(decision, note);

  async function run() {
    if (!payload) throw new Error("فرم معتبر نیست");
    const op = recovery.prepare(payload);
    try {
      await api.post(`/bonuses/${encodeURIComponent(id)}/decisions`, op.body, { idempotencyKey: op.key });
      recovery.clear(op.key);
    } catch (err) {
      if (err instanceof ApiError && [400, 403, 404, 409, 422].includes(err.status) && !["idempotency_in_flight", "idempotency_key_reused"].includes(err.code)) {
        recovery.clear(op.key);
        if (err.code === "bonus_stale") setVersion(v => v + 1);
      }
      throw err;
    }
  }
  async function verify() {
    if (!recovery.pending) return false;
    const found = await api.get<{ status: string }>(`/bonuses/decisions/by-key/${encodeURIComponent(recovery.pending.key)}`);
    if (found.status !== "recorded") setVersion(v => v + 1);
    return found.status === "recorded";
  }
  function finished(outcome: "done" | "verified") {
    const was = (sent ?? payload)?.decision;
    recovery.clear(); setNote("");
    setDone(outcome === "verified" ? "بررسی شد: تصمیم پیش‌تر ثبت شده بود." : was === "rejected" ? "درخواست رد شد." : "درخواست تأیید شد.");
    setVersion(v => v + 1); onDecided();
  }

  const shownDecision = sent?.decision ?? decision;
  return <Solid as="section" className="settings-section" aria-labelledby={headingId}>
    <div className="section-header">
      <h2 className="section-title" id={headingId} ref={heading} tabIndex={-1}>{detail ? `پاداش ${detail.owner.name}` : "جزئیات پاداش"}</h2>
      <div className="section-actions"><Button variant="quiet" onClick={onClose}>بستن</Button></div>
    </div>
    {!detail && q.loading ? <Skeleton variant="row" lines={3} label="در حال دریافت جزئیات…" />
      : !detail && q.error ? <ResultState kind={q.error instanceof ApiError && q.error.status === 403 ? "denied" : "error"}
          title={q.error instanceof ApiError ? q.error.message : "دریافت جزئیات ممکن نشد."}
          reference={q.error instanceof ApiError ? q.error.correlationId : null} actionLabel="تلاش دوباره" onAction={() => setVersion(v => v + 1)} />
      : detail ? <>
        <BonusTimeline item={detail} />
        {detail.origin === "request" && (detail.status === "pending" || sent) ? <>
          <SectionHeader level={3} title="بررسی درخواست" description="تأیید یا رد یک بار ثبت می‌شود؛ اگر مدیر دیگری پیش از شما بررسی کند، این ثبت رد و جزئیات تازه می‌شود." />
          {writeState === "loading" && write !== "allow" ? <p className="settings-note" role="status">در حال بررسی مجوز…</p>
            : write !== "allow" ? <ResultState kind="denied" title="بررسی برای شما باز نیست." description="بررسی پاداش مجوز «bonus.manage» می‌خواهد." />
            : !detail.canManage && !sent ? <ResultState kind="denied" title="این درخواست را نمی‌توانید بررسی کنید."
                description={detail.owner.id === currentUserId ? "درخواست پاداش خودتان را مدیر دیگری بررسی می‌کند." : "مجوز جاری را بررسی کنید."} />
            : <div className="settings-form">
              {sent ? <p className="settings-note">تصمیم فرستاده‌شده: {sent.decision === "rejected" ? "رد" : "تأیید"}</p>
                : <Segmented label="تصمیم" value={decision} onChange={setDecision}
                    options={[{ key: "approved", label: "تأیید" }, { key: "rejected", label: "رد" }] as const} />}
              <Field label={shownDecision === "rejected" ? "دلیل رد" : "یادداشت تأیید (اختیاری)"} error={checkText(sent?.note ?? note, "یادداشت")}
                hint={shownDecision === "rejected" ? "اجباری؛ کارمند آن را می‌بیند." : "کنار نام شما در سابقه می‌نشیند."}>
                <textarea className="set-input" rows={2} maxLength={REASON_MAX} value={sent?.note ?? note} disabled={!!sent} onChange={e => { setNote(e.target.value); setDone(null); }} />
              </Field>
              {sent ? <p className="settings-note" role="status">تا روشن‌شدن نتیجهٔ تصمیم قبلی، فرم قفل است.</p> : null}
              {recovery.error ? <p role="alert">{recovery.error}</p> : null}
              <div className="settings-actions">
                <SafeAction trigger={shownDecision === "rejected" ? "ثبت رد" : "ثبت تأیید"} triggerVariant="primary"
                  tone={shownDecision === "rejected" ? "destructive" : "final"}
                  disabled={!payload || !!recovery.error} initialUnknown={!!sent}
                  title={`${shownDecision === "rejected" ? "رد" : "تأیید"} پاداش ${detail.owner.name}`}
                  summary={<dl className="settings-facts">
                    <div><dt>مبلغ</dt><dd><Money rial={detail.amount} exact /></dd></div>
                    <div><dt>دلیل درخواست</dt><dd>{detail.reason}</dd></div>
                    {payload?.note ? <div><dt>{shownDecision === "rejected" ? "دلیل رد" : "یادداشت"}</dt><dd>{payload.note}</dd></div> : null}
                  </dl>}
                  consequence={shownDecision === "rejected"
                    ? "درخواست برای همیشه «ردشده» می‌ماند و تسویه نمی‌شود؛ کارمند می‌تواند درخواست تازه ثبت کند. هیچ اثر مالی ندارد."
                    : "درخواست «تأییدشده» می‌شود و سپس با تسویهٔ گروهی بسته می‌شود. هیچ پولی جابه‌جا نمی‌شود."}
                  confirmLabel={shownDecision === "rejected" ? "رد درخواست" : "تأیید درخواست"} pendingLabel="در حال ثبت…"
                  run={run} verify={verify} onDone={finished} />
              </div>
            </div>}
        </> : null}
        {done ? <p className="set-msg set-msg--good" role="status">{done}</p> : null}
      </> : null}
  </Solid>;
}
