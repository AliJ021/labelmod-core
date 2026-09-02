/**
 * تفصیلی اشخاص و مانده افتتاحیه — دو قابلیت هلو.
 *
 * ── تفصیلی: چرا فقط خواندنی است ─────────────────────────────────────
 *
 * در هلو هر مشتری یک حساب تفصیلی زیر «بدهکاران» است. اینجا هم همان را
 * می‌بینید — ولی **حساب جدا نیست**: از `party_id` سطر سند ساخته
 * می‌شود.
 *
 * دلیلش این است که این پروژه از روز اول مانده اشخاص را در خودِ سند
 * نگه می‌دارد. اگر حساب تفصیلی جدا هم می‌ساختیم، مانده هر مشتری دو
 * منبع پیدا می‌کرد و دیر یا زود از هم جدا می‌افتادند. پس ویرایشی در
 * کار نیست: مانده از سند می‌آید و با سند عوض می‌شود.
 *
 * ── افتتاحیه: همان چیزی که موقع کوچ لازم است ────────────────────────
 *
 * وقتی از سیستم قبلی می‌آیید، مانده‌های اول دوره باید وارد شوند.
 * توازن **پیش از ثبت** سنجیده می‌شود تا پیام فارسی بگیرید، نه خطای
 * فنی دفتر.
 */
import { useEffect, useMemo, useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { ApiError } from "../lib/api.ts";
import { admin, OPENING_LEGS, type Tafsili } from "../lib/admin.ts";
import { rialFromTomanInput, toman } from "../lib/money.ts";
import { pos, type Branch } from "../lib/pos.ts";

function message(e: unknown): string {
  return e instanceof ApiError ? e.message : "ارتباط با سرور برقرار نشد";
}

const PARTY_LABEL: Record<string, string> = {
  customer: "مشتری",
  supplier: "تأمین‌کننده",
  user: "کاربر",
};

export function Opening() {
  const [rows, setRows] = useState<Tafsili[] | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("");
  const [year, setYear] = useState("1405");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [t, b] = await Promise.all([admin.tafsili(), pos.branches()]);
        if (!alive) return;
        setRows(t.rows);
        setBranches(b.branches);
        if (b.branches.length === 1) setBranchId(b.branches[0]?.id ?? "");
      } catch (e: unknown) {
        if (alive) setError(message(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /** گروه‌بندی تفصیلی زیر معینش — همان شکلی که در هلو دیده می‌شود. */
  const byParent = useMemo(() => {
    const out = new Map<string, { name: string; items: Tafsili[] }>();
    for (const r of rows ?? []) {
      const g = out.get(r.parentCode);
      if (g) g.items.push(r);
      else out.set(r.parentCode, { name: r.parentName, items: [r] });
    }
    return out;
  }, [rows]);

  /**
   * توازن، همان‌طور که سرور می‌سنجد.
   *
   * اینجا فقط برای **بازخورد فوری** است — قاعده واقعی در دیتابیس است
   * و اگر این دو اختلاف پیدا کنند، آن که در psql دور زده می‌شود همان
   * است که اهمیت دارد.
   */
  const totals = useMemo(() => {
    let debit = 0n;
    let credit = 0n;
    for (const l of OPENING_LEGS) {
      const raw = amounts[l.leg]?.trim() ?? "";
      if (raw === "") continue;
      const rial = rialFromTomanInput(raw);
      if (rial === null) continue;
      if (l.side === "debit") debit += rial;
      else credit += rial;
    }
    return { debit, credit, diff: debit - credit };
  }, [amounts]);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      // اعتبارسنجی محلی فقط برای بازخورد فوری است؛ قاعده واقعی در
      // دیتابیس است. پس اینجا `ApiError` ساخته نمی‌شود — آن برای
      // خطای سرور است و جعلش پیام‌ها را به‌هم می‌ریزد.
      const legs: Array<{ leg: string; amount: string }> = [];
      for (const l of OPENING_LEGS) {
        const raw = amounts[l.leg]?.trim() ?? "";
        if (raw === "") continue;
        const rial = rialFromTomanInput(raw);
        if (rial === null) {
          setError(`مبلغ «${l.label}» معتبر نیست.`);
          return;
        }
        if (rial === 0n) continue;
        legs.push({ leg: l.leg, amount: rial.toString() });
      }
      if (legs.length === 0) {
        setError("هیچ مبلغی وارد نشده است.");
        return;
      }

      const out = await admin.postOpening({
        branchId,
        fiscalYear: Number(year),
        legs,
      });
      setNote(`سند افتتاحیه ثبت شد (${out.entryId.slice(0, 8)}…).`);
      setAmounts({});
      setRows((await admin.tafsili()).rows);
    } catch (e: unknown) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  const ready = branchId !== "" && year.trim() !== "" && totals.diff === 0n &&
    (totals.debit > 0n || totals.credit > 0n);

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
        <h2 style={{ marginTop: 0, marginBottom: "var(--s-1)" }}>مانده افتتاحیه</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          مانده‌های اول دوره، هنگام کوچ از سیستم قبلی. سند باید متوازن باشد —
          تفاوت را در «سود و زیان انباشته» بگذارید.
        </p>

        <div className="open-head">
          <label className="term-field">
            <span>شعبه</span>
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">انتخاب کنید…</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="term-field">
            <span>سال مالی</span>
            <input
              className="num"
              type="text"
              inputMode="numeric"
              value={year}
              onChange={(e) => setYear(e.target.value)}
            />
          </label>
        </div>

        <ul className="open-legs">
          {OPENING_LEGS.map((l) => (
            <li key={l.leg}>
              <label className="term-field">
                <span>
                  {l.label} — {l.side === "debit" ? "بدهکار" : "بستانکار"}
                </span>
                <input
                  className="num"
                  type="text"
                  inputMode="numeric"
                  placeholder="تومان"
                  value={amounts[l.leg] ?? ""}
                  onChange={(e) => setAmounts((a) => ({ ...a, [l.leg]: e.target.value }))}
                />
              </label>
            </li>
          ))}
        </ul>

        <p className={totals.diff === 0n ? "open-balanced" : "open-off"}>
          <span className="dot" aria-hidden="true">
            {totals.diff === 0n ? "●" : "▲"}
          </span>{" "}
          بدهکار <span className="num">{toman(totals.debit)}</span> · بستانکار{" "}
          <span className="num">{toman(totals.credit)}</span>
          {totals.diff === 0n ? (
            " — متوازن"
          ) : (
            <>
              {" "}
              — تفاوت <span className="num">{toman(totals.diff < 0n ? -totals.diff : totals.diff)}</span>
            </>
          )}
        </p>

        <button type="button" disabled={busy || !ready} onClick={() => void submit()}>
          ثبت سند افتتاحیه
        </button>
      </Solid>

      <Solid as="section" className="pad">
        <h2 style={{ marginTop: 0, marginBottom: "var(--s-1)" }}>تفصیلی اشخاص</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          مانده هر شخص، زیر حساب معین خودش. این‌ها حساب جدا نیستند — از سطر
          سند ساخته می‌شوند، تا مانده هر مشتری <strong>دو منبع</strong> پیدا
          نکند.
        </p>

        {rows === null ? (
          <p className="muted">در حال بارگذاری…</p>
        ) : rows.length === 0 ? (
          <p className="muted">هنوز سندی به نام شخصی ثبت نشده است.</p>
        ) : (
          [...byParent.entries()].map(([parentCode, g]) => (
            <section key={parentCode} className="perm-group">
              <h3 className="perm-op">
                <span className="num">{parentCode}</span> · {g.name}
              </h3>
              <ul className="taf-list">
                {g.items.map((r) => (
                  <li key={r.code} className="taf-row">
                    <span className="num acct-code">{r.code}</span>
                    <span className="acct-name">{r.partyName ?? "—"}</span>
                    <span className="muted small">{PARTY_LABEL[r.partyType] ?? r.partyType}</span>
                    <span className="num taf-balance">{toman(BigInt(r.balance))}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </Solid>
    </div>
  );
}
