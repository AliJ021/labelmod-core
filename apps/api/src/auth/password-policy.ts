import type { Transaction } from "kysely";
import type { Db } from "../db/client.ts";
import type { Database } from "../db/types.ts";

type PasswordPolicyDb = Db | Transaction<Database>;

/** در تراکنش نوشتن، این قفل تغییر هم‌زمان سیاست را تا ثبت رمز نگه می‌دارد. */
export async function minimumPasswordLength(db: PasswordPolicyDb): Promise<number> {
  const setting = await db.selectFrom("platform.setting").select("value")
    .where("key", "=", "auth.min_password_length").forShare().executeTakeFirst();
  if (!setting) return 12;
  const minimum = setting.value;
  if (typeof minimum !== "number" || !Number.isInteger(minimum) || minimum < 12 || minimum > 64) {
    throw new Error("تنظیم حداقل طول رمز نامعتبر است");
  }
  return minimum;
}

/** فقط رمز تازه؛ اعتبارسنجی ورود و PIN سیاست مستقل خود را دارند. */
export async function newPasswordViolation(db: PasswordPolicyDb, plain: string): Promise<string | null> {
  const minimum = await minimumPasswordLength(db);
  return plain.length < minimum || plain.length > 256
    ? `رمز باید بین ${minimum} تا ۲۵۶ کاراکتر باشد`
    : null;
}
