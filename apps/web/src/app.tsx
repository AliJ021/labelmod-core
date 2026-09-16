/**
 * پوسته برنامه — و جایی که «ناحیه‌بندی» ADR-002 دیده می‌شود.
 *
 * دو نما با دو قاعده متفاوت، در یک برنامه:
 *   داشبورد  شیشه کامل — خوانده می‌شود، عجله‌ای نیست
 *   صندوق    مات — عمل می‌شود، زیر نور فروشگاه، با صف پشت سر
 *
 * همین کنار هم بودن، دلیل ناحیه‌بندی را نشان می‌دهد بهتر از هر سندی.
 */
import { useCallback, useEffect, useState } from "react";
import { Glass, GlassFilters } from "./components/Glass.tsx";
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

export function App() {
  const [zone, setZone] = useState<Zone>("dashboard");
  const [theme, setThemeState] = useState<Theme>("system");
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [loginNotice, setLoginNotice] = useState<string | null>(null);

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
    if (!me) return;
    const name = me.fullName;
    try {
      await session.lock();
    } finally {
      // حتی اگر تماس شکست خورد، نشان‌دادن صفحه قفل امن‌ترین کار است.
      rememberLock(name);
      setLockedUser(name);
      setMe(null);
    }
  }

  async function signOut() {
    try {
      await session.logout();
    } finally {
      forgetLock();
      setLockedUser(null);
      setMe(null);
      setZone("dashboard");
    }
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

  function switchZone(next: Zone) {
    // گذار سیال میان نماها. اگر مرورگر پشتیبانی نکند، بی‌سروصدا
    // همان تغییر فوری اتفاق می‌افتد — نه خطا، نه صفحه سفید.
    const doc = document as Document & {
      startViewTransition?: (cb: () => void) => void;
    };
    if (typeof doc.startViewTransition === "function") {
      doc.startViewTransition(() => setZone(next));
    } else {
      setZone(next);
    }
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
        <Glass as="nav" radius="md" className="topbar" refract={false} live>
          <strong className="brand">لیبل مد</strong>

          <div className="zones" role="tablist" aria-label="بخش‌ها">
            <button
              type="button"
              role="tab"
              aria-selected={zone === "dashboard"}
              className={zone === "dashboard" ? "on" : ""}
              onClick={() => switchZone("dashboard")}
            >
              داشبورد
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={zone === "pos"}
              className={zone === "pos" ? "on" : ""}
              onClick={() => switchZone("pos")}
            >
              صندوق
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={zone === "returns"}
              className={zone === "returns" ? "on" : ""}
              onClick={() => switchZone("returns")}
            >
              مرجوعی
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={zone === "catalog"}
              className={zone === "catalog" ? "on" : ""}
              onClick={() => switchZone("catalog")}
            >
              کالا و قیمت
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={zone === "purchasing"}
              className={zone === "purchasing" ? "on" : ""}
              onClick={() => switchZone("purchasing")}
            >
              انبار و خرید
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={zone === "treasury"}
              className={zone === "treasury" ? "on" : ""}
              onClick={() => switchZone("treasury")}
            >
              خزانه و چک
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={zone === "customers"}
              className={zone === "customers" ? "on" : ""}
              onClick={() => switchZone("customers")}
            >
              مشتریان
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={zone === "reports"}
              className={zone === "reports" ? "on" : ""}
              onClick={() => switchZone("reports")}
            >
              گزارش‌ها
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={zone === "settings"}
              className={zone === "settings" ? "on" : ""}
              onClick={() => switchZone("settings")}
            >
              تنظیمات
            </button>
          </div>

          {me ? <HeaderTools me={me} theme={theme} onTheme={cycleTheme} onLock={() => void lockScreen()} onLogout={() => void signOut()} onPassword={() => setPasswordOpen(true)} onReauth={() => setUpgrading(true)} /> : null}
        </Glass>

        <main style={{ viewTransitionName: "zone" }}>
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
