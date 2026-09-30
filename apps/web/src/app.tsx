const Invoices = lazy(() => import("./screens/Invoices.tsx").then(m => ({ default: m.Invoices })));
/** پوسته: ناوبری شیشه‌ای، محتوای مالی مات و دسترس‌پذیر. */
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { GlassFilters, Solid } from "./components/Glass.tsx";
import { TabPanels, useTabsId } from "./components/Tabs.tsx";
import { HeaderTools } from "./components/HeaderTools.tsx";
import { PasswordDialog } from "./components/PasswordDialog.tsx";
const Dashboard = lazy(() => import("./screens/Dashboard.tsx").then(m => ({ default: m.Dashboard })));
import { Login, LockScreen, ReauthPanel } from "./screens/Login.tsx";
const Pos = lazy(() => import("./screens/Pos.tsx").then(m => ({ default: m.Pos })));
const Catalog = lazy(() => import("./screens/Catalog.tsx").then(m => ({ default: m.Catalog })));
const Customers = lazy(() => import("./screens/Customers.tsx").then(m => ({ default: m.Customers })));
const Reports = lazy(() => import("./screens/Reports.tsx").then(m => ({ default: m.Reports })));
const Treasury = lazy(() => import("./screens/Treasury.tsx").then(m => ({ default: m.Treasury })));
const Warehouse = lazy(() => import("./screens/Warehouse.tsx").then(m => ({ default: m.Warehouse })));
const Returns = lazy(() => import("./screens/Returns.tsx").then(m => ({ default: m.Returns })));
const Settings = lazy(() => import("./screens/Settings.tsx").then(m => ({ default: m.Settings })));
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

import { ZONES, pendingZones, routeUrl, type Zone, visibleZones } from "./lib/navigation.ts";
import { navigate, usePathname, useUrlTab } from "./lib/use-url-state.ts";
import { useMediaQuery } from "./lib/use-media-query.ts";
import { useNavAccess } from "./lib/use-nav-access.ts";
import { SectionBoundary } from "./components/SectionBoundary.tsx";
import { Backdrop } from "./components/shell/Backdrop.tsx";
import { ShellHeader } from "./components/shell/ShellHeader.tsx";
import { ShellNav } from "./components/shell/ShellNav.tsx";
import { ToastProvider } from "./components/ui/Toast.tsx";

/**
 * UI Kit فقط در توسعه و در Build صریحِ آزمون/پیش‌نمایش (`VITE_LMC_UI_KIT=1`).
 * در Build تولیدی این شاخه ثابتِ `false` است و import پویا از Bundle حذف
 * می‌شود؛ CI همین را روی dist می‌سنجد. داخل پوستهٔ واردشده رندر می‌شود،
 * پس بدون نشست دیده نمی‌شود.
 */
const UI_KIT_ENABLED = import.meta.env.DEV || import.meta.env.VITE_LMC_UI_KIT === "1";
const UiKit = UI_KIT_ENABLED ? lazy(() => import("./screens/dev/UiKit.tsx").then(m => ({ default: m.UiKit }))) : null;

export function App() {
  const tabsId = useTabsId();
  const [zone, setZone] = useUrlTab("page", ZONES, "dashboard");
  const pathname = usePathname();
  const [more, setMore] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setKeyboard(viewport.scale === 1 && viewport.height < window.innerHeight * .75);
    viewport.addEventListener("resize", update); update();
    return () => viewport.removeEventListener("resize", update);
  }, []);
  const compact = useMediaQuery("(max-width: 899px)");
  const [theme, setThemeState] = useState<Theme>("system");
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [loginNotice, setLoginNotice] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);

  const [me, setMe] = useState<Me | null>(null);
  // بی نشست کامل (ورود، قفل، ثبت اجباری عامل دوم) هیچ پرسش مجوزی فرستاده نمی‌شود:
  // درخواستی پس از قفل همان چیزی است که داشبورد هم از آن پرهیز می‌کند.
  const access = useNavAccess(me && !me.enrollmentRequired ? `${me.id}:${me.elevated}` : null);
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
      toDashboardAfterSessionEnd();
    } catch { setSessionError("خروج در سرور تأیید نشد. دوباره خروج را بزنید و تا تأیید، دستگاه را ترک نکنید."); }
    finally { setSessionBusy(false); }
  }

  /**
   * پس از بسته‌شدن نشست (خروج، تغییر رمز) پوسته همین حالا Unmount می‌شود و
   * پیش‌نویسی برای نگه‌داشتن نمانده؛ پس نگهبان ترک صفحه دور زده می‌شود
   * (`force`). همان کار `setZone("dashboard")`: فقط `page` حذف می‌شود.
   */
  function toDashboardAfterSessionEnd() {
    const url = new URL(window.location.href);
    url.searchParams.delete("page");
    navigate(url.href, false, true);
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
        <Backdrop variant="auth" />
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
        <Backdrop variant="auth" />
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
        <Backdrop variant="auth" />
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
        <Backdrop variant="auth" />
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
    // فوکوسِ زمان‌بندی‌شده فقط وقتی به محتوا می‌رود که کسی در این فاصله فوکوس تازه‌ای نگذاشته باشد:
    // frame دیرهنگام نباید فوکوسی را که کاربر روی زیرزبانه یا کنترل دیگری برده، پس بگیرد.
    const origin = document.activeElement;
    // از /dev/ui-kit برگشت به مسیر ریشه؛ بقیهٔ وضعیت نشانی همان useUrlTab است.
    if (window.location.pathname !== "/") navigate(routeUrl(next)); else setZone(next);
    setMore(false);
    requestAnimationFrame(() => {
      const now = document.activeElement;
      if (now === origin || now === null || now === document.body) {
        document.getElementById("workspace-content")?.focus({preventScroll:true});
      }
    });
  }

  function cycleTheme() {
    const next: Theme =
      theme === "system" ? "light" : theme === "light" ? "dark" : "system";
    setTheme(next);
    setThemeState(next);
  }


  const navItems = visibleZones(access.verdicts, zone);
  const pendingItems = pendingZones(access, zone);
  const uiKit = UiKit !== null && pathname === "/dev/ui-kit";

  return (
    <ToastProvider>
      <GlassFilters />
      <Backdrop variant="workspace" />

      <div className={`app workspace${more ? " workspace--more" : ""}${keyboard ? " workspace--keyboard" : ""}`}>
        <a className="skip-content" href="#workspace-content">رفتن به محتوا</a>
        {sessionError && <p className="solid pos-alert" role="alert">{sessionError}</p>}
        <ShellHeader searchKey={`${me?.id}:${me?.elevated}`} tools={me ? <HeaderTools me={me} theme={theme} onTheme={cycleTheme} onLock={() => void lockScreen()} onLogout={() => void signOut()} onPassword={() => setPasswordOpen(true)} onReauth={() => setUpgrading(true)} /> : null} />

        <ShellNav id={tabsId} items={navItems} pending={pendingItems} access={access.state} onRetry={access.retry} zone={zone} onZone={switchZone} compact={compact} more={more} onMore={setMore} />
        <main id="workspace-content" tabIndex={-1}>
        {uiKit && UiKit ? <SectionBoundary key="ui-kit"><Suspense fallback={<p className="solid pad" role="status">در حال بارگذاری UI Kit…</p>}><UiKit /></Suspense></SectionBoundary> : null}
        <SectionBoundary key={`${me?.id}:${zone}`}>
        {/* Suspense داخل پنل است، نه دور همهٔ پنل‌ها: هنگام بارگذاری یک بخش،
            هر tabpanel باید بماند تا aria-controls هیچ زبانه‌ای به شناسهٔ ناموجود اشاره نکند. */}
        <TabPanels id={tabsId} items={ZONES} value={uiKit ? null : zone} className="zone-panel">
        <Suspense fallback={<p className="solid pad" role="status">در حال بارگذاری بخش…</p>}>
          {zone === "dashboard" ? (
            <Dashboard access={access} />
          ) : zone === "pos" ? (
            <Pos key={me?.id} actorId={me?.id ?? ""} />
          ) : zone === "invoices" ? (
            <Invoices />
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
            <Settings access={access} currentUserId={me?.id ?? ""} onOwnPassword={() => setPasswordOpen(true)} />
          )}
        </Suspense>
        </TabPanels>
        </SectionBoundary>
        </main>

        {passwordOpen && me ? <PasswordDialog name={me.fullName} own onCancel={() => setPasswordOpen(false)} onApply={async (password, currentPassword) => {
          await session.changePassword(currentPassword, password);
          setPasswordOpen(false);
          forgetLock();
          setLockedUser(null);
          setMe(null);
          toDashboardAfterSessionEnd();
          setLoginNotice("رمز شما تغییر کرد و همهٔ نشست‌ها بسته شدند. با رمز تازه وارد شوید.");
        }} /> : null}
      </div>
    </ToastProvider>
  );
}
