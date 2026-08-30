/**
 * پوسته برنامه — و جایی که «ناحیه‌بندی» ADR-002 دیده می‌شود.
 *
 * دو نما با دو قاعده متفاوت، در یک برنامه:
 *   داشبورد  شیشه کامل — خوانده می‌شود، عجله‌ای نیست
 *   صندوق    مات — عمل می‌شود، زیر نور فروشگاه، با صف پشت سر
 *
 * همین کنار هم بودن، دلیل ناحیه‌بندی را نشان می‌دهد بهتر از هر سندی.
 */
import { useEffect, useState } from "react";
import { Glass, GlassFilters } from "./components/Glass.tsx";
import { Dashboard } from "./screens/Dashboard.tsx";
import { Pos } from "./screens/Pos.tsx";
import { Settings } from "./screens/Settings.tsx";
import {
  getPerf,
  getTheme,
  glassIsOff,
  setPerf,
  setTheme,
  type Perf,
  type Theme,
} from "./lib/theme.ts";

type Zone = "dashboard" | "pos" | "settings";

/**
 * چرا هر ناحیه این‌قدر شیشه دارد — ADR-002، به زبان خودِ صفحه.
 *
 * تنظیمات ناحیه «متوسط» است: کارت گروه شیشه‌ای، ولی هر ورودی فرم مات.
 * عددی که تایپ می‌شود باید پرتضاد باشد، حتی وقتی عجله‌ای در کار نیست.
 */
const ZONE_NOTE: Record<Zone, string> = {
  dashboard: "این ناحیه شیشه کامل دارد — خوانده می‌شود، نه عمل.",
  pos: "این ناحیه عمداً مات است — زیر نور فروشگاه باید در کسری از ثانیه خوانده شود.",
  settings: "شیشه فقط روی کارت گروه — ورودی‌ها مات‌اند تا عدد و دکمه پرتضاد بمانند.",
};

export function App() {
  const [zone, setZone] = useState<Zone>("dashboard");
  const [theme, setThemeState] = useState<Theme>("system");
  const [perf, setPerfState] = useState<Perf>("system");
  const [glassOff, setGlassOff] = useState(false);

  // ترجیح‌ها فقط در مرورگر خوانده می‌شوند، پس بعد از Mount.
  useEffect(() => {
    setThemeState(getTheme());
    setPerfState(getPerf());
    setGlassOff(glassIsOff());
  }, []);

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
              aria-selected={zone === "settings"}
              className={zone === "settings" ? "on" : ""}
              onClick={() => switchZone("settings")}
            >
              تنظیمات
            </button>
          </div>

          <div className="tools">
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
          {zone === "dashboard" ? <Dashboard /> : zone === "pos" ? <Pos /> : <Settings />}
        </main>

        <p className="zone-note">{ZONE_NOTE[zone]}</p>
      </div>
    </>
  );
}
