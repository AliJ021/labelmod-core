import { useUrlFlag, useNavigationGuard } from "../lib/use-url-state.ts";
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLatestQuery } from "../lib/use-latest-query.ts";
import { PageHeader } from "../components/ui/PageHeader.tsx";
import { Button, Field } from "../components/ui/Controls.tsx";
import { StatusBadge } from "../components/ui/Status.tsx";
import { Ltr } from "../components/ui/Bidi.tsx";
import { ResultState } from "../components/ResultState.tsx";
import "../styles/accounts-mapping.css";
import { Solid } from "../components/Glass.tsx";
import { session } from "../lib/session.ts";
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
  const [canEdit, setCanEdit] = useState<boolean | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void session.can("settings.security", {signal: controller.signal})
      .then(result => {if (!controller.signal.aborted) setCanEdit(result.verdict === "allow");})
      .catch(() => {if (!controller.signal.aborted) setCanEdit(false);});
    return () => controller.abort();
  }, []);
  const working = useRef(false);
  const [needsRead, setNeedsRead] = useState(false);
  const [version, refresh] = useState(0);
  const [showInactive, setShowInactive] = useUrlFlag("accounts.inactive");

  const load = useCallback((signal: AbortSignal) => admin.accounts(signal), []);
  const query = useLatestQuery({key: "accounts", version, load});
  useEffect(() => {if(query.data){setAccounts(query.data.accounts);setNeedsRead(false);setError(null);}}, [query.data]);
  const blocked = canEdit !== true || busy || query.loading || !!query.error || needsRead;
  const formOpen = editing !== null || adding !== null;

  const rows = useMemo(() => {
    if (!accounts) return [];
    const tree = sortTree(accounts);
    return showInactive ? tree : tree.filter((a) => a.isActive);
  }, [accounts, showInactive]);

  async function reload() {
    try {
      setAccounts((await admin.accounts()).accounts);
    } catch (e) {
      // The write already succeeded; any failed read leaves its displayed result unverified.
      setNeedsRead(true);
      throw e;
    }
  }

  async function guarded(fn: () => Promise<void>) {
    if (working.current || blocked) return;
    working.current = true;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch (e: unknown) {
      setError(message(e));
      if (!(e instanceof ApiError) || e.status >= 500) setNeedsRead(true);
    } finally {
      working.current = false;
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

  return (
    <div className="account-workspace">
      <PageHeader title="کدینگ حساب" context="گروه ← کل ← معین ← تفصیلی؛ حساب‌ها حذف نمی‌شوند و سابقهٔ آن‌ها باقی می‌ماند."
        actions={<Button disabled={query.loading || busy} onClick={() => refresh(v => v + 1)}>بررسی دوباره</Button>} />
      {canEdit === false && <p className="muted small">فقط مشاهده؛ دسترسی ثبت تغییرات تأیید نشده است.</p>}
      {query.error ? <ResultState kind="error" title={message(query.error)} description={accounts ? "فهرست از آخرین پاسخ است؛ تا خواندن موفق، تغییرات ثبت نمی‌شوند." : "برای دریافت فهرست دوباره تلاش کنید."}
        actionLabel="تلاش دوباره" onAction={() => refresh(v => v + 1)} /> : null}
      {needsRead ? <p className="solid pad" role="alert">نتیجهٔ ذخیره هنوز روشن نیست؛ پیش از هر تغییر تازه، «بررسی دوباره» را بزنید و مقدار ثبت‌شده را بررسی کنید.</p> : null}
      {query.loading ? <p role="status" className="muted">در حال بارگذاری کدینگ حساب…</p> : null}
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

      {accounts && <Solid as="section" className="pad">
        <div className="acct-head">
          <div>
            <h2 className="section-title">فهرست حساب‌ها</h2>
            <p className="muted small" style={{ margin: 0 }}>
              گروه ← کل ← معین ← تفصیلی. حساب حذف نمی‌شود، غیرفعال می‌شود — تا فردا
              کسی دنبال کدی نگردد که ناپدید شده.
            </p>
          </div>
          <label className="acct-toggle">
            <input
              type="checkbox"
              checked={showInactive}
              disabled={formOpen}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            <span>غیرفعال‌ها هم دیده شوند</span>
          </label>
        </div>

        {formOpen && <p className="field-hint">ابتدا ویرایش باز را ذخیره یا لغو کنید؛ سپس حساب دیگری را تغییر دهید.</p>}
        {!rows.length && <ResultState title="حسابی برای نمایش وجود ندارد." />}
        <ul className="acct-tree">
          {rows.map((a) => {
            const depth = a.level === "group" ? 0 : a.level === "kol" ? 1 : a.level === "moin" ? 2 : 3;
            const next = childLevel(a.level);
            return (
              <li key={a.code} className={a.isActive ? "" : "acct-off"}>
                {editing === a.code ? (
                  <AccountForm
                    account={a}
                    busy={blocked}
                    onCancel={() => setEditing(null)}
                    onSave={(input) => void save(a.code, input)}
                  />
                ) : (
                  <div className="acct-row" style={{ paddingInlineStart: `${depth * 20}px` }}>
                    <span className="acct-code"><Ltr>{a.code}</Ltr></span>
                    <span className="acct-name">{a.name}</span>
                    <span className="muted small acct-meta">
                      {LEVEL_LABEL[a.level]} · {TYPE_LABEL[a.type]} · {NATURE_LABEL[a.nature]}
                    </span>
                    <StatusBadge state={!a.isActive ? "archived" : a.hasEntries ? "active" : "draft"} label={!a.isActive ? "غیرفعال" : a.hasEntries ? "دارای سند" : a.isPostable ? "قابل ثبت" : "حساب مادر"} />
                    <span className="account-actions">
                      <Button type="button" onClick={() => setEditing(a.code)} disabled={blocked || formOpen}>
                        ویرایش
                      </Button>
                      {next ? (
                        <Button
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
                          disabled={blocked || formOpen}
                          title={`افزودن ${LEVEL_LABEL[next]} زیر این حساب`}
                        >
                          + {LEVEL_LABEL[next]}
                        </Button>
                      ) : null}
                      <Button type="button" onClick={() => void toggleActive(a)} disabled={blocked || formOpen}>
                        {a.isActive ? "غیرفعال" : "فعال"}
                      </Button>
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
            busy={blocked}
            onCancel={() => setAdding(null)}
            onSave={(code, input) => void save(code, input)}
          />
        ) : (
          <Button
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
            disabled={blocked || formOpen}
          >
            + گروه تازه
          </Button>
        )}
      </Solid>}
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
  const dirty = name !== a.name || nature !== a.nature || type !== a.type || postable !== a.isPostable;
  useNavigationGuard(dirty, "تغییرات حساب ذخیره نشده است. از این صفحه خارج می‌شوید؟");

  return (
    <form
      className="account-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
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
      <strong className="account-form-title">ویرایش حساب <Ltr>{a.code}</Ltr></strong>
      <Field label="نام حساب">
        <input value={name} onChange={(e) => setName(e.target.value)} required disabled={busy} />
      </Field>
      <Field label="ماهیت">
        <select
          value={nature}
          onChange={(e) => setNature(e.target.value as AccountNature)}
          disabled={busy || natureLocked}
        >
          {(Object.keys(NATURE_LABEL) as AccountNature[]).map((k) => (
            <option key={k} value={k}>
              {NATURE_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="نوع">
        <select
          value={type}
          onChange={(e) => setType(e.target.value as AccountType)}
          disabled={busy || natureLocked}
        >
          {(Object.keys(TYPE_LABEL) as AccountType[]).map((k) => (
            <option key={k} value={k}>
              {TYPE_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>
      <label className="acct-check">
        <input
          type="checkbox"
          checked={postable}
          onChange={(e) => setPostable(e.target.checked)}
          disabled={busy || postableLocked}
        />
        <span>قابل ثبت</span>
      </label>
      <span className="account-actions">
        <Button variant="primary" type="submit" disabled={busy}>
          ذخیره
        </Button>
        <Button type="button" onClick={() => {if(!dirty || window.confirm("تغییرات ذخیره نشده کنار گذاشته شود؟"))props.onCancel();}} disabled={busy}>
          انصراف
        </Button>
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
  const dirty = code !== (isRoot ? "" : parent.code) || name !== "" || nature !== parent.nature || type !== parent.type || postable !== parent.isPostable;
  useNavigationGuard(dirty, "حساب تازه ذخیره نشده است. از این صفحه خارج می‌شوید؟");

  return (
    <form
      className="account-form acct-new"
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
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
      <Field label="کد حساب">
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
          disabled={busy}
        />
      </Field>
      <Field label="نام حساب">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="نام حساب" required disabled={busy} />
      </Field>
      <Field label="ماهیت">
        <select disabled={busy} value={nature} onChange={(e) => setNature(e.target.value as AccountNature)}>
          {(Object.keys(NATURE_LABEL) as AccountNature[]).map((k) => (
            <option key={k} value={k}>
              {NATURE_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="نوع">
        <select disabled={busy} value={type} onChange={(e) => setType(e.target.value as AccountType)}>
          {(Object.keys(TYPE_LABEL) as AccountType[]).map((k) => (
            <option key={k} value={k}>
              {TYPE_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>
      <label className="acct-check">
        <input
          type="checkbox"
          checked={postable}
          disabled={busy}
          onChange={(e) => setPostable(e.target.checked)}
        />
        <span>قابل ثبت</span>
      </label>
      <span className="account-actions">
        <Button variant="primary" type="submit" disabled={busy}>
          افزودن {LEVEL_LABEL[level]}
        </Button>
        <Button type="button" onClick={() => {if(!dirty || window.confirm("حساب ذخیره نشده کنار گذاشته شود؟"))props.onCancel();}} disabled={busy}>
          انصراف
        </Button>
      </span>
      <p className="muted small acct-hint">
        کد باید با کد والد شروع شود و بلندتر باشد — همان قاعده‌ای که گزارش
        سلسله‌مراتبی رویش بنا شده.
      </p>
    </form>
  );
}
