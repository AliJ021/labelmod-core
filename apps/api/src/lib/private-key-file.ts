import { randomBytes, randomUUID } from "node:crypto";
import { link, readFile, unlink, writeFile } from "node:fs/promises";

export async function readPrivateKey(path: string): Promise<string | undefined> {
  try {
    const key = (await readFile(path, "utf8")).trim();
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("فایل کلید معتبر نیست.");
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Publish only a complete key, including when two administrators request it concurrently. */
export async function getOrCreatePrivateKey(path: string): Promise<string> {
  const existing = await readPrivateKey(path);
  if (existing) return existing;
  const temp = path + "." + randomUUID();
  await writeFile(temp, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  try {
    await link(temp, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally { await unlink(temp); }
  const key = await readPrivateKey(path);
  if (!key) throw new Error("فایل کلید پیدا نشد.");
  return key;
}

export async function wooSigningKey(legacy: string | undefined, create = false) {
  if (legacy) return legacy;
  const file = process.env.WOO_SIGNING_KEY_FILE;
  if (!file) return undefined;
  return create ? getOrCreatePrivateKey(file) : readPrivateKey(file);
}
