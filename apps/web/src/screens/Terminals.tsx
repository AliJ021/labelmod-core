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
import { admin, type SettlementTerm } from "../lib/admin.ts";
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
    </div>
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
