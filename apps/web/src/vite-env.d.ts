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
