/**
 * سطح شیشه‌ای — و قاعده‌ای که خودش را اجبار می‌کند.
 *
 * ADR-002 «شیشه روی شیشه» را صریح ممنوع کرده، و در ساخت نمونه بصری
 * همان یک بار نقض شد: کارت‌های KPI داخل داشبورد شیشه‌ای، خودشان
 * `backdrop-filter` داشتند. کسی متوجهش نشد تا وقتی کنار هم دیده شدند.
 *
 * درسش این نبود که «دقت کنیم». این بود که **قاعده‌ای که فقط در سند
 * است، دیر یا زود نقض می‌شود**. پس اینجا مکانیکی شده: هر `Glass` از
 * Context می‌فهمد داخل شیشه است یا نه. اگر بود، خودبه‌خود به تینت
 * تبدیل می‌شود — رینگ و رنگ می‌گیرد، لایه بلور دوم نه.
 *
 * یعنی نوشتن `<Glass><Glass/></Glass>` غلط نیست؛ فقط نتیجه‌اش درست
 * است. توسعه‌دهنده بعدی لازم نیست ADR-002 را خوانده باشد.
 */
import {
  createContext,
  useContext,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";

/** آیا همین حالا داخل یک سطح شیشه‌ای هستیم؟ */
const InsideGlass = createContext(false);

export interface GlassProps {
  children: ReactNode;
  /** شعاع بیرونی. شعاع داخلی خودش مشتق می‌شود. */
  radius?: "lg" | "md" | "sm";
  /**
   * شکست نور لبه. پیش‌فرض روشن برای لایه کنترلی.
   *
   * روی سطح‌های کوچک خاموشش کنید: فیلتر SVG روی هر عنصر یک لایه ترکیب
   * جدا می‌سازد و بیست‌تا از آن روی تبلت ارزان، بودجه فریم را می‌خورد.
   */
  refract?: boolean;
  /**
   * بازتاب ویژه‌ای که به حرکت اشاره‌گر واکنش نشان می‌دهد.
   *
   * ADR-002 این را جزو مشخصه‌های Liquid Glass شمرده. فقط زاویه گرادیان
   * عوض می‌شود — نه layout، نه فیلتر — پس هزینه‌اش یک متغیر CSS است.
   */
  live?: boolean;
  as?: "div" | "section" | "header" | "aside" | "nav";
  className?: string;
  style?: CSSProperties;
}

const RADIUS: Record<NonNullable<GlassProps["radius"]>, string> = {
  lg: "var(--r-lg)",
  md: "var(--r-md)",
  sm: "var(--r-sm)",
};

export function Glass({
  children,
  radius = "lg",
  refract = true,
  live = false,
  as: Tag = "div",
  className = "",
  style,
}: GlassProps) {
  const nested = useContext(InsideGlass);
  const ref = useRef<HTMLDivElement | null>(null);

  // شعاع هم‌مرکز: داخلی = بیرونی − فاصله. اگر این رعایت نشود، گوشه‌ها
  // موازی نمی‌مانند و چشم بی‌آنکه بداند «ارزان» می‌بیندش.
  const vars = {
    "--r-outer": RADIUS[radius],
    "--r-inner": `calc(${RADIUS[radius]} - var(--pad))`,
    borderRadius: RADIUS[radius],
    ...style,
  } as CSSProperties;

  /**
   * زاویه بازتاب را از موقعیت اشاره‌گر می‌سازد.
   *
   * فقط یک متغیر CSS ست می‌شود؛ هیچ رندر دوباره‌ای در React رخ نمی‌دهد.
   * روی دستگاه لمسی اصلاً فعال نمی‌شود چون رویداد اشاره‌گرِ معلق ندارد.
   */
  const onPointerMove = live
    ? (e: React.PointerEvent<HTMLElement>) => {
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        const angle = 140 + Math.atan2(y, x) * (60 / Math.PI);
        el.style.setProperty("--specular-angle", `${angle.toFixed(1)}deg`);
      }
    : undefined;

  if (nested) {
    // داخل شیشه‌ایم: تینت، بدون لایه بلور دوم.
    return (
      <Tag className={`glass-tint ${className}`} style={vars}>
        {children}
      </Tag>
    );
  }

  return (
    <InsideGlass.Provider value={true}>
      <Tag
        ref={ref as React.Ref<never>}
        className={`glass ${refract ? "glass--refract" : ""} ${className}`}
        style={vars}
        {...(onPointerMove ? { onPointerMove } : {})}
      >
        {children}
      </Tag>
    </InsideGlass.Provider>
  );
}

/**
 * سطح مات — صندوق، جدول عدد، فرم.
 *
 * عمداً `InsideGlass` را **صفر می‌کند**: یک کارت مات، شیشه نیست، پس
 * فرزندانش می‌توانند دوباره شیشه‌ای شوند بدون اینکه قاعده نقض شود.
 */
export function Solid({
  children,
  className = "",
  style,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  as?: "div" | "section" | "aside";
}) {
  return (
    <InsideGlass.Provider value={false}>
      <Tag className={`solid ${className}`} style={style}>
        {children}
      </Tag>
    </InsideGlass.Provider>
  );
}

/**
 * فیلتر شکست نور — یک بار در ریشه سند.
 *
 * `feDisplacementMap` محتوای پشت را با یک نقشه گرادیان شعاعی جابه‌جا
 * می‌کند: وسط دست‌نخورده، لبه‌ها خم. همین است که «شیشه» را از «تاری»
 * جدا می‌کند.
 *
 * در حالت عملکرد، CSS کل `backdrop-filter` را برمی‌دارد — پس این فیلتر
 * هم بی‌مصرف می‌شود بدون اینکه لازم باشد چیزی اینجا عوض شود.
 */
export function GlassFilters() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      style={{ position: "absolute", width: 0, height: 0 }}
    >
      <filter id="lm-refract" x="-20%" y="-20%" width="140%" height="140%">
        {/* نقشه جابه‌جایی: روشن در مرکز، تیره در لبه */}
        <feImage
          href="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3CradialGradient id='g' cx='50%25' cy='50%25' r='50%25'%3E%3Cstop offset='55%25' stop-color='%23808080'/%3E%3Cstop offset='100%25' stop-color='%23000000'/%3E%3C/radialGradient%3E%3Crect width='100' height='100' fill='url(%23g)'/%3E%3C/svg%3E"
          result="map"
          preserveAspectRatio="none"
        />
        {/* `scale` یک صفت SVG است و متغیر CSS نمی‌خواند — پس عدد
            ثابت است و خاموش‌کردنش کار CSS: در حالت عملکرد،
            `.glass--refract` کل `backdrop-filter` را کنار می‌گذارد. */}
        <feDisplacementMap
          in="SourceGraphic"
          in2="map"
          scale="11"
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>
    </svg>
  );
}
