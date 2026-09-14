/**
 * دیتابیس یک‌بارمصرف برای تست یکپارچه.
 *
 * همان تصمیمی که ops/db.sh test گرفته: هر اجرا روی یک دیتابیس تازه.
 *
 * چرا پاک‌کردن داده کافی نیست — و این را با شکست تست فهمیدیم:
 * identity.auth_attempt عمداً تغییرناپذیر است، پس DELETE رویش خطا
 * می‌دهد؛ و چون user_id به app_user ارجاع دارد، کاربر تست هم قابل حذف
 * نیست. یعنی هر تلاشی برای «تمیزکاری» یا باید نگهبان را ضعیف کند یا
 * آشغال جا بگذارد. انداختن کل دیتابیس هیچ‌کدام را نمی‌خواهد.
 *
 * مهاجرت از خودِ ops/db.sh اجرا می‌شود، نه از یک مسیر موازی: دو مسیر
 * مهاجرت یعنی روزی یکی از دیگری عقب می‌ماند.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../../../..");

/**
 * نقش محدود تست — فقط وقتی `LMC_TEST_DB_ROLE=app` باشد ساخته می‌شود.
 *
 * ⚠️ نام نقش **به‌ازای هر دیتابیس یک‌بارمصرف یکتاست**، و این یک راحتی
 *    نیست؛ یک اصلاح است. نسخهٔ اول یک نام ثابت داشت و چون نقش در
 *    پستگرس سطح **Cluster** دارد نه سطح دیتابیس، چند پروندهٔ تست که
 *    هم‌زمان اجرا می‌شوند همگی روی همان سطرِ `pg_authid` یک
 *    `ALTER ROLE` می‌زدند. نتیجه‌اش `ERROR: tuple concurrently updated`
 *    بود — یک شکست **تصادفی** که به هر بار اجرا بستگی داشت.
 *
 *    با نام یکتا، هیچ دو نشستی یک سطر مشترک ندارند و موازی‌بودن
 *    بی‌خطر است. `ALTER DEFAULT PRIVILEGES` از اول هم مشکلی نداشت:
 *    آن در `pg_default_acl` همان دیتابیس می‌نشیند.
 *
 * ⚠️ و نام جداست از `labelmod_app` تولیدی: تست نباید رمز نقشی را عوض
 *    کند که ممکن است روی همان Cluster زنده باشد.
 */
const TEST_APP_PASSWORD = "role-test-only-not-a-secret";

/** آیا این اجرا باید با نقش محدود وصل شود؟ */
export function restrictedRoleRequested(): boolean {
  return (process.env.LMC_TEST_DB_ROLE ?? "").toLowerCase() === "app";
}

export interface DisposableDb {
  /** رشته اتصالِ **برنامه** — با `LMC_TEST_DB_ROLE=app` نقش محدود است. */
  url: string;
  /**
   * رشته اتصال با نقش **مالک** — همیشه، حتی در حالت نقش محدود.
   *
   * برای داربستِ تست است، نه برای کدِ تحت آزمون: قفل‌گرفتن دستی برای
   * ساختن یک تصادم، و `pg_dump`. همان تفکیکی که در تولید هم هست —
   * بکاپ و مهاجرت با مالک، برنامه با نقش محدود.
   */
  ownerUrl: string;
  drop(): void;
}

/** نام دیتابیس را در رشته اتصال عوض می‌کند، بدون دست‌زدن به بقیه. */
function swapDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

/**
 * همان رشته اتصال، ولی با نقش برنامه.
 *
 * شکل تولیدی دقیقاً همین است: مهاجرت و Seed با نقش **مالک** اجرا
 * می‌شوند و برنامه با نقشی که حق نوشتن مستقیم ندارد وصل می‌شود.
 */
function swapRole(url: string, role: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = encodeURIComponent(role);
  parsed.password = encodeURIComponent(password);
  return parsed.toString();
}

function psql(adminUrl: string, command: string): void {
  execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-q", "-d", adminUrl, "-c", command], {
    stdio: "pipe",
    env: { ...process.env, PGCLIENTENCODING: "UTF8" },
  });
}

/**
 * دیتابیس تازه می‌سازد، مهاجرت و داده مرجع را بار می‌کند و رشته اتصالش
 * را برمی‌گرداند. اگر psql در دسترس نباشد، null برمی‌گرداند تا تست
 * skip شود نه اینکه سبز وانمود کند.
 */
export function createDisposableDb(adminUrl: string): DisposableDb | null {
  const name = `labelmod_apitest_${randomBytes(6).toString("hex")}`;
  const url = swapDatabase(adminUrl, name);

  try {
    psql(adminUrl, `CREATE DATABASE "${name}"`);
  } catch {
    return null;
  }

  try {
    for (const step of ["migrate", "seed"]) {
      execFileSync("bash", [path.join(REPO_ROOT, "ops/db.sh"), step], {
        cwd: REPO_ROOT,
        stdio: "pipe",
        env: { ...process.env, DATABASE_URL: url, PGCLIENTENCODING: "UTF8" },
      });
    }
  } catch (err) {
    psql(adminUrl, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    throw err;
  }

  // نقش محدود: همان اسکریپت تولیدی، نه یک نسخهٔ موازی در تست. اگر
  // `ops/db-roles.sh` روزی یک GRANT کم بگذارد، همین‌جا دیده می‌شود —
  // که تمام هدف این مسیر است.
  let appUrl = url;
  let appRole: string | null = null;
  if (restrictedRoleRequested()) {
    appRole = `lmc_app_t_${randomBytes(6).toString("hex")}`;
    try {
      execFileSync("bash", [path.join(REPO_ROOT, "ops/db-roles.sh")], {
        cwd: REPO_ROOT,
        stdio: "pipe",
        env: {
          ...process.env,
          DATABASE_URL: url,
          APP_ROLE: appRole,
          APP_PASSWORD: TEST_APP_PASSWORD,
          PGCLIENTENCODING: "UTF8",
        },
      });
    } catch (err) {
      psql(adminUrl, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      throw err;
    }
    appUrl = swapRole(url, appRole, TEST_APP_PASSWORD);
  }

  return {
    url: appUrl,
    ownerUrl: url,
    drop() {
      try {
        psql(adminUrl, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } catch {
        // انداختن دیتابیس تست نباید نتیجه تست را عوض کند
      }
      // نقش **پس از** دیتابیس انداخته می‌شود: تا وقتی دیتابیس هست،
      // GRANTهایش روی نقش وابستگی می‌سازند و DROP ROLE رد می‌شود.
      if (appRole) {
        try {
          psql(adminUrl, `DROP ROLE IF EXISTS "${appRole}"`);
        } catch {
          // نقش یتیم، تست را قرمز نمی‌کند
        }
      }
    },
  };
}
