/**
 * کارمزد و دوره تسویه — **به‌ازای هر پایانه**.
 *
 * این عمداً یک کلید سراسری در `platform.setting` نیست، و نباید بشود:
 * کارت‌خوان فروشگاه و درگاه سایت دو قرارداد جدا با PSP دارند. یک کلید
 * سراسری یعنی نرخِ یکی روی سند دیگری بنشیند — خطایی که هر روز در دفتر
 * تکرار می‌شود بی‌آنکه چیزی قرمز شود.
 *
 * پس هر پایانه سطر خودش را دارد و `treasury.set_settlement_terms()`
 * تنها مسیر تغییرش است: اعتبارسنجی بازه، ردّ حسابرسی، مهر کاربر عامل.
 *
 * ── کارمزد رشته است، نه عدد ─────────────────────────────────────────
 *
 * `numeric(5,3)` اعشار دارد و `number` جاوااسکریپت ۰٫۲۳۵ را دقیق نگه
 * نمی‌دارد. همان قاعده پول، به همان دلیل.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { ApiError } from "../lib/api.ts";
import {
  admin,
  type DeviceDriver,
  type DriverInput,
  type SettlementTerm,
  type TerminalDriver,
} from "../lib/admin.ts";
import { PageHeader, SectionHeader } from "../components/ui/PageHeader.tsx";
import { Button, Field } from "../components/ui/Controls.tsx";
import { StatusBadge } from "../components/ui/Status.tsx";
import { Ltr } from "../components/ui/Bidi.tsx";
import { ResultState } from "../components/ResultState.tsx";
import { useLatestQuery } from "../lib/use-latest-query.ts";
import { session } from "../lib/session.ts";
import "../styles/terminals.css";
import { normalizeDigits } from "../lib/settings-value.ts";

const KIND_LABEL: Record<string, string> = {
  cash_box: "صندوق",
  bank: "بانک",
  card_terminal: "کارت‌خوان",
  gateway: "درگاه پرداخت",
};

function message(e: unknown): string {
  return e instanceof ApiError ? e.message : "ارتباط با سرور برقرار نشد";
}
const unclear = (e: unknown) => !(e instanceof ApiError) || e.status >= 500;

export function Terminals() {
  const [version, refresh] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const working = useRef(false);
  const load = useCallback((signal: AbortSignal) => admin.settlementTerms(signal), []);
  const query = useLatestQuery({key: "terminal-terms", version, load});
  const [terms, setTerms] = useState<SettlementTerm[] | null>(null);
  useEffect(() => {if(query.data) {setTerms(query.data.terms);setUncertain(false);setError(null);}}, [query.data]);
  const blocked = busy || query.loading || !!query.error || uncertain;
  async function save(t: SettlementTerm, days: string, fee: string, reason: string) {
    if (working.current || blocked || !t.canEdit) return;
    working.current = true; setBusy(true); setError(null); setNote(null);
    try {
      const saved = await admin.saveTerms(t.id, {
        settlementDays: Number(normalizeDigits(days)), feePercent: normalizeDigits(fee),
        ...(reason.trim() === "" ? {} : { reason: reason.trim() }),
      });
      setTerms(list => (list ?? []).map(x => x.id === t.id ? {...x,...saved} : x));
      setNote("شرایط «" + t.name + "» ذخیره شد.");
    } catch (e) {
      setError(message(e)); setUncertain(unclear(e));
    } finally {working.current = false;setBusy(false);}
  }
  return <div className="terminal-screen">
    <PageHeader title="پایانه‌ها" context="شرایط تسویه و اتصال دستگاه‌های هر پایانه را جداگانه مدیریت کنید." />
    {error && <p className="solid pad" role="alert">{error}{uncertain && " پیش از تغییر بعدی، وضعیت شرایط را تازه‌سازی کنید."}</p>}
    {note && <p className="solid pad" role="status">{note}</p>}
    <Solid as="section" className="pad terminal-section">
      <SectionHeader title="کارمزد و دوره تسویه" description="شرایط هر پایانه فقط برای همان پایانه ذخیره می‌شود."
        actions={<Button disabled={busy || query.loading} onClick={() => refresh(v => v + 1)}>تازه‌سازی شرایط</Button>} />
      {!terms ? <ResultState kind={query.error ? "error" : "loading"} title={query.error ? message(query.error) : "در حال بارگذاری پایانه‌ها…"}
        {...(query.error ? {actionLabel:"تلاش دوباره",onAction:()=>refresh(v=>v+1)} : {})} /> : <>
        {query.error && <p role="alert">{message(query.error)}؛ دادهٔ آخرین بررسی نمایش داده می‌شود و ذخیره تا تازه‌سازی موفق بسته است.</p>}
        {query.loading && <p role="status" className="muted">در حال تازه‌سازی شرایط…</p>}
        {terms.length ? <ul className="terminal-list">{terms.map(t => <TermRow key={t.id} term={t} busy={blocked} onSave={save} />)}</ul>
          : <ResultState title="پایانه‌ای برای نمایش وجود ندارد." description="پس از تعریف حساب پایانه در خزانه، شرایط آن اینجا نمایش داده می‌شود." />}
      </>}
    </Solid>
    <DriverSection />
  </div>;
}

/**
 * درایور دستگاه هر پایانه.
 *
 * ── چرا این بخش وجود دارد در حالی که هیچ درایوری کار نمی‌کند ────────
 *
 * `CLAUDE.md` می‌گوید Windows Bridge و PC-POS تا دریافت مستندات کتبی
 * SDK از PSP ساخته نمی‌شوند. آن هنوز برقرار است و **کد ارتباط با
 * دستگاه نوشته نشده** — بدون مستندات، هر کدی حدس است و حدس در مسیر
 * پول یعنی پرداختی که وضعیتش معلوم نیست.
 *
 * آنچه ساخته شده جایی است که آن مستندات بنشیند. وقتی SDK رسید، یک
 * Handler اضافه می‌شود — نه یک مهاجرت، نه یک تغییر اسکیما، و نه یک
 * Deploy برای هر کارت‌خوان تازه.
 *
 * ⚠️ نشان‌دادن `isImplemented` اجباری است، نه تزئینی. بدون آن مالک یک
 * کارت‌خوان را انتخاب می‌کند و اولین پرداخت واقعی در سکوت شکست
 * می‌خورد — یا بدتر، معلق می‌ماند و پول مشتری بلاتکلیف.
 */
function DriverSection() {
  const [drivers, setDrivers] = useState<DeviceDriver[] | null>(null);
  const [terminals, setTerminals] = useState<TerminalDriver[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [version,refresh] = useState(0);
  const [canManage,setCanManage] = useState(false);
  const [uncertain,setUncertain] = useState(false);
  const working=useRef(false);
  const load = useCallback(async(signal:AbortSignal) => {
    const [d,t] = await Promise.all([admin.deviceDrivers(true,signal),admin.terminalDrivers(signal)]);
    return {drivers:d.drivers,terminals:t.terminals};
  },[]);
  const query=useLatestQuery({key:"terminal-drivers",version,load});
  useEffect(()=>{if(query.data){setDrivers(query.data.drivers);setTerminals(query.data.terminals);setUncertain(false);setError(null);}},[query.data]);
  useEffect(()=>{const controller=new AbortController();void session.can("settings.security",{signal:controller.signal})
    .then(r=>{if(!controller.signal.aborted)setCanManage(r.verdict==="allow");}).catch(()=>{});return()=>controller.abort();},[]);
  const blocked=busy||query.loading||!!query.error||uncertain;
  const reload=()=>refresh(v=>v+1);

  async function pick(accountId: string, code: string) {
    if(working.current || blocked || !canManage) return;
    if(!terminals.some(t=>t.accountId===accountId && t.canEdit)) return;
    if(code && !drivers?.some(d=>d.code===code && d.isActive && d.isImplemented && d.deviceKind==="card_terminal")) return;
    working.current=true;
    setBusy(true);
    setError(null);
    try {
      await admin.setTerminalDriver(accountId, { driverCode: code === "" ? null : code });
      reload();
    } catch (err) {
      // پیام نگهبان دیتابیس فارسی و برای کاربر است — «هنوز پیاده
      // نشده» دقیقاً همان چیزی است که کاربر باید بخواند.
      setError(message(err)); setUncertain(unclear(err));
    } finally {
      working.current=false; setBusy(false);
    }
  }

  async function save(code: string, input: DriverInput) {
    if(working.current || blocked || !canManage) return false;
    working.current=true;
    setBusy(true);
    setError(null);
    try {
      await admin.saveDriver(code, input);
      reload();
      return true;
    } catch (err) {
      // اعتبارسنجی در دیتابیس است و پیامش فارسی و برای کاربر —
      // «نشانی مستندات باید با https:// شروع شود» دقیقاً همان چیزی
      // است که باید خوانده شود.
      setError(message(err)); setUncertain(unclear(err));
      return false;
    } finally {
      working.current=false; setBusy(false);
    }
  }

  async function setActive(code: string, isActive: boolean) {
    if(working.current || blocked || !canManage) return;
    working.current=true;
    setBusy(true);
    setError(null);
    try {
      await admin.setDriverActive(code, isActive);
      reload();
    } catch (err) {
      setError(message(err)); setUncertain(unclear(err));
    } finally {
      working.current=false; setBusy(false);
    }
  }

  if (drivers === null) {
    return <Solid as="section" className="pad"><SectionHeader title="درایور دستگاه" />
      <ResultState kind={query.error ? "error" : "loading"} title={query.error ? message(query.error) : "در حال بارگذاری درایورها…"}
        {...(query.error ? {actionLabel:"تلاش دوباره برای دستگاه‌ها",onAction:reload} : {})} /></Solid>;
  }

  const live = drivers.filter((d) => d.isActive);
  const ready = live.filter((d) => d.isImplemented).length;

  return (
    <Solid as="section" className="pad">
      <SectionHeader title="درایور دستگاه" description="ثبت مشخصات دستگاه به معنی آماده‌بودن اتصال آن نیست."
        actions={<Button disabled={busy||query.loading} onClick={reload}>تازه‌سازی دستگاه‌ها</Button>} />
      {(query.error || uncertain) && <p role="alert">وضعیت اتصال‌ها نیازمند بررسی دوباره است؛ برای ادامه، دستگاه‌ها را تازه‌سازی کنید.</p>}
      {!canManage && <p className="muted">مشاهدهٔ مستندات؛ مجوز ویرایش دستگاه‌ها ندارید.</p>}
      {ready === 0 ? (
        <p className="terminal-readiness" role="status"><StatusBadge state="warning" label="اتصال آماده نیست" />
          <strong>هیچ درایوری هنوز پیاده نشده است.</strong> برای اتصال خودکار، درایور سازگار و آزمون دستگاه لازم است.
        </p>
      ) : null}

      {error !== null ? (
        <p className="set-msg set-msg--crit" role="alert">
          <span aria-hidden="true">⚠</span> {error}
        </p>
      ) : null}

      <ul className="terminal-list">
        {terminals.map((t) => (
          <li key={t.accountId}>
            <div className="terminal-entry">
              <div className="row between">
                <strong>{t.accountName}</strong>
                <Ltr>{t.accountCode}</Ltr>
              </div>
              <Field label="دستگاه">
                <select
                  className="set-input"
                  value={t.driverCode ?? ""}
                  disabled={blocked || !canManage || !t.canEdit}
                  onChange={(e) => void pick(t.accountId, e.target.value)}
                >
                  <option value="">— بدون دستگاه —</option>
                  {drivers
                    // بازنشسته در فهرست انتخاب نمی‌آید — ولی اگر همین
                    // پایانه از قبل به آن وصل بوده، سرور هم اجازه
                    // بازنشستگی‌اش را نمی‌داد، پس چیزی گم نمی‌شود.
                    .filter((d) => d.deviceKind === "card_terminal" && d.isActive)
                    .map((d) => (
                      <option key={d.code} value={d.code} disabled={!d.isImplemented}>
                        {d.label}
                        {d.isImplemented ? "" : " — هنوز پیاده نشده"}
                      </option>
                    ))}
                </select>
              </Field>
              {!t.canEdit ? (
                <span className="pill set-lock">
                  <span aria-hidden="true">🔒</span> دسترسی ندارید
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <details style={{ marginTop: "var(--s-3)" }}>
        <summary className="muted small">
          مستندات SDK دستگاه‌های شناخته‌شده — افزودن و ویرایش
        </summary>

        <p className="muted small" style={{ marginTop: "var(--s-2)" }}>
          کارت‌خوان‌ها عوض می‌شوند و زیادتر می‌شوند. رسیدن یک دستگاه تازه یک ردیف
          در همین فهرست است، نه یک نسخه تازه نرم‌افزار.
        </p>

        <p className="muted small">
          ⚠️ «پیاده‌شده» از اینجا روشن نمی‌شود. ثبت یک دستگاه یعنی مستنداتش را
          داریم؛ کدِ ارتباط با آن جدا نوشته می‌شود و تا نوشته نشود، وصل‌کردن
          پایانه به آن رد می‌شود. کلید و رمز API هم اینجا نمی‌نشیند — از متغیر
          محیطی سرور می‌آید.
        </p>

        <ul className="terminal-list" style={{ marginTop: "var(--s-2)" }}>
          {drivers.map((d) => (
            <DriverRow key={d.code} driver={d} busy={blocked || !canManage} onSave={save} onActive={setActive} />
          ))}
        </ul>

        {canManage && <DriverNew busy={blocked} onSave={save} />}
      </details>
    </Solid>
  );
}

/** انواع دستگاه — همان فهرستی که دیتابیس هم می‌سنجد. */
const KINDS: ReadonlyArray<[string, string]> = [
  ["card_terminal", "کارت‌خوان"],
  ["printer", "چاپگر"],
  ["scale", "ترازو"],
  ["scanner", "بارکدخوان"],
];

/**
 * یک ردیف از رجیستری درایور — ویرایش مستندات و بازنشستگی.
 *
 * ⚠️ «پیاده‌شده» فقط **نمایش** داده می‌شود، ورودی ندارد. اگر ورودی
 * داشت، مالک می‌توانست دستگاهی را که کدش نوشته نشده «پیاده‌شده»
 * علامت بزند، پایانه را به آن وصل کند، و اولین پرداخت واقعی در سکوت
 * شکست بخورد.
 */
function DriverRow(props: {
  driver: DeviceDriver;
  busy: boolean;
  onSave: (code: string, input: DriverInput) => Promise<boolean>;
  onActive: (code: string, isActive: boolean) => void;
}) {
  const { driver: d, busy } = props;
  const [label, setLabel] = useState(d.label);
  const [vendor, setVendor] = useState(d.vendor ?? "");
  const [url, setUrl] = useState(d.sdkDocUrl ?? "");
  const [notes, setNotes] = useState(d.notes ?? "");

  const dirty =
    label !== d.label ||
    vendor !== (d.vendor ?? "") ||
    url !== (d.sdkDocUrl ?? "") ||
    notes !== (d.notes ?? "");

  return (
    <li>
      <div className="terminal-entry">
        <div className="row between">
          <strong>{d.label}</strong>
          <span className="row" style={{ gap: "var(--s-1)" }}>
            <StatusBadge state={d.isImplemented ? "completed" : "warning"} label={d.isImplemented ? "پیاده‌شده" : "فقط ثبت‌شده"} />
            {!d.isActive && <StatusBadge state="archived" label="بازنشسته" />}
            <Ltr>{d.code}</Ltr>
          </span>
        </div>

        <Field label="نام">
          <input disabled={busy} className="set-input" type="text" value={label}
                 onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="سازنده">
          <input disabled={busy} className="set-input" type="text" value={vendor}
                 onChange={(e) => setVendor(e.target.value)} />
        </Field>
        <Field label="نشانی مستندات SDK">
          <input disabled={busy} className="set-input" type="text" value={url}
                 placeholder="https://…"
                 onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <Field label="یادداشت فنی">
          <textarea disabled={busy} className="set-input" rows={2} value={notes}
                    onChange={(e) => setNotes(e.target.value)} />
        </Field>

        <div className="row" style={{ gap: "var(--s-2)" }}>
          <button
            type="button"
            className="btn"
            disabled={busy || !dirty}
            onClick={() =>
              void props.onSave(d.code, {
                label,
                deviceKind: d.deviceKind,
                vendor: vendor.trim() === "" ? null : vendor,
                sdkDocUrl: url.trim() === "" ? null : url,
                notes: notes.trim() === "" ? null : notes,
              })
            }
          >
            ذخیره
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy}
            onClick={() => props.onActive(d.code, !d.isActive)}
          >
            {d.isActive ? "بازنشسته کن" : "برگردان"}
          </button>
        </div>
      </div>
    </li>
  );
}

/** افزودن یک دستگاه تازه — «ممکن است زیادتر شوند». */
function DriverNew(props: {
  busy: boolean;
  onSave: (code: string, input: DriverInput) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState("card_terminal");
  const [vendor, setVendor] = useState("");
  const [url, setUrl] = useState("");

  if (!open) {
    return (
      <button type="button" className="btn" disabled={props.busy} style={{ marginTop: "var(--s-2)" }}
              onClick={() => setOpen(true)}>
        افزودن دستگاه تازه
      </button>
    );
  }

  return (
    <Solid className="pad stack" style={{ gap: "var(--s-2)", marginTop: "var(--s-2)" }}>
      <strong>دستگاه تازه</strong>
      <Field label="کد (انگلیسی، بدون فاصله)">
        <input disabled={props.busy} className="set-input" type="text" value={code}
               placeholder="samankish" onChange={(e) => setCode(e.target.value)} />
      </Field>
      <Field label="نام">
        <input disabled={props.busy} className="set-input" type="text" value={label}
               onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <Field label="نوع">
        <select disabled={props.busy} className="set-input" value={kind} onChange={(e) => setKind(e.target.value)}>
          {KINDS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
        </select>
      </Field>
      <Field label="سازنده">
        <input disabled={props.busy} className="set-input" type="text" value={vendor}
               onChange={(e) => setVendor(e.target.value)} />
      </Field>
      <Field label="نشانی مستندات SDK">
        <input disabled={props.busy} className="set-input" type="text" value={url}
               placeholder="https://…" onChange={(e) => setUrl(e.target.value)} />
      </Field>

      <p className="muted small" style={{ margin: 0 }}>
        دستگاه تازه «فقط ثبت‌شده» ساخته می‌شود. تا کدِ ارتباط با آن نوشته نشود،
        وصل‌کردن پایانه به آن رد می‌شود.
      </p>

      <div className="row" style={{ gap: "var(--s-2)" }}>
        <button
          type="button"
          className="btn"
          disabled={props.busy || code.trim() === "" || label.trim() === ""}
          onClick={() => {
            void (async () => {
              const ok = await props.onSave(code.trim(), {
                label,
                deviceKind: kind,
                vendor: vendor.trim() === "" ? null : vendor,
                sdkDocUrl: url.trim() === "" ? null : url,
                notes: null,
              });
              // ⚠️ فقط وقتی بسته می‌شود که سرور پذیرفته باشد. بستنِ
              //    فرم روی خطا یعنی کاربر پیام را ببیند و ورودی‌اش
              //    رفته باشد.
              if (ok) {
                setOpen(false);
                setCode("");
                setLabel("");
                setVendor("");
                setUrl("");
              }
            })();
          }}
        >
          افزودن
        </button>
        <button type="button" className="btn btn--ghost" disabled={props.busy}
                onClick={() => setOpen(false)}>
          انصراف
        </button>
      </div>
    </Solid>
  );
}

function TermRow(props: {
  term: SettlementTerm;
  busy: boolean;
  onSave: (t: SettlementTerm, days: string, fee: string, reason: string) => void;
}) {
  const { term: t, busy } = props;
  const [days, setDays] = useState(String(t.settlementDays));
  const [fee, setFee] = useState(t.feePercent);
  const [reason, setReason] = useState("");

  const dirty = normalizeDigits(days) !== String(t.settlementDays) || normalizeDigits(fee) !== t.feePercent;

  const locked=busy || !t.canEdit;
  return <li className="terminal-entry">
    <div className="terminal-entry-head"><div><strong>{t.name}</strong><p className="muted small">{KIND_LABEL[t.kind] ?? t.kind} · <Ltr>{t.code}</Ltr></p></div>
      {!t.canEdit && <StatusBadge state="unknown" label="فقط مشاهده" />}</div>
    <form className="terminal-fields" onSubmit={e=>{e.preventDefault();if(!locked && dirty)props.onSave(t,days,fee,reason);}}>
      <Field label="دوره تسویه (روز)"><input className="num" type="text" inputMode="numeric" value={days} disabled={locked} onChange={e=>setDays(e.target.value)} /></Field>
      <Field label="کارمزد (٪)"><input className="num" type="text" inputMode="decimal" value={fee} disabled={locked} onChange={e=>setFee(e.target.value)} /></Field>
      <Field label="دلیل" optional><input value={reason} disabled={locked} onChange={e=>setReason(e.target.value)} /></Field>
      <Button type="submit" variant="primary" disabled={locked || !dirty}>ذخیره شرایط</Button>
    </form>
  </li>;
}
