/** Exact thousandths, matching platform.qty numeric(14,3); no float or rounding. */
export function quantityUnits(raw: string): bigint | null {
  const text = raw.trim().replace(/[۰-۹٠-٩]/g, c => String(c.charCodeAt(0) - (c >= "۰" ? 1776 : 1632))).replace(/٫/g, ".");
  if (!/^\d{1,11}(?:\.\d{1,3})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole!) * 1000n + BigInt(fraction.padEnd(3, "0"));
}
export function quantityText(units: bigint): string {
  const fraction = (units % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${units / 1000n}${fraction ? `.${fraction}` : ""}`;
}
export function saleQuantity(raw: string, allowFractional: boolean): string | null {
  const units = quantityUnits(raw);
  if (units === null || units <= 0n || (!allowFractional && units % 1000n !== 0n)) return null;
  return quantityText(units);
}
