/**
 * ساخت کاربر پرسنل از خط فرمان — و مهم‌تر: **اولین** کاربر.
 *
 * چرا این فایل لازم است: `db/seed/` عمداً هیچ حساب انسانی نمی‌سازد.
 * تنها کاربرش «سیستم» است که نه رمز دارد نه PIN و غیرفعال است. یعنی
 * بدون این ابزار، سیستمِ تازه‌مستقرشده در بسته می‌ماند — هیچ‌کس
 * نمی‌تواند وارد شود.
 *
 * جایگزینِ بدترش این بود که seed یک مدیر با رمز پیش‌فرض بسازد. آن رمز
 * در مخزن می‌نشیند، روی هر استقراری یکی است، و اولین سطر فهرست کنترل
 * بند ۸ SECURITY.md دقیقاً همان را ممنوع می‌کند.
 *
 *   node --experimental-strip-types apps/api/src/cli/create-user.ts \
 *        --username ali --name '...' --role admin
 *
 * رمز **ساخته می‌شود، پرسیده نمی‌شود**: ۲۴ کاراکتر از مولد امن. رمزی
 * که آدم پای ترمینال می‌سازد، همان رمزی است که جای دیگری هم استفاده
 * شده. یک بار چاپ می‌شود و از آن به بعد فقط هش می‌ماند.
 *
 * ⚠️ PIN اینجا ست نمی‌شود. PIN فقط قفل نشستِ موجود را باز می‌کند و
 *    روی دستگاه تأییدشده معنا دارد (بند ۱ SECURITY.md).
 */
import { randomInt } from "node:crypto";
import { loadConfig } from "../lib/config.ts";
import { createDb } from "../db/client.ts";
import { hashSecret } from "../auth/password.ts";
import { withActor } from "../db/actor.ts";

/** کاربر «سیستم» که seed می‌سازد — عاملِ همین عملیات. */
const SYSTEM_USER = "00000000-0000-7000-8000-0000000000f1";

/**
 * بدون کاراکتر مبهم. این رمز روی کاغذ نوشته و دستی تایپ می‌شود؛
 * O در برابر 0 و l در برابر 1 یعنی یک تماس با پشتیبانی.
 */
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** رمز تصادفی از مولد امن، بدون سوگیری (randomInt، نه modulo). */
export function generatePassword(length = 24): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export interface CliArgs {
  username: string;
  name: string;
  roles: string[];
  branch: string | null;
  mobile: string | null;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(`--${flag}`);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const username = get("username");
  const name = get("name");
  if (!username || !name) {
    throw new Error(
      "استفاده: --username <نام کاربری> --name <نام کامل> [--role admin] [--branch <کد شعبه>] [--mobile <موبایل>]",
    );
  }
  // چند نقش با کاما. پیش‌فرض admin، چون تنها دلیل واقعی وجود این ابزار
  // ساختن اولین مدیر است.
  const roles = (get("role") ?? "admin")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  return { username, name, roles, branch: get("branch"), mobile: get("mobile") };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const handle = createDb(config.DATABASE_URL, 2);

  try {
    const password = generatePassword();
    const passwordHash = await hashSecret(password);

    await withActor(handle.db, { userId: SYSTEM_USER }, async (trx) => {
      // نقش ناموجود باید پیش از درج بشکند، نه با خطای کلید خارجی
      // انگلیسی. پیام فارسی اینجا تنها چیزی است که اپراتور می‌بیند.
      for (const code of args.roles) {
        const role = await trx
          .selectFrom("identity.role")
          .select("code")
          .where("code", "=", code)
          .executeTakeFirst();
        if (!role) throw new Error(`نقش «${code}» وجود ندارد`);
      }

      let branchId: string | null = null;
      if (args.branch) {
        const branch = await trx
          .selectFrom("platform.branch")
          .select("id")
          .where("code", "=", args.branch)
          .executeTakeFirst();
        if (!branch) throw new Error(`شعبه «${args.branch}» وجود ندارد`);
        branchId = branch.id;
      }

      const user = await trx
        .insertInto("identity.app_user")
        .values({
          username: args.username,
          full_name: args.name,
          mobile: args.mobile,
          pin_hash: null,
          totp_secret: null,
          password_hash: passwordHash,
          is_active: true,
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      await trx
        .insertInto("identity.user_role")
        .values(
          args.roles.map((role_code) => ({
            user_id: user.id,
            role_code,
            branch_id: branchId,
          })),
        )
        .execute();
    });

    process.stdout.write(
      [
        "",
        "✓ کاربر ساخته شد",
        `  نام کاربری : ${args.username}`,
        `  نقش‌ها     : ${args.roles.join("، ")}`,
        "",
        `  رمز عبور   : ${password}`,
        "",
        "⚠️  این رمز دیگر هرگز نمایش داده نمی‌شود. همین حالا در یک مدیر",
        "    رمز امن ذخیره‌اش کنید، و پس از اولین ورود عوضش کنید.",
        "",
      ].join("\n"),
    );
  } finally {
    await handle.close();
  }
}

// فقط وقتی مستقیم اجرا شده باشد — تا تست بتواند توابع بالا را import
// کند بدون اینکه به دیتابیس وصل شود.
if (process.argv[1]?.endsWith("create-user.ts")) {
  await main();
}
