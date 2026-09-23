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

export async function readMeliKey(db: Db, master: string | undefined): Promise<string> {
  const r = await sql<{ encrypted_key: unknown }>`SELECT encrypted_key FROM platform.melipayamak_credential WHERE singleton`.execute(db);
  const encrypted = r.rows[0]?.encrypted_key;
  return encrypted === null || encrypted === undefined ? "" : decryptMeliKey(encrypted, master);
}
