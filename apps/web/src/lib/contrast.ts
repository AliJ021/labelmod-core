/**
 * تضاد رنگ — WCAG 2.1، و ΔE برای تفکیک‌پذیری.
 *
 * ADR-002 چند ادعای عددی دارد: «رنگ نمودار روی هر دو سطح ≥۳:۱»، «متن
 * روی شیشه حداقل ۴٫۵:۱»، «فاصله هشدار تا خطا ΔE ۱۸٫۷ برای دید عادی و
 * ۱۰٫۷ در کوررنگی». آن ادعاها یک بار با یک اسکریپت سنجیده شده بودند و
 * بعد اسکریپت گم شد — یعنی از آن به بعد فقط یک جمله در سند بودند.
 *
 * این ماژول همان سنجش را برمی‌گرداند، و `test/palette.test.ts` در CI
 * اجرایش می‌کند. حالا اگر کسی یک Hex را عوض کند و ادعا بشکند، تست
 * قرمز می‌شود — نه اینکه سه ماه بعد در فروشگاه معلوم شود.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `#rgb` یا `#rrggbb`. */
export function hexToRgb(hex: string): Rgb {
  const h = hex.trim().replace(/^#/, "");
  const full =
    h.length === 3
      ? [...h].map((c) => c + c).join("")
      : h.length === 6
        ? h
        : null;
  if (full === null || !/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`رنگ نامعتبر: ${hex}`);
  }
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/** ترکیب رنگ نیمه‌شفاف روی یک زمینه مات — همان کاری که مرورگر می‌کند. */
export function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  const mix = (a: number, b: number) => Math.round(a * alpha + b * (1 - alpha));
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b) };
}

/** روشنایی نسبی — WCAG 2.1. */
export function luminance({ r, g, b }: Rgb): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** نسبت تضاد، از ۱ تا ۲۱. */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// ── ΔE ────────────────────────────────────────────────────────────
// دو رنگ می‌توانند تضاد کافی با زمینه داشته باشند ولی از **هم** قابل
// تشخیص نباشند. هشدار و خطا دقیقاً همین‌اند: اگر ΔE کم باشد،
// صندوق‌دار هشدار موجودی را با خطای پرداخت اشتباه می‌گیرد.

interface Lab {
  L: number;
  a: number;
  b: number;
}

function toLab(rgb: Rgb): Lab {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = lin(rgb.r);
  const g = lin(rgb.g);
  const b = lin(rgb.b);

  // sRGB → XYZ (D65)
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;

  const f = (t: number) =>
    t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);

  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** ΔE*ab (CIE76) — برای «آیا این دو رنگ از هم جدا دیده می‌شوند؟» کافی است. */
export function deltaE(a: Rgb, b: Rgb): number {
  const la = toLab(a);
  const lb = toLab(b);
  return Math.hypot(la.L - lb.L, la.a - lb.a, la.b - lb.b);
}

/**
 * شبیه‌سازی کوررنگی قرمز-سبز (Deuteranopia).
 *
 * چرا لازم است: هشدار (زرد/کهربایی) و خطا (قرمز) برای دید عادی خوب از
 * هم جدا می‌شوند، ولی برای حدود ۸٪ مردان همان دو رنگ به هم نزدیک
 * می‌شوند. ADR-002 همین را یک بار گرفت و پالت اول را رد کرد.
 *
 * ماتریس Brettel/Viénot — تقریب متداول، برای تصمیم طراحی کافی.
 *
 * ⚠️ ماتریس در فضای **خطی** تعریف شده. اعمالش روی مقدار گاما‌دار sRGB
 *    عدد می‌دهد ولی عدد غلط — و غلط به سمت «بدتر از واقعیت». نسخه اول
 *    همین اشتباه را داشت و ΔE را ۶٫۵ نشان می‌داد به‌جای مقدار واقعی.
 */
export function deuteranopia(rgb: Rgb): Rgb {
  const toLinear = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const toSrgb = (v: number) => {
    const c = Math.max(0, Math.min(1, v));
    const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(s * 255);
  };

  const r = toLinear(rgb.r);
  const g = toLinear(rgb.g);
  const b = toLinear(rgb.b);

  return {
    r: toSrgb(0.625 * r + 0.375 * g),
    g: toSrgb(0.7 * r + 0.3 * g),
    b: toSrgb(0.3 * g + 0.7 * b),
  };
}
