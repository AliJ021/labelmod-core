import ledger from "../../assets/accents/ledger.svg?no-inline";
import shield from "../../assets/accents/shield.svg?no-inline";
import archive from "../../assets/accents/archive.svg?no-inline";
import success from "../../assets/accents/success.svg?no-inline";

/**
 * نشانهٔ سه‌بعدی تأکیدی — فقط لحظه‌های خاص (docs/DESIGN_SYSTEM.md، «آیکون»).
 *
 * حالت خالی، موفقیت، بکاپ، امنیت، گزارش. هرگز روی دکمه یا ناوبری.
 * فایل جداست (`?no-inline`)، با `loading="lazy"` و اندازهٔ صریح تا چیدمان
 * نپرد؛ تزئینی است و `alt` خالی دارد — معنا در متن کنارش است.
 */
const SOURCES = { ledger, shield, archive, success } as const;
export type AccentName = keyof typeof SOURCES;
export const ACCENT_NAMES = Object.keys(SOURCES) as AccentName[];

export function Accent({ name, size = "md" }: { name: AccentName; size?: "sm" | "md" }) {
  const px = size === "sm" ? 56 : 96;
  return <img className={`accent accent--${size}`} src={SOURCES[name]} alt="" width={px} height={px} loading="lazy" decoding="async" draggable={false} />;
}
