/**
 * ساخت کلاینت ماشینی — کلید API برای افزونه ووکامرس و مانند آن.
 *
 *   node --experimental-strip-types apps/api/src/cli/create-api-client.ts \
 *        --name 'سایت لیبل مد' --role web
 *
 * کاربر پشتی همین‌جا ساخته می‌شود و مثل کاربر «سیستم» هرگز نمی‌تواند
 * وارد شود: نه رمز، نه PIN، و `is_active = false`. مسیر ورود
 * `is_active` را می‌سنجد، پس کلید API تنها راه اوست.
 *
 * کلید یک بار چاپ می‌شود و از آن به بعد فقط SHA-256 آن در دیتابیس
 * می‌ماند. گمش کردید؟ کلید تازه بسازید و قبلی را باطل کنید — بازیابی
 * ممکن نیست و نباید باشد.
 */
import { loadConfig } from "../lib/config.ts";
import { createDb } from "../db/client.ts";
import { withActor } from "../db/actor.ts";
import { hashApiKey, newApiKey } from "../auth/api-key.ts";

/** کاربر «سیستم» که seed می‌سازد — عاملِ همین عملیات. */
const SYSTEM_USER = "00000000-0000-7000-8000-0000000000f1";

export interface ApiClientArgs {
  name: string;
  roles: string[];
  branch: string | null;
  note: string | null;
}

export function parseArgs(argv: readonly string[]): ApiClientArgs {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(`--${flag}`);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const name = get("name");
  if (!name) {
    throw new Error(
      "استفاده: --name <نام کلاینت> [--role <نقش‌ها با کاما>] [--branch <کد شعبه>] [--note <یادداشت>]",
    );
  }
  const roles = (get("role") ?? "cashier")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  return { name, roles, branch: get("branch"), note: get("note") };
}

/**
 * نام کاربری کاربر پشتی — از نام کلاینت، با پیشوند.
 *
 * پیشوند `api:` عمدی است و نه فقط برای خوانایی: نام کاربری یکتاست و
 * هیچ آدمی نمی‌تواند نامی با دونقطه بسازد، پس برخورد ممکن نیست.
 */
export function backingUsername(name: string, suffix: string): string {
  const slug = name
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40);
  return `api:${slug}:${suffix}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const handle = createDb(config.DATABASE_URL, 2);

  try {
    const key = newApiKey();

    const created = await withActor(handle.db, { userId: SYSTEM_USER }, async (trx) => {
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
          username: backingUsername(args.name, Date.now().toString(36)),
          full_name: args.name,
          mobile: null,
          password_hash: null,
          pin_hash: null,
          totp_secret: null,
          // هرگز نمی‌تواند وارد شود. کلید API تنها راه اوست.
          is_active: false,
        })
        .returning(["id", "username"])
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

      const client = await trx
        .insertInto("identity.api_client")
        .values({
          name: args.name,
          user_id: user.id,
          key_hash: hashApiKey(key),
          created_by: SYSTEM_USER,
          note: args.note,
          last_used_at: null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      return { clientId: client.id, username: user.username };
    });

    process.stdout.write(
      [
        "",
        "✓ کلاینت API ساخته شد",
        `  نام        : ${args.name}`,
        `  نقش‌ها     : ${args.roles.join("، ")}`,
        `  کاربر پشتی : ${created.username} (غیرفعال — فقط با کلید کار می‌کند)`,
        `  شناسه      : ${created.clientId}`,
        "",
        `  کلید       : ${key}`,
        "",
        "  استفاده:  Authorization: Bearer <کلید>",
        "",
        "⚠️  این کلید دیگر هرگز نمایش داده نمی‌شود. همین حالا در تنظیمات",
        "    افزونه ووکامرس بگذاریدش. گمش کردید؟ کلید تازه بسازید و این",
        "    را باطل کنید — بازیابی ممکن نیست و نباید باشد.",
        "",
      ].join("\n"),
    );
  } finally {
    await handle.close();
  }
}

if (process.argv[1]?.endsWith("create-api-client.ts")) {
  await main();
}
