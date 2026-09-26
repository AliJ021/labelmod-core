/** پوسته: ناوبری شیشه‌ای، محتوای مالی مات و دسترس‌پذیر. */
import { useCallback, useEffect, useState } from "react";
import { Glass, GlassFilters, Solid } from "./components/Glass.tsx";
import { TabList, TabPanels, useTabsId } from "./components/Tabs.tsx";
import { HeaderTools } from "./components/HeaderTools.tsx";
import { PasswordDialog } from "./components/PasswordDialog.tsx";
import { Dashboard } from "./screens/Dashboard.tsx";
import { Login, LockScreen, ReauthPanel } from "./screens/Login.tsx";
import { Pos } from "./screens/Pos.tsx";
import { Catalog } from "./screens/Catalog.tsx";
import { Customers } from "./screens/Customers.tsx";
import { Reports } from "./screens/Reports.tsx";
import { Treasury } from "./screens/Treasury.tsx";
import { Warehouse } from "./screens/Warehouse.tsx";
import { Returns } from "./screens/Returns.tsx";
import { Settings } from "./screens/Settings.tsx";
import { TwoFactor } from "./screens/TwoFactor.tsx";
import {
  authView,
  forgetLock,
  readLockedUser,
  rememberLock,
  session,
  type Me,
} from "./lib/session.ts";
import {
  getTheme,
  setTheme,
  type Theme,
} from "./lib/theme.ts";

type Zone =
  | "dashboard"
  | "pos"
  | "returns"
  | "catalog"
  | "purchasing"
  | "treasury"
  | "reports"
  | "customers"
  | "settings";

const ZONES = [
  { key: "dashboard", label: "داشبورد" }, { key: "pos", label: "صندوق" },
  { key: "returns", label: "مرجوعی" }, { key: "catalog", label: "کالا و قیمت" },
  { key: "purchasing", label: "انبار و خرید" }, { key: "treasury", label: "خزانه و چک" },
  { key: "customers", label: "مشتریان" }, { key: "reports", label: "گزارش‌ها" },
  { key: "settings", label: "تنظیمات" },
] as const;

export function App() {
  const tabsId = useTabsId();
  const [zone, setZone] = useState<Zone>("dashboard");
  const [theme, setThemeState] = useState<Theme>("system");
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [loginNotice, setLoginNotice] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);

  const [me, setMe] = useState<Me | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [lockedUser, setLockedUser] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);

  // ترجیح‌ها فقط در مرورگر خوانده می‌شوند، پس بعد از Mount.
  useEffect(() => {
    setThemeState(getTheme());
    setLockedUser(readLockedUser());
  }, []);

  /**
   * «کی هستم؟» از سرور.
   *
   * پاسخ تهی یعنی یا وارد نشده یا قفل — سرور این دو را از هم جدا
   * نمی‌کند (دلیلش در `lib/session.ts`). یادداشت محلیِ قفل تصمیم
   * می‌گیرد کدام صفحه دیده شود، و نشستِ زنده همیشه بر آن می‌چربد.
   */
  const refresh = useCallback(async () => {
    try {
      const who = await session.me();
      setMe(who);
      if (who) {
        setLoginNotice(null);
        forgetLock();
        setLockedUser(null);
      }
    } catch {
      // سرور در دسترس نیست. نشست را معتبر فرض نمی‌کنیم — فرم ورود
      // بی‌ضررترین حالت است.
      setMe(null);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function lockScreen() {
    if (!me || sessionBusy) return;
    const name = me.fullName;
    setSessionBusy(true); setSessionError(null);
    try {
      const result = await session.lock();
      if (result?.locked !== true) throw new Error("lock not confirmed");
      rememberLock(name);
      setLockedUser(name);
      setMe(null);
    } catch { setSessionError("قفل‌شدن نشست در سرور تأیید نشد. دوباره قفل را بزنید و تا تأیید، دستگاه را ترک نکنید."); }
    finally { setSessionBusy(false); }
  }

  async function signOut() {
    if (sessionBusy) return;
    setSessionBusy(true); setSessionError(null);
    try {
      const result = await session.logout();
      if (result?.ok !== true) throw new Error("logout not confirmed");
      forgetLock();
      setLockedUser(null);
      setMe(null);
      setZone("dashboard");
    } catch { setSessionError("خروج در سرور تأیید نشد. دوباره خروج را بزنید و تا تأیید، دستگاه را ترک نکنید."); }
    finally { setSessionBusy(false); }
  }

  /** از صفحه قفل به فرم ورود — شیفت عوض شده. */
  function switchUser() {
    forgetLock();
    setLockedUser(null);
    setMe(null);
  }

  const view = authView({ loaded, me, lockedUser });

  if (view === "loading") {
    return (
      <>
        <GlassFilters />
        <div className="mesh" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <div className="auth-wrap">
          <p className="muted">در حال بررسی نشست…</p>
        </div>
      </>
    );
  }

  if (view === "ready" && upgrading) {
    return (
      <>
        <GlassFilters />
        <div className="mesh" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <ReauthPanel
          onDone={() => {
            setUpgrading(false);
            void refresh();
          }}
          onCancel={() => setUpgrading(false)}
        />
      </>
    );
  }

  if (view !== "ready") {
    return (
      <>
        <GlassFilters />
        <div className="mesh" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        {view === "locked" && lockedUser !== null ? (
          <LockScreen
            fullName={lockedUser}
            onUnlocked={() => void refresh()}
            onSwitchUser={switchUser}
          />
        ) : (
          <>
            {loginNotice ? <p className="session-notice solid" role="status">{loginNotice}</p> : null}
            <Login onDone={() => void refresh()} />
          </>
        )}
      </>
    );
  }

  // نشست راه‌اندازی هیچ بخش دیگری را باز نمی‌کند. این نمای مستقل
  // تضمین می‌کند کاربر بدون عبور از مسیرهای مسدودشده بتواند عامل دوم
  // را ثبت کند.
  if (me?.enrollmentRequired) {
    return (
      <>
        <GlassFilters />
        <div className="mesh" aria-hidden="true"><i /><i /><i /></div>
        <main className="auth-wrap">
          <Solid className="pad auth-card">
            <h1 className="auth-title">راه‌اندازی احراز هویت دومرحله‌ای</h1>
            <p className="muted">برای دسترسی به حساب، ابتدا یک عامل دوم ثبت کنید.</p>
            <TwoFactor onEnrolled={() => void refresh()} />
            {sessionError && <p className="auth-error" role="alert">{sessionError}</p>}
            <button type="button" className="btn" onClick={() => void signOut()}>خروج</button>
          </Solid>
        </main>
      </>
    );
  }

  function switchZone(next: Zone) {
    setZone(next);
  }

  function cycleTheme() {
    const next: Theme =
      theme === "system" ? "light" : theme === "light" ? "dark" : "system";
    setTheme(next);
    setThemeState(next);
  }


  return (
    <>
      <GlassFilters />
      {/* مِش زمینه: چیزی که شیشه باید بشکندش. روی زمینه تخت، شیشه دیده نمی‌شود. */}
      <div className="mesh" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>

      <div className="app">
        {sessionError && <p className="solid pos-alert" role="alert">{sessionError}</p>}
        <Glass as="nav" radius="md" className="topbar" refract={false} live>
          <strong className="brand">لیبل مد</strong>

          <TabList id={tabsId} items={ZONES} value={zone} onChange={switchZone} label="بخش‌ها" className="zones" />

          {me ? <HeaderTools me={me} theme={theme} onTheme={cycleTheme} onLock={() => void lockScreen()} onLogout={() => void signOut()} onPassword={() => setPasswordOpen(true)} onReauth={() => setUpgrading(true)} /> : null}
        </Glass>

        <main>
        <TabPanels id={tabsId} items={ZONES} value={zone} className="zone-panel">
          {zone === "dashboard" ? (
            <Dashboard />
          ) : zone === "pos" ? (
            <Pos />
          ) : zone === "returns" ? (
            <Returns />
          ) : zone === "catalog" ? (
            <Catalog />
          ) : zone === "purchasing" ? (
            <Warehouse />
          ) : zone === "treasury" ? (
            <Treasury />
          ) : zone === "reports" ? (
            <Reports />
          ) : zone === "customers" ? (
            <Customers />
          ) : (
            <Settings currentUserId={me?.id ?? ""} onOwnPassword={() => setPasswordOpen(true)} />
          )}
        </TabPanels>
        </main>

        {passwordOpen && me ? <PasswordDialog name={me.fullName} own onCancel={() => setPasswordOpen(false)} onApply={async (password, currentPassword) => {
          await session.changePassword(currentPassword, password);
          setPasswordOpen(false);
          forgetLock();
          setLockedUser(null);
          setMe(null);
          setZone("dashboard");
          setLoginNotice("رمز شما تغییر کرد و همهٔ نشست‌ها بسته شدند. با رمز تازه وارد شوید.");
        }} /> : null}
      </div>
    </>
  );
}
