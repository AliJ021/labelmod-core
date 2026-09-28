import { useUrlFlag } from "../lib/use-url-state.ts";
/**
 * کدینگ حساب — درخت چهارسطحی، مثل هلو و دشت.
 *
 * گروه ← کل ← معین ← تفصیلی. کدها عوض نشدند وقتی سطح چهارم اضافه شد؛
 * فقط برچسبشان. یعنی این صفحه روی همان کدینگی کار می‌کند که از روز
 * اول در دفتر بوده.
 *
 * ── چرا این صفحه کم اجازه می‌دهد ────────────────────────────────────
 *
 * وسوسه‌اش این بود که هر میدانی همیشه قابل ویرایش باشد. ولی دو چیز
 * را دیتابیس قفل می‌کند و صفحه باید **پیش از کلیک** نشانش دهد، نه
 * بعد از خطا:
 *
 *   حسابی که سند خورده  →  ماهیت و نوعش عوض نمی‌شود
 *   حسابی که فرزند دارد →  سند نمی‌پذیرد
 *
 * هر دو جلوی خطایی را می‌گیرند که در جمع کل دیده نمی‌شود: تغییر
 * ماهیت، گزارش‌های گذشته را بی‌صدا عوض می‌کند؛ و حسابِ هم‌فرزنددار
 * هم‌قابل‌ثبت، در گزارش سلسله‌مراتبی دوباره شمرده می‌شود.
 *
 * ── سطح مات، نه شیشه ────────────────────────────────────────────────
 *
 * جدولِ کد و عدد. ADR-002 برای این حالت صریح است.
 */
import { useEffect, useMemo, useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { ApiError } from "../lib/api.ts";
import {
  admin,
  childLevel,
  sortTree,
  LEVEL_LABEL,
  NATURE_LABEL,
  TYPE_LABEL,
  type Account,
  type AccountInput,
  type AccountLevel,
  type AccountNature,
  type AccountType,
} from "../lib/admin.ts";

function message(e: unknown): string {
  return e instanceof ApiError ? e.message : "ارتباط با سرور برقرار نشد";
}

export function Accounts() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState<Account | null>(null);
  const [busy, setBusy] = useState(false);
  const [showInactive, setShowInactive] = useUrlFlag("accounts.inactive");

  useEffect(() => {
    let alive = true;
    admin
      .accounts()
      .then((r) => alive && setAccounts(r.accounts))
      .catch((e: unknown) => alive && setError(message(e)));
    return () => {
      alive = false;
    };
  }, []);

  const rows = useMemo(() => {
    if (!accounts) return [];
    const tree = sortTree(accounts);
    return showInactive ? tree : tree.filter((a) => a.isActive);
  }, [accounts, showInactive]);

  async function reload() {
    setAccounts((await admin.accounts()).accounts);
  }

  async function guarded(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch (e: unknown) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  const save = (code: string, input: AccountInput) =>
    guarded(async () => {
      await admin.saveAccount(code, input);
      await reload();
      setEditing(null);
      setAdding(null);
      setNote(`حساب ${code} ذخیره شد.`);
    });

  const toggleActive = (a: Account) =>
    guarded(async () => {
      await admin.setAccountActive(a.code, !a.isActive);
      await reload();
      setNote(`حساب ${a.code} ${a.isActive ? "غیرفعال" : "فعال"} شد.`);
    });

  if (error && !accounts) {
    return (
      <Solid as="section" className="pad">
        <p className="pos-alert" role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> {error}
        </p>
      </Solid>
    );
  }

  if (!accounts) {
    return (
      <Solid as="section" className="pad">
        <p className="muted">در حال بارگذاری کدینگ حساب…</p>
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
        <div className="acct-head">
          <div>
            <h2 style={{ marginTop: 0, marginBottom: "var(--s-1)" }}>کدینگ حساب</h2>
            <p className="muted small" style={{ margin: 0 }}>
              گروه ← کل ← معین ← تفصیلی. حساب حذف نمی‌شود، غیرفعال می‌شود — تا فردا
              کسی دنبال کدی نگردد که ناپدید شده.
            </p>
          </div>
          <label className="acct-toggle">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            <span>غیرفعال‌ها هم دیده شوند</span>
          </label>
        </div>

        <ul className="acct-tree">
          {rows.map((a) => {
            const depth = a.level === "group" ? 0 : a.level === "kol" ? 1 : a.level === "moin" ? 2 : 3;
            const next = childLevel(a.level);
            return (
              <li key={a.code} className={a.isActive ? "" : "acct-off"}>
                {editing === a.code ? (
                  <AccountForm
                    account={a}
                    busy={busy}
                    onCancel={() => setEditing(null)}
                    onSave={(input) => void save(a.code, input)}
                  />
                ) : (
                  <div className="acct-row" style={{ paddingInlineStart: `${depth * 20}px` }}>
                    <span className="num acct-code">{a.code}</span>
                    <span className="acct-name">{a.name}</span>
                    <span className="muted small acct-meta">
                      {LEVEL_LABEL[a.level]} · {TYPE_LABEL[a.type]} · {NATURE_LABEL[a.nature]}
                      {a.isPostable ? " · قابل ثبت" : ""}
                      {a.hasEntries ? " · سند خورده" : ""}
                    </span>
                    <span className="acct-actions">
                      <button type="button" onClick={() => setEditing(a.code)} disabled={busy}>
                        ویرایش
                      </button>
                      {next ? (
                        <button
                          type="button"
                          onClick={() =>
                            setAdding({
                              code: a.code,
                              parentCode: a.code,
                              name: "",
                              level: next,
                              nature: a.nature,
                              type: a.type,
                              isPostable: next === "tafsili",
                              isActive: true,
                              hasChildren: false,
                              hasEntries: false,
                            })
                          }
                          disabled={busy}
                          title={`افزودن ${LEVEL_LABEL[next]} زیر این حساب`}
                        >
                          + {LEVEL_LABEL[next]}
                        </button>
                      ) : null}
                      <button type="button" onClick={() => void toggleActive(a)} disabled={busy}>
                        {a.isActive ? "غیرفعال" : "فعال"}
                      </button>
                    </span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {adding ? (
          <NewAccountForm
            parent={adding}
            busy={busy}
            onCancel={() => setAdding(null)}
            onSave={(code, input) => void save(code, input)}
          />
        ) : (
          <button
            type="button"
            className="acct-add-root"
            onClick={() =>
              setAdding({
                code: "",
                parentCode: null,
                name: "",
                level: "group",
                nature: "debit",
                type: "asset",
                isPostable: false,
                isActive: true,
                hasChildren: false,
                hasEntries: false,
              })
            }
            disabled={busy}
          >
            + گروه تازه
          </button>
        )}
      </Solid>
    </div>
  );
}

/** ویرایش حساب موجود — کد عوض نمی‌شود، چون کد هویت سند است. */
function AccountForm(props: {
  account: Account;
  busy: boolean;
  onCancel: () => void;
  onSave: (input: AccountInput) => void;
}) {
  const { account: a, busy } = props;
  const [name, setName] = useState(a.name);
  const [nature, setNature] = useState<AccountNature>(a.nature);
  const [type, setType] = useState<AccountType>(a.type);
  const [postable, setPostable] = useState(a.isPostable);

  // دیتابیس این دو را رد می‌کند؛ صفحه **پیش از کلیک** می‌گویدشان.
  const natureLocked = a.hasEntries;
  const postableLocked = a.hasChildren;

  return (
    <form
      className="acct-form"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSave({
          name,
          level: a.level,
          parentCode: a.parentCode,
          nature,
          type,
          isPostable: postable,
        });
      }}
    >
      <span className="num acct-code">{a.code}</span>
      <label>
        <span className="sr-only">نام حساب</span>
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label>
        <span className="sr-only">ماهیت</span>
        <select
          value={nature}
          onChange={(e) => setNature(e.target.value as AccountNature)}
          disabled={natureLocked}
        >
          {(Object.keys(NATURE_LABEL) as AccountNature[]).map((k) => (
            <option key={k} value={k}>
              {NATURE_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="sr-only">نوع</span>
        <select
          value={type}
          onChange={(e) => setType(e.target.value as AccountType)}
          disabled={natureLocked}
        >
          {(Object.keys(TYPE_LABEL) as AccountType[]).map((k) => (
            <option key={k} value={k}>
              {TYPE_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="acct-check">
        <input
          type="checkbox"
          checked={postable}
          onChange={(e) => setPostable(e.target.checked)}
          disabled={postableLocked}
        />
        <span>قابل ثبت</span>
      </label>
      <span className="acct-actions">
        <button type="submit" disabled={busy}>
          ذخیره
        </button>
        <button type="button" onClick={props.onCancel} disabled={busy}>
          انصراف
        </button>
      </span>
      {natureLocked ? (
        <p className="muted small acct-hint">
          این حساب سند خورده، پس ماهیت و نوعش قفل است — عوض‌کردنشان گزارش‌های
          گذشته را بی‌صدا تغییر می‌داد. برای ساختار تازه، حساب تازه بسازید.
        </p>
      ) : null}
      {postableLocked ? (
        <p className="muted small acct-hint">
          این حساب فرزند دارد، پس نمی‌تواند سند بپذیرد — وگرنه جمعش در گزارش
          سلسله‌مراتبی دو بار شمرده می‌شود.
        </p>
      ) : null}
    </form>
  );
}

/** حساب تازه — کد اینجا تایپ می‌شود و باید با کد والد شروع شود. */
function NewAccountForm(props: {
  parent: Account;
  busy: boolean;
  onCancel: () => void;
  onSave: (code: string, input: AccountInput) => void;
}) {
  const { parent, busy } = props;
  const isRoot = parent.parentCode === null && parent.code === "";
  const level: AccountLevel = isRoot ? "group" : parent.level;
  const [code, setCode] = useState(isRoot ? "" : parent.code);
  const [name, setName] = useState("");
  const [nature, setNature] = useState<AccountNature>(parent.nature);
  const [type, setType] = useState<AccountType>(parent.type);
  const [postable, setPostable] = useState(parent.isPostable);

  return (
    <form
      className="acct-form acct-new"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSave(code.trim(), {
          name,
          level,
          parentCode: isRoot ? null : parent.parentCode,
          nature,
          type,
          isPostable: postable,
        });
      }}
    >
      <label>
        <span className="sr-only">کد حساب</span>
        {/* type="text" نه number: صفحه‌کلید فارسی «۱۱۰۱» می‌فرستد و
            ورودی عددی مرورگر آن را دور می‌اندازد. */}
        <input
          className="num"
          type="text"
          inputMode="numeric"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={isRoot ? "کد گروه" : `${parent.parentCode ?? ""}…`}
          required
        />
      </label>
      <label>
        <span className="sr-only">نام حساب</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="نام حساب" required />
      </label>
      <label>
        <span className="sr-only">ماهیت</span>
        <select value={nature} onChange={(e) => setNature(e.target.value as AccountNature)}>
          {(Object.keys(NATURE_LABEL) as AccountNature[]).map((k) => (
            <option key={k} value={k}>
              {NATURE_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="sr-only">نوع</span>
        <select value={type} onChange={(e) => setType(e.target.value as AccountType)}>
          {(Object.keys(TYPE_LABEL) as AccountType[]).map((k) => (
            <option key={k} value={k}>
              {TYPE_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="acct-check">
        <input
          type="checkbox"
          checked={postable}
          onChange={(e) => setPostable(e.target.checked)}
        />
        <span>قابل ثبت</span>
      </label>
      <span className="acct-actions">
        <button type="submit" disabled={busy}>
          افزودن {LEVEL_LABEL[level]}
        </button>
        <button type="button" onClick={props.onCancel} disabled={busy}>
          انصراف
        </button>
      </span>
      <p className="muted small acct-hint">
        کد باید با کد والد شروع شود و بلندتر باشد — همان قاعده‌ای که گزارش
        سلسله‌مراتبی رویش بنا شده.
      </p>
    </form>
  );
}
