/**
 * نظام طراحی — قراردادهایی که بدون مرورگر سنجیده می‌شوند.
 *
 * هر ادعا اینجا از **خودِ منبع** خوانده می‌شود (tokens.css، ui.css،
 * رجیستری ناوبری)، نه از یک کپی. سنجش چیدمان واقعی کار
 * e2e/design-system.spec.ts است.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { FEATURES, NAV_GROUPS, NAV_ITEMS, NAV_OPERATIONS, ZONES, accessOf, pendingZones, visibleZones, type Verdict } from "../src/lib/navigation.ts";
import { SETTINGS_OPERATIONS, SETTINGS_SECTIONS, settingsView } from "../src/lib/settings-registry.ts";
import { channelLabel, formatCount, formatGregorian, formatJalali, formatMoney, formatPercent, formatQty, moneyParts } from "../src/lib/format.ts";
import { classifyFailure, mayConfirm } from "../src/lib/safe-action.ts";
import { ApiError } from "../src/lib/api.ts";
import { STATUS } from "../src/lib/status.ts";
import { isSearchShortcut } from "../src/lib/shortcuts.ts";
import { CHANNEL_LABEL } from "../src/lib/reports.ts";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join("/");
const TOKENS = read("styles/tokens.css");

function block(css: string, opener: string): string {
  const start = css.indexOf(opener);
  assert.ok(start >= 0, `بلوک ${opener} پیدا نشد`);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error(`بلوک ${opener} بسته نشد`);
}
function declarations(css: string): Map<string, string> {
  return new Map([...css.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m => [m[1] as string, (m[2] as string).trim()]));
}

describe("توکن‌ها", () => {
  test("هر ردهٔ الزامی توکن متمرکز دارد", () => {
    const required = [
      "--font-sans", "--font-num", "--text-md", "--text-2xl", "--leading-body", "--weight-semibold",
      "--s-1", "--s-8", "--touch", "--control-h", "--sidebar-w", "--r-sm", "--r-pill", "--border-w",
      "--surface-solid", "--surface-glass", "--surface-inverse", "--elev-1", "--elev-3",
      "--good", "--warn", "--crit", "--info", "--good-soft", "--fin-negative", "--fin-zero",
      "--chart-1", "--chart-2", "--focus-ring", "--cell-pad-block",
      "--dur-fast", "--dur-slow", "--ease-standard", "--move-md", "--glass-blur", "--glow-accent", "--accent-size-md",
    ];
    const missing = required.filter(t => !new RegExp(`${t}:`).test(TOKENS));
    assert.deepEqual(missing, []);
    assert.match(TOKENS, /\[data-density="compact"\]\s*\{[^}]*--control-h/);
  });

  test("Hex رنگ فقط در tokens.css است — لایهٔ کامپوننت از توکن می‌خواند", () => {
    // تنها استثنا: ماسک `linear-gradient(#000 0 0)` که رنگ نیست، شکل است.
    const hits: string[] = [];
    for (const f of walk(SRC).filter(f => /\.(css|tsx|ts)$/.test(f) && !f.endsWith("tokens.css"))) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        const cleaned = line.replace(/linear-gradient\(#000 0 0\)/g, "");
        if (/#[0-9a-fA-F]{3,8}\b/.test(cleaned) && !/^\s*(\*|\/\/|\/\*)/.test(line)) hits.push(`${rel(f)}:${i + 1}`);
      });
    }
    assert.deepEqual(hits, [], `Hex بیرون از tokens.css:\n${hits.join("\n")}`);
  });

  test("دو تعریف تم تیره یکسان‌اند", () => {
    const media = declarations(block(TOKENS, ':root:not([data-theme="light"])'));
    const explicit = declarations(block(TOKENS, ':root[data-theme="dark"]'));
    assert.ok(media.size > 20);
    assert.deepEqual([...media.entries()].sort(), [...explicit.entries()].sort());
  });

  test("کاهش حرکت همهٔ زمان‌ها و فاصله‌های حرکت را خنثی می‌کند", () => {
    const reduced = declarations(block(TOKENS, "@media (prefers-reduced-motion: reduce)"));
    for (const t of ["--dur-instant", "--dur-fast", "--dur-base", "--dur-slow"]) assert.equal(reduced.get(t), "1ms", t);
    for (const t of ["--move-sm", "--move-md", "--move-lg"]) assert.equal(reduced.get(t), "0px", t);
  });
});

describe("حرکت", () => {
  const sheets = ["styles/ui.css", "styles/workspace.css", "styles/glass.css", "styles/base.css"];
  test("هر keyframe فقط transform و opacity را حرکت می‌دهد", () => {
    const bad: string[] = [];
    for (const f of sheets) {
      const css = read(f);
      for (const m of css.matchAll(/@keyframes\s+([\w-]+)/g)) {
        const body = block(css.slice(m.index), `@keyframes ${m[1]}`);
        for (const d of body.matchAll(/([a-z-]+)\s*:/g)) if (!["transform", "opacity"].includes(d[1] as string)) bad.push(`${f} ${m[1]}: ${d[1]}`);
      }
    }
    assert.deepEqual(bad, []);
  });

  test("انیمیشن لایهٔ کامپوننت فقط زیر «حرکت مجاز» و بیرون از حالت عملکرد تعریف می‌شود", () => {
    for (const f of ["styles/ui.css", "styles/workspace.css"]) {
      const css = read(f);
      const allowed = [...css.matchAll(/@media \(prefers-reduced-motion: no-preference\)/g)].map(m => {
        const b = block(css.slice(m.index), "@media (prefers-reduced-motion: no-preference)");
        return [m.index, m.index + b.length] as const;
      });
      for (const m of css.matchAll(/animation:\s*(?!none)[^;]+;/g)) {
        assert.ok(allowed.some(([a, b]) => m.index > a && m.index < b), `${f}: انیمیشن بیرون از no-preference: ${m[0]}`);
      }
      for (const [a, b] of allowed) for (const line of css.slice(a, b).split("\n").filter(l => l.includes("animation:"))) {
        assert.match(line, /:root:not\(\[data-perf="on"\]\)/, `${f}: حالت عملکرد باید انیمیشن را بردارد: ${line.trim()}`);
      }
    }
  });

  test("زمینهٔ صفحه‌های داده ساکن است؛ فقط سطح ورود/قفل حرکت تزئینی دارد", () => {
    const glass = read("styles/glass.css");
    const motion = block(glass, "@media (prefers-reduced-motion: no-preference)");
    assert.doesNotMatch(motion, /\.mesh\s*>\s*i\s*\{/, "انیمیشن عمومی مِش برگشته است");
    assert.match(motion, /\.mesh--auth\s*>\s*i/);
    // تنها حرکت بی‌پایان لایهٔ کامپوننت، تپش Skeleton هنگام بارگذاری است.
    const endless = [...(read("styles/ui.css") + read("styles/workspace.css")).matchAll(/animation:[^;]*infinite[^;]*;/g)].map(m => m[0]);
    assert.deepEqual(endless.filter(a => !a.includes("lm-pulse")), []);
  });
});

describe("رجیستری ناوبری", () => {
  test("هیچ مسیری حذف نشده و هر مقصد گروه، آیکون و فهرست مجوز دارد", () => {
    assert.deepEqual(ZONES.map(z => z.key), ["dashboard", "pos", "invoices", "returns", "catalog", "purchasing", "treasury", "customers", "reports", "settings"]);
    const icons = read("components/Icon.tsx");
    for (const z of ZONES) {
      assert.ok(NAV_GROUPS.some(g => g.key === z.navGroup), z.key);
      assert.match(icons, new RegExp(`\\n  ${z.icon}: <`), `آیکون ${z.icon} در خانوادهٔ Icon نیست`);
    }
    assert.equal(NAV_ITEMS.length, ZONES.length);
    for (const g of NAV_GROUPS) assert.ok(NAV_ITEMS.some(i => i.group === g.label), `گروه خالی: ${g.label}`);
    // ترتیب نمایش گروه‌به‌گروه است، پس سرعنوان گروه یک بار کشیده می‌شود.
    const seen = NAV_ITEMS.map(i => i.group).filter((g, i, a) => a[i - 1] !== g);
    assert.equal(new Set(seen).size, seen.length);
  });

  test("نوار پایین موبایل همان چهار مقصد تأییدشده به‌علاوهٔ «بیشتر» است", () => {
    // تصمیم مالک، بازبینی بصری ۱: گزارش‌ها به برگهٔ «بیشتر» رفت و مسیرش حذف نشد.
    assert.deepEqual(ZONES.filter(z => z.mobilePrimary).map(z => z.key), ["dashboard", "pos", "invoices", "catalog"]);
    assert.ok(ZONES.some(z => z.key === "reports"));
  });

  test("نمایش مجوزدار محافظه‌کار است: فقط allow؛ نامعلوم و رد پنهان‌اند؛ بخش باز دیده می‌شود (F-110-01)", () => {
    const all = (v: Verdict) => new Map(NAV_OPERATIONS.map(op => [op, v] as const));
    const keys = (items: { key: string }[]) => items.map(z => z.key).sort();
    // پیش از پاسخ سرور (loading) و پس از خطای شبکه (degraded) نقشه خالی یا ناقص است.
    assert.deepEqual(keys(visibleZones(new Map(), "dashboard")), ["dashboard", "settings"], "نامعلوم هرگز مجاز نیست");
    assert.deepEqual(keys(visibleZones(all("unknown"), "dashboard")), ["dashboard", "settings"]);
    assert.deepEqual(keys(visibleZones(all("deny"), "dashboard")), ["dashboard", "settings"], "داشبورد امروز و تنظیمات شخصی برای همه");
    assert.equal(visibleZones(all("allow"), "dashboard").length, ZONES.length);
    // بخشی که کاربر خودش باز کرده ناپدید نمی‌شود؛ بقیهٔ طبقه‌بندی هم باز نمی‌شود.
    assert.deepEqual(keys(visibleZones(new Map(), "treasury")), ["dashboard", "settings", "treasury"]);
    assert.deepEqual(keys(visibleZones(all("deny"), "treasury")), ["dashboard", "settings", "treasury"]);
    // مخلوط: یکی از عملیات مجاز کافی است؛ رد یکی، دیگری را نمی‌بندد؛ نامعلوم کمکی نمی‌کند.
    const mixed = new Map<string, Verdict>([["return.same_day", "allow"], ["return.late", "deny"], ["sale.create", "deny"], ["catalog.manage", "deny"]]);
    assert.ok(visibleZones(mixed, "dashboard").some(z => z.key === "returns"), "کافی است یکی از عملیات مجاز باشد");
    assert.ok(visibleZones(mixed, "dashboard").some(z => z.key === "invoices"));
    assert.ok(!visibleZones(mixed, "dashboard").some(z => z.key === "pos"));
    assert.ok(!visibleZones(mixed, "dashboard").some(z => z.key === "catalog"));
    assert.ok(!visibleZones(mixed, "dashboard").some(z => z.key === "treasury"), "بی‌پاسخ پنهان می‌ماند");
    assert.equal(accessOf([], new Map()), "allow");
    assert.equal(accessOf(["a", "b"], new Map([["a", "deny"]])), "unknown", "رد ناقص هنوز رد نیست");
    assert.equal(accessOf(["a", "b"], new Map([["a", "deny"], ["b", "deny"]])), "deny");
  });

  test("جای‌نگهدار فقط در loading و فقط برای مقصد بی‌پاسخ؛ پس از پاسخ یا خطا هیچ", () => {
    const protectedZones = ZONES.filter(z => z.anyOf.length > 0).map(z => z.key).sort();
    assert.deepEqual(pendingZones({ state: "loading", verdicts: new Map() }, "dashboard").map(z => z.key).sort(), protectedZones);
    assert.deepEqual(pendingZones({ state: "loading", verdicts: new Map() }, "treasury").map(z => z.key).includes("treasury"), false, "بخش باز جای‌نگهدار نمی‌شود");
    assert.deepEqual(pendingZones({ state: "degraded", verdicts: new Map() }, "dashboard"), [], "خطا جای‌نگهدار دائمی نمی‌سازد");
    assert.deepEqual(pendingZones({ state: "ready", verdicts: new Map(NAV_OPERATIONS.map(op => [op, "deny"] as const)) }, "dashboard"), []);
    const partial = new Map<string, Verdict>([["sale.create", "allow"]]);
    assert.ok(!pendingZones({ state: "loading", verdicts: partial }, "dashboard").some(z => z.key === "pos"), "مجازشده دیگر جای‌نگهدار نیست");
  });

  test("جست‌وجوی بخش‌ها از همان رجیستری ساخته می‌شود", () => {
    for (const z of ZONES) assert.ok(FEATURES.some(f => f.label === z.label && f.anyOf === z.anyOf), z.key);
    // پیوند مستقیم تنظیمات همان عملیات رجیستری تنظیمات را دارد، نه حدس جدا.
    for (const f of FEATURES) {
      const tab = new URL(f.href, "http://x").searchParams.get("settings.tab");
      if (tab === null) continue;
      const section = SETTINGS_SECTIONS.find(s => s.key === tab);
      assert.ok(section, `بخش ناموجود: ${tab}`);
      assert.deepEqual(f.anyOf, section.anyOf, `${f.label} ↔ ${tab}`);
    }
  });
});

describe("رجیستری تنظیمات — شخصی جدا از مدیریتی (F-110-02)", () => {
  const api = (file: string) => readFileSync(fileURLToPath(new URL(`../../api/src/http/${file}`, import.meta.url)), "utf8");
  /**
   * هر بخش مدیریتی به همان عملیاتی نگاشت شده که **مسیر خواندن صفحه‌اش در API**
   * می‌سنجد. ادعا از خودِ منبع API خوانده می‌شود؛ اگر سرور مجوز مسیر را عوض
   * کند و رجیستری نه، این آزمون قرمز می‌شود.
   */
  const SERVER: Record<string, readonly [file: string, route: string]> = {
    keys: ["settings-routes.ts", "/settings"],
    health: ["health-routes.ts", "/health/alerts"],
    woocommerce: ["woocommerce-diagnostics-routes.ts", "/settings/woocommerce"],
    backups: ["backup-routes.ts", "/backups"],
    accounts: ["admin-routes.ts", "/accounts"],
    mapping: ["admin-routes.ts", "/posting-rules"],
    snappay: ["snappay-routes.ts", "/snappay/config"],
    digipay: ["digipay-routes.ts", "/digipay/config"],
    terminals: ["settings-routes.ts", "/terminal-drivers"],
    opening: ["admin-routes.ts", "/tafsili"],
    staff: ["people-routes.ts", "/users"],
    "withdrawal-log": ["withdrawal-routes.ts", "/withdrawals"],
    permissions: ["admin-routes.ts", "/permission-rules"],
    devices: ["auth-routes.ts", "/devices"],
  };
  test("هر بخش مدیریتی عملیات مسیر خواندنش در API را دارد", () => {
    const admin = SETTINGS_SECTIONS.filter(s => s.scope === "admin");
    assert.deepEqual(admin.map(s => s.key).sort(), Object.keys(SERVER).sort(), "هر بخش مدیریتی یک مسیر مرجع دارد");
    for (const section of admin) {
      const [file, route] = SERVER[section.key]!;
      const source = api(file);
      const at = source.indexOf(`app.get("${route}"`);
      assert.ok(at >= 0, `${route} در ${file}`);
      const handler = source.slice(at, at + 400);
      // snappay از guard محلی می‌گذرد که برای خواندن settings.view می‌خواهد.
      const guard = (section.key === "snappay" || section.key === "digipay") ? source.slice(source.indexOf("function guard"), source.indexOf(`app.get("${route}"`)) : handler;
      assert.equal(section.anyOf.length, 1, section.key);
      assert.ok(guard.includes(`"${section.anyOf[0]}"`) || ((section.key === "snappay" || section.key === "digipay") && guard.includes(`"settings.view"`)), `${section.key}: ${section.anyOf[0]} در ${route}`);
    }
  });
  test("بخش شخصی هیچ مجوز مدیریتی نمی‌خواهد و فقط نشست خود کاربر را می‌خواند", () => {
    const personal = SETTINGS_SECTIONS.filter(s => s.scope === "personal").map(s => s.key);
    assert.deepEqual(personal, ["appearance", "pin", "twofactor", "withdrawals"]);
    for (const s of SETTINGS_SECTIONS) if (s.scope === "personal") assert.deepEqual(s.anyOf, []);
    const auth = api("auth-routes.ts");
    const pin = auth.slice(auth.indexOf('app.get("/auth/pin"'), auth.indexOf('app.get("/auth/pin"') + 300);
    assert.ok(!/requireForSession|requirePermission/.test(pin), "PIN من مجوز مدیریتی نمی‌خواهد");
    // برداشت‌های من: فقط نشست خودِ کاربر؛ مالک از نشست، نه از پرس‌وجو یا بدنه.
    const wd = api("withdrawal-routes.ts");
    for (const route of ['app.get("/withdrawals/mine"', 'app.get("/withdrawals/mine/:id"', 'app.post("/withdrawals",']) {
      const at = wd.indexOf(route);
      assert.ok(at >= 0, route);
      const handler = wd.slice(at, wd.indexOf("\n  });", at));
      assert.ok(!/requireForSession|requirePermission|managerSession/.test(handler), `${route} مجوز مدیریتی نمی‌خواهد`);
      assert.ok(/s\.userId/.test(handler), `${route} مالک را از نشست می‌گیرد`);
    }
    for (const op of SETTINGS_OPERATIONS) assert.ok(NAV_OPERATIONS.includes(op), `${op} همراه پرسش‌های ناوبری پرسیده می‌شود`);
  });
  const all = (v: Verdict) => new Map(NAV_OPERATIONS.map(op => [op, v] as const));
  const keys = (list: { key: string }[]) => list.map(s => s.key);
  test("کاربر عادی (صندوق‌دار): فقط بخش‌های شخصی؛ پیوند مستقیم مدیریتی mount نمی‌شود", () => {
    const cashier = { state: "ready" as const, verdicts: all("deny") };
    const view = settingsView(null, cashier);
    assert.deepEqual(keys(view.visible), ["appearance", "pin", "twofactor", "withdrawals"]);
    assert.equal(view.selected, "appearance", "پیش‌فرض نخستین بخش شخصی");
    for (const s of SETTINGS_SECTIONS.filter(s => s.scope === "admin")) {
      const deep = settingsView(s.key, cashier);
      assert.equal(deep.selected, null, `${s.key} نباید mount شود`);
      assert.equal(deep.blocked, "denied");
      assert.ok(!deep.visible.some(v => v.key === s.key), `${s.key} برچسبش در ناوبری نیست`);
    }
    assert.equal(settingsView("pin", cashier).selected, "pin");
    assert.equal(settingsView("nonsense", cashier).selected, "appearance", "کلید ناشناخته = پیش‌فرض، نه خطا");
  });
  test("مدیر کامل: همه، با پیش‌فرض «تنظیمات»", () => {
    const view = settingsView(null, { state: "ready", verdicts: all("allow") });
    assert.equal(view.visible.length, SETTINGS_SECTIONS.length);
    assert.equal(view.selected, "keys");
    assert.equal(settingsView("devices", { state: "ready", verdicts: all("allow") }).selected, "devices");
  });
  test("مجوز مدیریتی جزئی: فقط بخش‌های همان مجوز", () => {
    const verdicts = new Map([...all("deny"), ["settings.view", "allow"]] as [string, Verdict][]);
    const view = settingsView(null, { state: "ready", verdicts });
    assert.deepEqual(keys(view.visible), ["appearance", "pin", "twofactor", "withdrawals", "keys", "health", "woocommerce", "accounts", "mapping", "snappay", "digipay", "terminals", "opening"]);
    assert.equal(view.selected, "keys");
    for (const denied of ["backups", "staff", "withdrawal-log", "permissions", "devices"] as const) assert.equal(settingsView(denied, { state: "ready", verdicts }).blocked, "denied", denied);
  });
  test("در حال بررسی: شخصی دیده می‌شود، مدیریتی جای‌نگهدار است و هیچ بخش مدیریتی mount نمی‌شود", () => {
    const loading = { state: "loading" as const, verdicts: new Map<string, Verdict>() };
    const view = settingsView(null, loading);
    assert.deepEqual(keys(view.visible), ["appearance", "pin", "twofactor", "withdrawals"]);
    assert.deepEqual(keys(view.pending), SETTINGS_SECTIONS.filter(s => s.scope === "admin").map(s => s.key));
    assert.equal(view.selected, null, "پیش‌فرض تا پاسخ صبر می‌کند");
    assert.equal(view.blocked, "loading");
    assert.deepEqual([settingsView("staff", loading).selected, settingsView("staff", loading).blocked], [null, "loading"]);
    assert.equal(settingsView("pin", loading).selected, "pin", "بخش شخصی منتظر نمی‌ماند");
  });
  test("خطای بررسی: نامعلوم به مجاز تبدیل نمی‌شود؛ پیوند مستقیم «بررسی دوباره» می‌گیرد", () => {
    const degraded = { state: "degraded" as const, verdicts: new Map<string, Verdict>([["user.manage", "allow"]]) };
    const view = settingsView(null, degraded);
    assert.deepEqual(keys(view.visible), ["appearance", "pin", "twofactor", "withdrawals", "staff"]);
    assert.deepEqual(view.pending, [], "خطا جای‌نگهدار دائمی نمی‌سازد");
    assert.equal(view.selected, "staff", "بخش مجازِ رسیده باز می‌شود");
    assert.deepEqual([settingsView("devices", degraded).selected, settingsView("devices", degraded).blocked], [null, "degraded"]);
    assert.deepEqual([settingsView("withdrawal-log", degraded).selected, settingsView("withdrawal-log", degraded).blocked], [null, "degraded"], "دفتر مدیر با پاسخ نرسیده باز نمی‌شود");
  });
});

describe("عدد مالی و تاریخ", () => {
  test("مبلغ: رقم، علامت، صفر و فشرده", () => {
    assert.deepEqual(moneyParts("12340000"), { digits: "1٬234٬000", scale: "", sign: "positive", spoken: "1٬234٬000 تومان" });
    assert.equal(moneyParts("-50000").sign, "negative");
    assert.equal(moneyParts("-50000").digits, "5٬000");
    assert.equal(moneyParts("0").sign, "zero");
    assert.deepEqual([moneyParts("123456789000", true).digits, moneyParts("123456789000", true).scale], ["12٫3", "میلیارد"]);
    assert.equal(formatMoney("-50000"), "−5٬000");
    assert.equal(formatMoney("-50000", "parens"), "(5٬000)");
    assert.throws(() => moneyParts(12 as unknown as string), /رشته/);
  });

  test("درصد، تعداد و شمارش", () => {
    assert.equal(formatPercent(12.5), "12٫5٪");
    assert.equal(formatPercent(-3), "−3٪");
    assert.equal(formatPercent(Number.NaN), "—");
    assert.equal(formatQty("1.500"), "1٫5");
    assert.equal(formatQty("-1200"), "−1٬200");
    assert.throws(() => formatQty("1e3"));
    assert.equal(formatCount(12), "۱۲");
  });

  test("تاریخ جلالی اصلی و میلادی ثانوی، مستقل از منطقهٔ زمانی", () => {
    assert.equal(formatJalali("2026-09-16"), "۲۵ شهریور ۱۴۰۵");
    assert.equal(formatJalali("2026-09-16", true), "چهارشنبه، ۲۵ شهریور ۱۴۰۵");
    assert.equal(formatJalali("2025-03-21"), "۱ فروردین ۱۴۰۴");
    assert.match(formatGregorian("2026-09-16"), /^16 Sep/);
    assert.throws(() => formatJalali("2026-13-45"));
  });

  test("کد خام کانال هرگز به کاربر نمی‌رسد", () => {
    for (const code of [...Object.keys(CHANNEL_LABEL), "unknown_channel", "pos/web"]) {
      assert.doesNotMatch(channelLabel(code), /[a-z]/i, code);
    }
  });
});

describe("عمل مالی ایمن و وضعیت", () => {
  test("رد سرور «ناموفق» است؛ قطع شبکه و ۵xx «نامعلوم»", () => {
    const rejected = classifyFailure(new ApiError(409, "rule_violation", "دوره بسته است", "ref-1"));
    assert.deepEqual(rejected, { kind: "failed", message: "دوره بسته است", reference: "ref-1" });
    assert.equal(classifyFailure(new ApiError(503, "unavailable", "x", "ref-2")).kind, "unknown");
    assert.equal(classifyFailure(new ApiError(503, "unavailable", "x", "ref-2")).reference, "ref-2");
    assert.equal(classifyFailure(new TypeError("Failed to fetch")).kind, "unknown");
    assert.match(classifyFailure(new TypeError("x")).message, /بررسی/);
  });

  test("تأیید در حال اجرا یا نتیجهٔ نامعلوم ممکن نیست", () => {
    assert.equal(mayConfirm("confirm"), true);
    assert.equal(mayConfirm("failed"), true);
    for (const phase of ["pending", "unknown", "verifying", "done", "idle"] as const) assert.equal(mayConfirm(phase), false, phase);
  });

  test("هر وضعیت برچسب فارسی و آیکون دارد؛ رنگ هرگز تنها نیست", () => {
    assert.equal(Object.keys(STATUS).length, 11);
    const icons = read("components/Icon.tsx");
    for (const [state, s] of Object.entries(STATUS)) {
      assert.match(s.label, /[؀-ۿ]/, state);
      assert.match(icons, new RegExp(`\\n  ${s.icon}: <`), state);
    }
  });

  test("میان‌بر جست‌وجو: «/» و Ctrl/⌘+K، نه با Alt یا Shift", () => {
    const e = (key: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) =>
      ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null, ...mods });
    assert.equal(isSearchShortcut(e("/")), true);
    assert.equal(isSearchShortcut(e("k", { ctrlKey: true })), true);
    assert.equal(isSearchShortcut(e("ک", { metaKey: true })), true);
    assert.equal(isSearchShortcut(e("k", { ctrlKey: true, shiftKey: true })), false);
    assert.equal(isSearchShortcut(e("k")), false);
    assert.equal(isSearchShortcut(e("/", { altKey: true })), false);
  });
});

describe("UI Kit و دارایی‌ها", () => {
  test("UI Kit فقط با پرچم Build در Bundle می‌آید؛ ایمیج تولید پرچم را ندارد", () => {
    const app = read("app.tsx");
    assert.match(app, /const UI_KIT_ENABLED = import\.meta\.env\.DEV \|\| import\.meta\.env\.VITE_LMC_UI_KIT === "1";/);
    assert.match(app, /const UiKit = UI_KIT_ENABLED \? lazy\(\(\) => import\("\.\/screens\/dev\/UiKit\.tsx"\)/);
    assert.equal((app.match(/screens\/dev\/UiKit/g) ?? []).length, 1, "UI Kit فقط از همان شاخهٔ پرچم‌دار وارد می‌شود");
    // UI Kit داخل پوستهٔ واردشده رندر می‌شود، پس بی نشست دیده نمی‌شود.
    assert.ok(app.indexOf("uiKit && UiKit") > app.indexOf('if (view !== "ready")'));
    const dockerfile = readFileSync(path.join(ROOT, "apps/web/Dockerfile"), "utf8");
    assert.doesNotMatch(dockerfile, /VITE_LMC_UI_KIT/);
  });

  test("نشانهٔ سه‌بعدی: SVG کوچک، جدا از JS و تنبل‌بار", () => {
    const dir = path.join(SRC, "assets/accents");
    const files = readdirSync(dir);
    assert.ok(files.length >= 4);
    for (const f of files) {
      assert.match(f, /^[a-z]+\.svg$/, "نام‌گذاری: یک واژهٔ انگلیسی کوچک");
      assert.ok(statSync(path.join(dir, f)).size < 4096, `${f} از بودجهٔ ۴KB بزرگ‌تر است`);
      assert.doesNotMatch(readFileSync(path.join(dir, f), "utf8"), /<script|href="http|<image/i, f);
    }
    const accent = read("components/ui/Accent.tsx");
    for (const f of files) assert.match(accent, new RegExp(`accents/${f}\\?no-inline`));
    assert.match(accent, /loading="lazy"/);
    assert.match(accent, /alt=""/);
  });
});
