import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { sql } from "kysely";
import type { Db } from "../db/client.ts";
import { SettingError } from "./settings.ts";

const AAD = Buffer.from("labelmod:melipayamak:api-key:v1");
type Envelope = { v: 1; nonce: string; tag: string; ciphertext: string };

function masterKey(raw: string | undefined): Buffer {
  if (!raw || !/^[a-f0-9]{64}$/i.test(raw)) {
    throw new SettingError("secret_storage_unavailable", "ذخیرهٔ امن کلید روی سرور آماده نیست", 503);
  }
  return Buffer.from(raw, "hex");
}

export function encryptMeliKey(value: string, master: string | undefined): Envelope {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(master), nonce);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { v: 1, nonce: nonce.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("hex") };
}

export function decryptMeliKey(value: unknown, master: string | undefined): string {
  const key = masterKey(master);
  try {
    const e = value as Envelope;
    if (e.v !== 1 || !/^[a-f0-9]{24}$/.test(e.nonce) || !/^[a-f0-9]{32}$/.test(e.tag)
      || !/^(?:[a-f0-9]{2})+$/.test(e.ciphertext)) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(e.nonce, "hex"));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(e.tag, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(e.ciphertext, "hex")), decipher.final()]).toString("utf8");
  } catch {
    throw new SettingError("secret_unreadable", "کلید ذخیره‌شده قابل خواندن نیست؛ کلید رمزگذاری یا بکاپ را بررسی کنید", 503);
  }
}

export type MeliProfile = {
  transport: "console" | "panel";
  accountName: string;
  otpPattern: number | null;
  invoicePattern: number | null;
  digestPattern: number | null;
};

export async function readMeliConnection(db: Db, master: string | undefined) {
  const result = await sql<MeliProfile & { encrypted_key: unknown }>`
    SELECT transport, account_name AS "accountName", otp_pattern AS "otpPattern",
      invoice_pattern AS "invoicePattern", digest_pattern AS "digestPattern", encrypted_key
    FROM platform.melipayamak_credential WHERE singleton`.execute(db);
  const row = result.rows[0];
  if (!row) throw new SettingError("credential_missing", "تنظیم اتصال ملی‌پیامک آماده نیست", 503);
  const { encrypted_key, ...profile } = row;
  return { ...profile, apiKey: encrypted_key == null ? "" : decryptMeliKey(encrypted_key, master) };
}

export async function readMeliKey(db: Db, master: string | undefined): Promise<string> {
  return (await readMeliConnection(db, master)).apiKey;
}
