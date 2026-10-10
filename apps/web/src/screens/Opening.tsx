import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { api, ApiError } from "../lib/api.ts";
import { admin, OPENING_LEGS, type Tafsili } from "../lib/admin.ts";
import { rialFromTomanInput } from "../lib/money.ts";
import { normalizeDigits } from "../lib/settings-value.ts";
import { pos, type Branch } from "../lib/pos.ts";
import { session } from "../lib/session.ts";
import { useLatestQuery } from "../lib/use-latest-query.ts";
import { useNavigationGuard } from "../lib/use-url-state.ts";
import { PageHeader, SectionHeader } from "../components/ui/PageHeader.tsx";
import { Button, Field } from "../components/ui/Controls.tsx";
import { Dialog } from "../components/ui/Dialog.tsx";
import { Money } from "../components/ui/Money.tsx";
import { Ltr } from "../components/ui/Bidi.tsx";
import { StatusBadge } from "../components/ui/Status.tsx";
import { ResultState } from "../components/ResultState.tsx";
import "../styles/opening.css";

const PARTY_LABEL: Record<string, string> = {customer: "مشتری", supplier: "تأمین‌کننده", user: "کاربر"};
const markerPrefix = "labelmod.opening.";
type Marker = "uncertain" | "unavailable" | null;
function readMarker(key: string | null): Marker {
  if (!key) return null;
  try {
    const value = sessionStorage.getItem(key);
    return value === null ? null : "uncertain";
  } catch { return "unavailable"; }
}
function message(error: unknown) {
  return error instanceof ApiError ? error.message : "ارتباط با سرور برقرار نشد.";
}

export function Opening() {
  const [version, refresh] = useState(0);
  const load = useCallback(async (signal: AbortSignal) => {
    const [tafsili, branches, canEdit] = await Promise.all([
      api.get<{rows: Tafsili[]}>("/tafsili", {signal}), pos.branches({signal}),
      session.can("settings.security", {signal}).then(result => result.verdict === "allow").catch(() => false),
    ]);
    return {rows: tafsili.rows, branches: branches.branches, canEdit};
  }, []);
  const query = useLatestQuery({key: "opening", version, load});
  const [data, setData] = useState<{rows: Tafsili[]; branches: Branch[]; canEdit: boolean} | null>(null);
  const [branchId, setBranchId] = useState("");
  const [year, setYear] = useState("1405");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [entryId, setEntryId] = useState<string | null>(null);
  const [, refreshMarker] = useState(0);
  const [completeKey, setCompleteKey] = useState<string | null>(null);
  const [storageFailed, setStorageFailed] = useState(false);

  useEffect(() => {
    if (!query.data) return;
    setData(query.data);
    if (query.data.branches.length === 1) setBranchId(current => current || query.data!.branches[0]!.id);
  }, [query.data]);

  const normalizedYear = normalizeDigits(year.trim());
  const validYear = /^\d{4}$/.test(normalizedYear) && Number(normalizedYear) >= 1300 && Number(normalizedYear) <= 1500;
  const markerKey = branchId && validYear ? `${markerPrefix}${branchId}.${normalizedYear}` : null;
  const storedMarker = readMarker(markerKey);
  const marker = markerKey && markerKey === completeKey ? "complete" : storedMarker;
  const dirty = Object.values(amounts).some(value => value.trim() !== "");
  useNavigationGuard(dirty || busy, "مانده‌های افتتاحیه هنوز تعیین تکلیف نشده‌اند. از این صفحه خارج می‌شوید؟");

  const totals = useMemo(() => {
    let debit = 0n, credit = 0n;
    const invalid: Record<string, string> = {};
    const legs: {leg: string; amount: string}[] = [];
    for (const leg of OPENING_LEGS) {
      const raw = amounts[leg.leg]?.trim() ?? "";
      if (!raw) continue;
      const rial = rialFromTomanInput(raw);
      if (rial === null || rial < 0n) {
        invalid[leg.leg] = "مبلغ باید عدد صحیحِ نامنفی به تومان باشد.";
        continue;
      }
      if (rial === 0n) continue;
      legs.push({leg: leg.leg, amount: rial.toString()});
      if (leg.side === "debit") debit += rial; else credit += rial;
    }
    return {debit, credit, difference: debit - credit, invalid, legs};
  }, [amounts]);
  const hasInvalid = Object.keys(totals.invalid).length > 0;
  const ready = data?.branches.some(branch => branch.id === branchId) && validYear && !hasInvalid && totals.debit > 0n && totals.difference === 0n;
  const blocked = busy || !data?.canEdit || query.loading || !!query.error || marker !== null || storageFailed;
  const byParent = useMemo(() => {
    const groups = new Map<string, {name: string; items: Tafsili[]}>();
    for (const row of data?.rows ?? []) {
      const group = groups.get(row.parentCode);
      if (group) group.items.push(row); else groups.set(row.parentCode, {name: row.parentName, items: [row]});
    }
    return groups;
  }, [data]);

  async function submit() {
    if (working.current || blocked || !ready || !confirm || !markerKey) return;
    // قفل پیش از ارسال نگه داشته می‌شود؛ خواندن تفصیلی، وضعیت سند افتتاحیه را اثبات نمی‌کند.
    if (readMarker(markerKey) !== null) {refreshMarker(v => v + 1);return;}
    working.current = true;
    setBusy(true);setError(null);
    try {
      try { sessionStorage.setItem(markerKey, "uncertain"); }
      catch {setStorageFailed(true);setError("نگهداری قفل ارسال در این مرورگر ممکن نیست؛ هیچ درخواستی ارسال نشد.");return;}
      refreshMarker(v => v + 1);
      const out = await admin.postOpening({branchId, fiscalYear: Number(normalizedYear), legs: totals.legs});
      if (typeof out.entryId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(out.entryId)) {
        throw new Error("پاسخ ثبت سند قابل تأیید نیست");
      }
      setEntryId(out.entryId);setCompleteKey(markerKey);setAmounts({});
      try {sessionStorage.removeItem(markerKey);} catch { /* اگر حذف قفل نشد، پس از بارگذاری همچنان تطبیق دستی لازم است. */ }
      // موفقیت ثبت مستقل از خواندن بعدی تفصیلی است؛ خطای خواندن، موفقیت را پاک نمی‌کند.
      refresh(v => v + 1);
    } catch (caught) {
      const rejected = caught instanceof ApiError && caught.status >= 400 && caught.status < 500 && caught.status !== 408;
      if (rejected) {
        try {sessionStorage.removeItem(markerKey);} catch { /* حفظ قفل از تکرار ناخواسته امن‌تر است. */ }
        setError(message(caught));
      } else {
        setError("نتیجهٔ ثبت مشخص نیست. برای این شعبه و سال دوباره ارسال نکنید؛ ابتدا سند را در دفتر حسابداری با مسئول مالی تطبیق دهید.");
      }
    } finally {
      refreshMarker(v => v + 1);setConfirm(false);working.current = false;setBusy(false);
    }
  }

  return <div className="opening-screen">
    <PageHeader title="افتتاحیه و تفصیلی" context="مانده‌های ابتدای دوره را از اسناد تأییدشده وارد کنید و مانده اشخاص را ببینید."
      actions={<Button disabled={query.loading || busy} onClick={() => refresh(v => v + 1)}>بازخوانی اطلاعات</Button>} />
    {entryId && <div className="solid pad" role="status"><StatusBadge state="completed" label="سند افتتاحیه ثبت شد" /><p>شناسه سند: <Ltr>{entryId}</Ltr></p></div>}
    {error && <p className="solid pad" role="alert">{error}</p>}
    {!!query.error && <ResultState kind="error" title={message(query.error)} description="خواندن اطلاعات انجام نشد. ورودی‌ها حفظ شده‌اند؛ بازخوانی، وضعیت ثبت سند افتتاحیه را تأیید نمی‌کند."
      actionLabel="تلاش دوباره" onAction={() => refresh(v => v + 1)} />}
    {query.loading && <p className="muted" role="status">در حال خواندن اطلاعات…</p>}
    {data && <>
      <Solid as="section" className="pad opening-form-section">
        <SectionHeader title="مانده افتتاحیه" description="مبلغ‌ها به تومان هستند. توازن را با مانده‌های مستند بررسی کنید؛ برای رفع اختلاف، مبلغ بدون پشتوانه وارد نکنید." />
        {!data.canEdit && <ResultState kind="denied" title="فقط مشاهده" description="ثبت افتتاحیه به مجوز تنظیمات امنیتی نیاز دارد؛ دسترسی ثبت شما تأیید نشده است." />}
        <div className="opening-context">
          <Field label="شعبه"><select value={branchId} disabled={busy} onChange={e => {setBranchId(e.target.value);setEntryId(null);setError(null);}}>
            <option value="">انتخاب کنید…</option>{data.branches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
          </select></Field>
          <Field label="سال مالی" hint="سال شمسی، از ۱۳۰۰ تا ۱۵۰۰" error={!validYear ? "سال مالی باید عدد صحیح بین ۱۳۰۰ و ۱۵۰۰ باشد." : null}>
            <input className="num" inputMode="numeric" value={year} disabled={busy} onChange={e => {setYear(e.target.value);setEntryId(null);setError(null);}} />
          </Field>
        </div>
        {marker === "uncertain" && <div role="alert" className="opening-reconcile"><StatusBadge state="unknown" label="نتیجهٔ ثبت نیازمند بررسی است" /><p>ارسال دوباره برای این شعبه و سال مسدود است، حتی پس از بازخوانی صفحه. مسئول مالی باید سند افتتاحیه را در دفتر حسابداری تطبیق دهد؛ فهرست تفصیلی تأیید ثبت نیست.</p></div>}
        {marker === "complete" && <p className="muted">ثبت این شعبه و سال در این نشست تأیید شده است؛ ارسال دوباره مسدود است.</p>}
        {(marker === "unavailable" || storageFailed) && <p role="alert">نگهداری قفل ارسال در مرورگر در دسترس نیست؛ ثبت برای جلوگیری از ارسال تکراری بسته است.</p>}
        <div className="opening-sides">
          {(["debit", "credit"] as const).map(side => <fieldset key={side} className="opening-side" disabled={blocked}>
            <legend>{side === "debit" ? "مانده‌های بدهکار" : "مانده‌های بستانکار"}</legend>
            {OPENING_LEGS.filter(leg => leg.side === side).map(leg => <Field key={leg.leg} label={`${leg.label} (تومان)`} error={totals.invalid[leg.leg] ?? null}>
              <input className="num" inputMode="numeric" value={amounts[leg.leg] ?? ""} onChange={e => setAmounts(previous => ({...previous, [leg.leg]: e.target.value}))} />
            </Field>)}
          </fieldset>)}
        </div>
        <div className="opening-totals" aria-live="polite">
          <div><span>جمع بدهکار</span><Money rial={hasInvalid ? null : totals.debit} /></div>
          <div><span>جمع بستانکار</span><Money rial={hasInvalid ? null : totals.credit} /></div>
          <div><span>اختلاف</span><Money rial={hasInvalid ? null : (totals.difference < 0n ? -totals.difference : totals.difference)} /></div>
        </div>
        <StatusBadge state={hasInvalid ? "warning" : totals.debit === 0n && totals.credit === 0n ? "draft" : totals.difference === 0n ? "completed" : "attention"}
          label={hasInvalid ? "مبلغ نامعتبر را اصلاح کنید" : totals.debit === 0n && totals.credit === 0n ? "هنوز مبلغی وارد نشده" : totals.difference === 0n ? "جمع‌ها متوازن‌اند" : "جمع بدهکار و بستانکار برابر نیست"} />
        <Button variant="primary" disabled={blocked || !ready} onClick={() => setConfirm(true)}>بررسی و ثبت افتتاحیه</Button>
      </Solid>
      <Solid as="section" className="pad opening-tafsili">
        <SectionHeader title="تفصیلی اشخاص" description="مانده‌ها از سطرهای دفتر حسابداری محاسبه می‌شوند و در این فهرست قابل ویرایش نیستند." />
        {data.rows.length === 0 ? <ResultState title="هنوز سندی به نام شخصی ثبت نشده است." /> : [...byParent.entries()].map(([code,group]) => <section key={code}>
          <h3><Ltr>{code}</Ltr> · {group.name}</h3>
          <ul className="opening-party-list">{group.items.map(row => <li key={row.code}>
            <div><strong>{row.partyName ?? "نام ثبت نشده"}</strong><span className="muted small">{PARTY_LABEL[row.partyType] ?? row.partyType} · <Ltr>{row.code}</Ltr></span></div>
            <div className="opening-party-balance"><span className="muted small">مانده</span><Money rial={row.balance} exact /></div>
          </li>)}</ul>
        </section>)}
      </Solid>
    </>}
    <Dialog open={confirm} onClose={() => setConfirm(false)} dismissible={!busy} title="تأیید سند افتتاحیه" tone="final"
      description="این عمل سند مالی ثبت می‌کند. شعبه، سال و همهٔ مبلغ‌ها را با اسناد مبنا تطبیق دهید."
      footer={<><Button disabled={busy} onClick={() => setConfirm(false)}>بازگشت به ویرایش</Button><Button variant="primary" busy={busy} busyLabel="در حال ثبت…" disabled={blocked || !ready} onClick={() => void submit()}>تأیید و ثبت سند</Button></>}>
      <p>{data?.branches.find(branch => branch.id === branchId)?.name} · سال <Ltr>{normalizedYear}</Ltr></p>
      <ul className="opening-review-list">{totals.legs.map(leg => {const definition = OPENING_LEGS.find(item => item.leg === leg.leg)!;return <li key={leg.leg}><span>{definition.label} · {definition.side === "debit" ? "بدهکار" : "بستانکار"}</span><Money rial={leg.amount} /></li>;})}</ul>
      <p className="opening-review-total">جمع هر طرف سند <Money rial={totals.debit} /></p>
    </Dialog>
  </div>;
}
