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
import { Dashboard } from "./screens/Dashboard.tsx";
import { Login, LockScreen, ReauthPanel } from "./screens/Login.tsx";
import { Pos } from "./screens/Pos.tsx";
import { Purchasing } from "./screens/Purchasing.tsx";
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
  getPerf,
  getTheme,
  glassIsOff,
  setPerf,
  setTheme,
  type Perf,
  type Theme,
} from "./lib/theme.ts";

type Zone = "dashboard" | "pos" | "returns" | "purchasing" | "settings";

/**
 * چرا هر ناحیه این‌قدر شیشه دارد — ADR-002، به زبان خودِ صفحه.
 *
 * تنظیمات ناحیه «متوسط» است: کارت گروه شیشه‌ای، ولی هر ورودی فرم مات.
 * عددی که تایپ می‌شود باید پرتضاد باشد، حتی وقتی عجله‌ای در کار نیست.
 */
const ZONE_NOTE: Record<Zone, string> = {
  dashboard: "این ناحیه شیشه کامل دارد — خوانده می‌شود، نه عمل.",
  pos: "این ناحیه عمداً مات است — زیر نور فروشگاه باید در کسری از ثانیه خوانده شود.",
  returns: "ناحیه متوسط — کارت شیشه‌ای، ولی هر سطر و مبلغی که خوانده می‌شود مات.",
  purchasing:
    "ناحیه متوسط — کار انبار طولانی است و خستگی چشم مهم، پس عدد و سطر مات می‌مانند.",
  settings: "شیشه فقط روی کارت گروه — ورودی‌ها مات‌اند تا عدد و دکمه پرتضاد بمانند.",
};

export function App() {
  const [zone, setZone] = useState<Zone>("dashboard");
  const [theme, setThemeState] = useState<Theme>("system");
  const [perf, setPerfState] = useState<Perf>("system");
  const [glassOff, setGlassOff] = useState(false);

  const [me, setMe] = useState<Me | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [lockedUser, setLockedUser] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);

  // ترجیح‌ها فقط در مرورگر خوانده می‌شوند، پس بعد از Mount.
  useEffect(() => {
    setThemeState(getTheme());
    setPerfState(getPerf());
    setGlassOff(glassIsOff());
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
          <Login onDone={() => void refresh()} />
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

  function togglePerf() {
    const next: Perf = perf === "on" ? "off" : "on";
    setPerf(next);
    setPerfState(next);
    setGlassOff(glassIsOff());
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
              aria-selected={zone === "purchasing"}
              className={zone === "purchasing" ? "on" : ""}
              onClick={() => switchZone("purchasing")}
            >
              انبار و خرید
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

          <div className="tools">
            {/*
              «نشست با PIN باز شده» یک هشدار نیست، یک واقعیت است که
              صندوق‌دار باید ببیند: بازپرداخت و ابطال و تغییر قیمت تا
              احراز کامل مجدد بسته‌اند. اگر پنهانش کنیم، کاربر دکمه
              می‌زند و خطای سرور می‌گیرد بی‌آنکه بفهمد چرا.
            */}
            {me !== null && !me.elevated ? (
              <button
                type="button"
                className="tool"
                onClick={() => setUpgrading(true)}
                title="برای عملیات حساس، احراز هویت کامل لازم است — برای ارتقا کلیک کنید"
              >
                <span className="dot dot--warn" aria-hidden="true">●</span> نشست PIN
              </button>
            ) : null}
            <span className="tool" title={me?.roles.join("، ") ?? ""}>
              {me?.fullName}
            </span>
            <button type="button" onClick={() => void lockScreen()} className="tool">
              قفل صفحه
            </button>
            <button type="button" onClick={() => void signOut()} className="tool">
              خروج
            </button>
            <button type="button" onClick={cycleTheme} className="tool">
              {theme === "system" ? "تم: سیستم" : theme === "light" ? "تم: روشن" : "تم: تیره"}
            </button>
            <button
              type="button"
              onClick={togglePerf}
              className="tool"
              aria-pressed={glassOff}
              title="شیشه را خاموش می‌کند — برای دستگاه ضعیف یا راحتی چشم"
            >
              حالت عملکرد: {glassOff ? "روشن" : "خاموش"}
            </button>
          </div>
        </Glass>

        <main style={{ viewTransitionName: "zone" }}>
          {zone === "dashboard" ? (
            <Dashboard />
          ) : zone === "pos" ? (
            <Pos />
          ) : zone === "returns" ? (
            <Returns />
          ) : zone === "purchasing" ? (
            <Purchasing />
          ) : (
            <Settings />
          )}
        </main>

        <p className="zone-note">{ZONE_NOTE[zone]}</p>
      </div>
    </>
  );
}
