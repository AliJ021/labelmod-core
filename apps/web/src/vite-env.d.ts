/// <reference types="vite/client" />

/**
 * دارایی‌هایی که با `?url` وارد می‌شوند.
 *
 * لازم است چون فایل WASM خواننده بارکد **محلی** بار می‌شود، نه از
 * CDN — دلیلش در `lib/camera-scan.ts` آمده.
 */
declare module "*?url" {
  const url: string;
  export default url;
}

/** دارایی که عمداً درون JS جاسازی نمی‌شود — نشانهٔ سه‌بعدی تنبل‌بار (components/ui/Accent.tsx). */
declare module "*?no-inline" {
  const url: string;
  export default url;
}

interface ImportMetaEnv {
  /** «1» فقط در Build آزمون مرورگر و پیش‌نمایش: مسیر /dev/ui-kit را در Bundle نگه می‌دارد. */
  readonly VITE_LMC_UI_KIT?: string;
}
