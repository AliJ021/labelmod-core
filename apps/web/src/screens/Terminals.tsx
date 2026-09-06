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
    const [d, t] = await Promise.all([admin.deviceDrivers(), admin.terminalDrivers()]);
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

  if (drivers === null) {
    return <Solid as="section" className="pad muted">در حال بارگذاری درایورها…</Solid>;
  }

  const ready = drivers.filter((d) => d.isImplemented).length;

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
          <strong>هیچ درایوری هنوز پیاده نشده است.</strong> {drivers.length} دستگاه
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
                    .filter((d) => d.deviceKind === "card_terminal")
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
        <summary className="muted small">مستندات SDK دستگاه‌های شناخته‌شده</summary>
        <div className="tw" style={{ marginTop: "var(--s-2)" }}>
          <table>
            <thead>
              <tr>
                <th>دستگاه</th>
                <th>سازنده</th>
                <th>وضعیت</th>
                <th>مستندات</th>
              </tr>
            </thead>
            <tbody>
              {drivers.map((d) => (
                <tr key={d.code}>
                  <td>{d.label}</td>
                  <td>{d.vendor ?? "—"}</td>
                  <td>
                    {d.isImplemented ? (
                      <span className="pill trend trend--good">
                        <span aria-hidden="true">✓</span> پیاده‌شده
                      </span>
                    ) : (
                      <span className="pill trend trend--warn">
                        <span aria-hidden="true">■</span> فقط ثبت‌شده
                      </span>
                    )}
                  </td>
                  <td>
                    {d.sdkDocUrl === null ? (
                      <span className="muted">هنوز دریافت نشده</span>
                    ) : (
                      <a href={d.sdkDocUrl} target="_blank" rel="noreferrer noopener">
                        سند SDK
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
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
