import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import process from "node:process";
import { createHash } from "node:crypto";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// ZIP بدون فشرده‌سازی؛ ترتیب و تاریخ ثابت، مستقل از سیستم و زمان ساخت.
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function packagePlugin(outDir = resolve(here, "../../apps/web/public/downloads")) {
  const root = resolve(here, "labelmod-connector");
  const paths: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".php")) paths.push(path);
      else throw new Error("فایل غیرمجاز در پوشهٔ بسته");
    }
  }
  await walk(root);
  paths.sort();
  const main = await readFile(resolve(root, "labelmod-connector.php"), "utf8");
  const version = /\* Version: (\d+\.\d+\.\d+)/.exec(main)?.[1];
  if (!version || !main.includes(`define('LMC_VERSION', '${version}');`)) throw new Error("نسخه‌های افزونه همخوان نیستند");
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const path of paths) {
    const name = Buffer.from("labelmod-connector/" + relative(root, path).replaceAll("\\", "/"));
    const bytes = Buffer.from((await readFile(path, "utf8")).replaceAll("\r\n", "\n"));
    const crc = crc32(bytes);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x21, 12); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(bytes.length, 18); head.writeUInt32LE(bytes.length, 22); head.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(bytes.length, 20); c.writeUInt32LE(bytes.length, 24); c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    locals.push(head, name, bytes); central.push(c, name);
    offset += head.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(paths.length, 8); end.writeUInt16LE(paths.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const zip = Buffer.concat([...locals, directory, end]);
  const filename = `labelmod-connector-${version}.zip`;
  const manifest = { version, filename, sha256: createHash("sha256").update(zip).digest("hex"), bytes: zip.length };
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, filename), zip);
  await writeFile(resolve(outDir, "labelmod-connector.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(await packagePlugin(process.argv[2]), null, 2) + "\n");
}
