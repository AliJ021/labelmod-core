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
import { useEffect, useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { ApiError } from "../lib/api.ts";
import {
  admin,
  type DeviceDriver,
  type DriverInput,
  type SettlementTerm,
  type TerminalDriver,
} from "../lib/admin.ts";
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

export function Terminals() {
  const [terms, setTerms] = useState<SettlementTerm[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    admin
      .settlementTerms()
      .then((r) => alive && setTerms(r.terms))
      .catch((e: unknown) => alive && setError(message(e)));
    return () => {
      alive = false;
    };
  }, []);

  async function save(t: SettlementTerm, days: string, fee: string, reason: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      // رقم فارسی و عربی هم پذیرفته می‌شود — صفحه‌کلید فارسی «۱» را
      // این‌طور می‌فرستد و ورودی عددی مرورگر دورش می‌انداخت.
      const d = Number(normalizeDigits(days));
      const f = normalizeDigits(fee);
      const saved = await admin.saveTerms(t.id, {
        settlementDays: d,
        feePercent: f,
        ...(reason.trim() === "" ? {} : { reason: reason.trim() }),
      });
      setTerms((list) => (list ?? []).map((x) => (x.id === t.id ? saved : x)));
      setNote(`شرایط «${t.name}» ذخیره شد.`);
    } catch (e: unknown) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  if (error && !terms) {
    return (
      <Solid as="section" className="pad">
        <p className="pos-alert" role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> {error}
        </p>
      </Solid>
    );
  }

  if (!terms) {
    return (
      <Solid as="section" className="pad">
        <p className="muted">در حال بارگذاری پایانه‌ها…</p>
      </Solid>
    );
  }

  return (
    <div className="stack" style={{ gap: "var(--s-4)" }}>
      {error ? (
        <p className="solid pos-alert" role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> {error}
        </p>
      ) : null}
      {note ? (
        <p className="solid pos-alert" role="status">
          <span className="dot dot--good" aria-hidden="true">●</span> {note}
        </p>
      ) : null}

      <Solid as="section" className="pad">
        <h2 style={{ marginTop: 0, marginBottom: "var(--s-1)" }}>کارمزد و دوره تسویه</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          هر پایانه قرارداد خودش را دارد. کارت‌خوان فروشگاه و درگاه سایت یک نرخ
          ندارند، پس اینجا کلید سراسری نیست و نباید باشد.
        </p>

        <ul className="term-list">
          {terms.map((t) => (
            <TermRow key={t.id} term={t} busy={busy} onSave={save} />
          ))}
        </ul>
      </Solid>

      <DriverSection />
    </div>
  );
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

  const load = async () => {
    // بازنشسته‌ها هم می‌آیند تا بشود برشان گرداند؛ فهرست انتخاب پایانه
    // پایین‌تر خودش فیلترشان می‌کند.
    const [d, t] = await Promise.all([admin.deviceDrivers(true), admin.terminalDrivers()]);
    setDrivers(d.drivers);
    setTerminals(t.terminals);
  };

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        await load();
      } catch (err) {
        if (alive) setError(message(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function pick(accountId: string, code: string) {
    setBusy(true);
    setError(null);
    try {
      await admin.setTerminalDriver(accountId, { driverCode: code === "" ? null : code });
      await load();
    } catch (err) {
      // پیام نگهبان دیتابیس فارسی و برای کاربر است — «هنوز پیاده
      // نشده» دقیقاً همان چیزی است که کاربر باید بخواند.
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function save(code: string, input: DriverInput) {
    setBusy(true);
    setError(null);
    try {
      await admin.saveDriver(code, input);
      await load();
      return true;
    } catch (err) {
      // اعتبارسنجی در دیتابیس است و پیامش فارسی و برای کاربر —
      // «نشانی مستندات باید با https:// شروع شود» دقیقاً همان چیزی
      // است که باید خوانده شود.
      setError(message(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function setActive(code: string, isActive: boolean) {
    setBusy(true);
    setError(null);
    try {
      await admin.setDriverActive(code, isActive);
      await load();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  if (drivers === null) {
    return <Solid as="section" className="pad muted">در حال بارگذاری درایورها…</Solid>;
  }

  const live = drivers.filter((d) => d.isActive);
  const ready = live.filter((d) => d.isImplemented).length;

  return (
    <Solid as="section" className="pad">
      <h2 style={{ marginTop: 0, marginBottom: "var(--s-1)" }}>درایور دستگاه</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        هر پایانه دستگاه خودش را دارد. افزودن کارت‌خوان تازه یک ردیف در جدول است،
        نه یک نسخه تازه نرم‌افزار.
      </p>

      {ready === 0 ? (
        // رنگ به‌تنهایی حامل معنا نیست — آیکون و متن هم هست.
        <p className="solid pos-alert" role="status">
          <span className="dot dot--warn" aria-hidden="true">●</span>{" "}
          <strong>هیچ درایوری هنوز پیاده نشده است.</strong> {live.length} دستگاه
          شناخته‌شده ثبت شده‌اند ولی کدشان نوشته نشده — تا مستندات کتبی SDK از
          شرکت پرداخت نرسد، ارتباط با دستگاه حدس است و حدس در مسیر پول یعنی
          پرداختی که وضعیتش معلوم نیست.
        </p>
      ) : null}

      {error !== null ? (
        <p className="set-msg set-msg--crit" role="alert">
          <span aria-hidden="true">⚠</span> {error}
        </p>
      ) : null}

      <ul className="term-list">
        {terminals.map((t) => (
          <li key={t.accountId}>
            <Solid className="pad stack" style={{ gap: "var(--s-2)" }}>
              <div className="row between">
                <strong>{t.accountName}</strong>
                <code className="set-key">{t.accountCode}</code>
              </div>
              <label className="auth-field">
                <span>دستگاه</span>
                <select
                  className="set-input"
                  value={t.driverCode ?? ""}
                  disabled={busy || !t.canEdit}
                  onChange={(e) => void pick(t.accountId, e.target.value)}
                >
                  <option value="">— بدون دستگاه —</option>
                  {drivers
                    // بازنشسته در فهرست انتخاب نمی‌آید — ولی اگر همین
                    // پایانه از قبل به آن وصل بوده، سرور هم اجازه
                    // بازنشستگی‌اش را نمی‌داد، پس چیزی گم نمی‌شود.
                    .filter((d) => d.deviceKind === "card_terminal" && d.isActive)
                    .map((d) => (
                      <option key={d.code} value={d.code}>
                        {d.label}
                        {d.isImplemented ? "" : " — هنوز پیاده نشده"}
                      </option>
                    ))}
                </select>
              </label>
              {!t.canEdit ? (
                <span className="pill set-lock">
                  <span aria-hidden="true">🔒</span> دسترسی ندارید
                </span>
              ) : null}
            </Solid>
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

        <ul className="term-list" style={{ marginTop: "var(--s-2)" }}>
          {drivers.map((d) => (
            <DriverRow key={d.code} driver={d} busy={busy} onSave={save} onActive={setActive} />
          ))}
        </ul>

        <DriverNew busy={busy} onSave={save} />
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
      <Solid className="pad stack" style={{ gap: "var(--s-2)" }}>
        <div className="row between">
          <strong>{d.label}</strong>
          <span className="row" style={{ gap: "var(--s-1)" }}>
            {d.isImplemented ? (
              <span className="pill trend trend--good">
                <span aria-hidden="true">✓</span> پیاده‌شده
              </span>
            ) : (
              <span className="pill trend trend--warn">
                <span aria-hidden="true">■</span> فقط ثبت‌شده
              </span>
            )}
            {!d.isActive ? (
              <span className="pill set-lock">
                <span aria-hidden="true">■</span> بازنشسته
              </span>
            ) : null}
            <code className="set-key">{d.code}</code>
          </span>
        </div>

        <label className="auth-field">
          <span>نام</span>
          <input className="set-input" type="text" value={label}
                 onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="auth-field">
          <span>سازنده</span>
          <input className="set-input" type="text" value={vendor}
                 onChange={(e) => setVendor(e.target.value)} />
        </label>
        <label className="auth-field">
          <span>نشانی مستندات SDK</span>
          <input className="set-input" type="text" dir="ltr" value={url}
                 placeholder="https://…"
                 onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label className="auth-field">
          <span>یادداشت فنی</span>
          <textarea className="set-input" rows={2} value={notes}
                    onChange={(e) => setNotes(e.target.value)} />
        </label>

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
      </Solid>
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
      <button type="button" className="btn" style={{ marginTop: "var(--s-2)" }}
              onClick={() => setOpen(true)}>
        افزودن دستگاه تازه
      </button>
    );
  }

  return (
    <Solid className="pad stack" style={{ gap: "var(--s-2)", marginTop: "var(--s-2)" }}>
      <strong>دستگاه تازه</strong>
      <label className="auth-field">
        <span>کد (انگلیسی، بدون فاصله)</span>
        <input className="set-input" type="text" dir="ltr" value={code}
               placeholder="samankish" onChange={(e) => setCode(e.target.value)} />
      </label>
      <label className="auth-field">
        <span>نام</span>
        <input className="set-input" type="text" value={label}
               onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label className="auth-field">
        <span>نوع</span>
        <select className="set-input" value={kind} onChange={(e) => setKind(e.target.value)}>
          {KINDS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
        </select>
      </label>
      <label className="auth-field">
        <span>سازنده</span>
        <input className="set-input" type="text" value={vendor}
               onChange={(e) => setVendor(e.target.value)} />
      </label>
      <label className="auth-field">
        <span>نشانی مستندات SDK</span>
        <input className="set-input" type="text" dir="ltr" value={url}
               placeholder="https://…" onChange={(e) => setUrl(e.target.value)} />
      </label>

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

  const dirty = days !== String(t.settlementDays) || fee !== t.feePercent;

  return (
    <li className="term-row">
      <div className="term-id">
        <strong>{t.name}</strong>
        <span className="muted small">
          {KIND_LABEL[t.kind] ?? t.kind} · <span className="num">{t.code}</span>
        </span>
      </div>

      <label className="term-field">
        <span>دوره تسویه (روز)</span>
        <input
          className="num"
          type="text"
          inputMode="numeric"
          value={days}
          onChange={(e) => setDays(e.target.value)}
        />
      </label>

      <label className="term-field">
        <span>کارمزد (٪)</span>
        <input
          className="num"
          type="text"
          inputMode="decimal"
          value={fee}
          onChange={(e) => setFee(e.target.value)}
        />
      </label>

      <label className="term-field term-reason">
        <span>دلیل (اختیاری)</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>

      <button
        type="button"
        disabled={busy || !dirty}
        onClick={() => props.onSave(t, days, fee, reason)}
      >
        ذخیره
      </button>
    </li>
  );
}
