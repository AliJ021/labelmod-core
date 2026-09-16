/**
 * سقف مجوزها — سقف تخفیف، سقف بازپرداخت، و «چه نقشی چه کاری می‌کند».
 *
 * قاعده پروژه از اول این بود که **هیچ شرط دسترسی در کد نباشد** — و
 * نبود. ولی تغییرشان فقط از psql ممکن بود، که برای مالک یعنی «باید
 * کد بزنی». این صفحه همان جدول را قابل ویرایش می‌کند.
 *
 * ── فهرست عملیات از داده می‌آید، نه از کد ───────────────────────────
 *
 * ستون‌های این جدول از `identity.permission_matrix` می‌آیند که خودش
 * عملیات‌ها را از قواعد موجود درمی‌آورد. اگر فردا عملیات تازه‌ای اضافه
 * شود، این صفحه بدون یک خط تغییر نشانش می‌دهد — همان قاعده‌ای که صفحه
 * تنظیمات دارد.
 *
 * ── `null` با صفر یکی نیست ──────────────────────────────────────────
 *
 * سقف تهی یعنی **بی‌سقف**. سقف صفر یعنی **هیچ مبلغی مجاز نیست**. اگر
 * صفحه این دو را یکی می‌کرد، خالی‌گذاشتن یک میدان می‌توانست بی‌صدا
 * دسترسی را باز کند یا ببندد.
 */
import { useEffect, useMemo, useState } from "react";
import { SearchField } from "../components/SearchField.tsx";
import { ResultState } from "../components/ResultState.tsx";
import { Solid } from "../components/Glass.tsx";
import { ApiError } from "../lib/api.ts";
import { admin, type PermissionRule } from "../lib/admin.ts";
import { rialFromTomanInput, toman } from "../lib/money.ts";
import { normalizeDigits } from "../lib/settings-value.ts";

function message(e: unknown): string {
  return e instanceof ApiError ? e.message : "ارتباط با سرور برقرار نشد";
}

function key(r: { roleCode: string; operation: string }) {
  return `${r.roleCode}\u0000${r.operation}`;
}

export function Permissions() {
  const [rules, setRules] = useState<PermissionRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    admin
      .permissionRules()
      .then((r) => alive && setRules(r.rules))
      .catch((e: unknown) => alive && setError(message(e)));
    return () => {
      alive = false;
    };
  }, [revision]);

  /** گروه‌بندی بر اساس عملیات — چون سؤال همیشه «چه کسی می‌تواند X» است. */
  const byOperation = useMemo(() => {
    const out = new Map<string, PermissionRule[]>();
    for (const r of rules ?? []) {
      if (filter && !r.operation.includes(filter) && !r.roleName.includes(filter)) continue;
      const list = out.get(r.operation);
      if (list) list.push(r);
      else out.set(r.operation, [r]);
    }
    return out;
  }, [rules, filter]);

  async function save(
    r: PermissionRule,
    input: {
      allowed: boolean;
      maxAmount: string | null;
      maxPercent: number | null;
      reason: string;
    },
  ) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const saved = await admin.savePermissionRule(r.roleCode, r.operation, {
        allowed: input.allowed,
        maxAmount: input.maxAmount,
        maxPercent: input.maxPercent,
        needsApprovalFrom: r.needsApprovalFrom,
        ...(input.reason.trim() === "" ? {} : { reason: input.reason.trim() }),
      });
      setRules((list) =>
        (list ?? []).map((x) => (key(x) === key(r) ? { ...x, ...saved, hasRule: true } : x)),
      );
      setEditing(null);
      setNote(`مجوز «${r.operation}» برای ${r.roleName} ذخیره شد.`);
    } catch (e: unknown) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  if (error && !rules) {
    return (
      <Solid as="section" className="pad">
        <ResultState kind="error" title={error} actionLabel="تلاش دوباره" onAction={() => setRevision(v => v + 1)} />
      </Solid>
    );
  }

  if (!rules) {
    return <div aria-busy="true"><Solid as="section" className="pad"><ResultState kind="loading" title="در حال بارگذاری مجوزها…" /></Solid></div>;
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
        <h2 style={{ marginTop: 0, marginBottom: "var(--s-1)" }}>مجوزها و سقف‌ها</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          سقف تهی یعنی <strong>بی‌سقف</strong>؛ سقف صفر یعنی <strong>هیچ مبلغی
          مجاز نیست</strong>. این دو یکی نیستند.
        </p>

        <SearchField label="جست‌وجوی عملیات یا نقش" value={filter} onChange={setFilter} />
        {byOperation.size === 0 ? <ResultState title={filter ? "برای این جست‌وجو مجوزی پیدا نشد." : "مجوزی برای نمایش وجود ندارد."} actionLabel={filter ? "پاک‌کردن جست‌وجو" : undefined} onAction={() => setFilter("")} /> : null}

        {[...byOperation.entries()].map(([operation, list]) => (
          <section key={operation} className="perm-group">
            <h3 className="perm-op">{operation}</h3>
            <ul className="perm-list">
              {list.map((r) =>
                editing === key(r) ? (
                  <li key={key(r)}>
                    <RuleForm
                      rule={r}
                      busy={busy}
                      onCancel={() => setEditing(null)}
                      onSave={(input) => void save(r, input)}
                    />
                  </li>
                ) : (
                  <li key={key(r)} className="perm-row">
                    <span className="perm-role">{r.roleName}</span>
                    <span className={r.allowed ? "perm-yes" : "perm-no"}>
                      <span className="dot" aria-hidden="true">
                        {r.allowed ? "●" : "○"}
                      </span>{" "}
                      {r.allowed ? "مجاز" : "ممنوع"}
                    </span>
                    <span className="muted small perm-caps">
                      {r.maxPercent === null ? "بی‌سقف درصدی" : `تا ${r.maxPercent}٪`}
                      {" · "}
                      {r.maxAmount === null ? (
                        "بی‌سقف مبلغی"
                      ) : (
                        <>
                          تا <span className="num">{toman(BigInt(r.maxAmount))}</span> تومان
                        </>
                      )}
                    </span>
                    <button type="button" className="btn btn--quiet" onClick={() => setEditing(key(r))} disabled={busy}>
                      ویرایش
                    </button>
                  </li>
                ),
              )}
            </ul>
          </section>
        ))}
      </Solid>
    </div>
  );
}

function RuleForm(props: {
  rule: PermissionRule;
  busy: boolean;
  onCancel: () => void;
  onSave: (input: {
    allowed: boolean;
    maxAmount: string | null;
    maxPercent: number | null;
    reason: string;
  }) => void;
}) {
  const { rule: r, busy } = props;
  const [allowed, setAllowed] = useState(r.allowed);
  const [percent, setPercent] = useState(r.maxPercent === null ? "" : String(r.maxPercent));
  // مبلغ به **تومان** نشان داده و گرفته می‌شود، مثل بقیه صفحه‌ها؛
  // تبدیل به ریال فقط در مرز API.
  const [amount, setAmount] = useState(r.maxAmount === null ? "" : toman(BigInt(r.maxAmount)));
  const [reason, setReason] = useState("");
  const [bad, setBad] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setBad(null);

    const p = percent.trim();
    let maxPercent: number | null = null;
    if (p !== "") {
      const n = Number(normalizeDigits(p));
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        setBad("سقف درصدی باید بین ۰ و ۱۰۰ باشد.");
        return;
      }
      maxPercent = n;
    }

    const a = amount.trim();
    let maxAmount: string | null = null;
    if (a !== "") {
      const rial = rialFromTomanInput(a);
      if (rial === null) {
        setBad("سقف مبلغی معتبر نیست.");
        return;
      }
      maxAmount = rial.toString();
    }

    props.onSave({ allowed, maxAmount, maxPercent, reason });
  }

  return (
    <form className="perm-form" onSubmit={submit}>
      <span className="perm-role">{r.roleName}</span>

      <label className="perm-check">
        <input type="checkbox" checked={allowed} onChange={(e) => setAllowed(e.target.checked)} />
        <span>مجاز</span>
      </label>

      <label className="perm-field">
        <span>سقف درصدی — خالی یعنی بی‌سقف</span>
        <input
          className="num"
          type="text"
          inputMode="decimal"
          value={percent}
          onChange={(e) => setPercent(e.target.value)}
        />
      </label>

      <label className="perm-field">
        <span>سقف مبلغی (تومان) — خالی یعنی بی‌سقف</span>
        <input
          className="num"
          type="text"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>

      <label className="perm-field">
        <span>دلیل (اختیاری)</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>

      <span className="acct-actions">
        <button type="submit" disabled={busy}>
          ذخیره
        </button>
        <button type="button" onClick={props.onCancel} disabled={busy}>
          انصراف
        </button>
      </span>

      {bad ? (
        <p className="perm-bad" role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> {bad}
        </p>
      ) : null}
    </form>
  );
}
