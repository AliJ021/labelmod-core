import https from "node:https";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { httpsUrl, ProviderContractError, type ProviderTransport } from "./contract.ts";

const denied = new BlockList();
for (const [address, prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],
  ["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.168.0.0",16],
  ["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]] as const)
  denied.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::",3,"ipv6");
for (const [address,prefix] of [["2001::",23],["2001:db8::",32],["2002::",16],["3fff::",20]] as const)
  denied.addSubnet(address,prefix,"ipv6");

/** DNS خصوصی، محلی و نگاشت IPv4 در IPv6 مسیر خروج credential نیست. */
export function isPublicProviderAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !denied.check(address,"ipv4") :
    family === 6 && globalV6.check(address,"ipv6") && !denied.check(address,"ipv6");
}

interface TransportDependencies {
  resolve?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  request?: typeof https.request;
}

/** فقط تنظیم مورد اعتماد سرور؛ هر فراخوانی یک اتصال، بدون redirect، retry یا لاگ. */
export function createProviderHttpsTransport(baseUrl: string, dependencies: TransportDependencies = {}): ProviderTransport {
  const origin = new URL(httpsUrl(baseUrl));
  if (origin.pathname !== "/" || origin.search) throw new ProviderContractError("invalid_configuration");
  const hostname = origin.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) && !isPublicProviderAddress(hostname)) throw new ProviderContractError("invalid_configuration");
  const resolve = dependencies.resolve ?? (host => lookup(host, { all: true }));
  const request = dependencies.request ?? https.request;
  return async input => {
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]);
    let aborted: (() => void) | undefined;
    try {
      const url = new URL(httpsUrl(input.url));
      if (url.origin !== origin.origin || input.redirect !== "error" || input.signal.aborted
        || !["GET","POST"].includes(input.method) || (input.body && Buffer.byteLength(input.body)>1_048_576)) throw new Error();
      if (Object.keys(input.headers).some(key => !["authorization","content-type"].includes(key.toLowerCase()))) throw new Error();
      // آدرس فقط یک بار resolve می‌شود؛ اتصال و SNI روی همان مقصد تأییدشده‌اند.
      const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([
        resolve(hostname), new Promise<never>((_done,reject) => {
          aborted = () => reject(new Error());
          signal.addEventListener("abort",aborted,{ once: true });
          if (signal.aborted) aborted();
        }),
      ]);
      if (!addresses.length || addresses.some(a => !isPublicProviderAddress(a.address) || isIP(a.address)!==a.family) || signal.aborted) throw new Error();
      const target = addresses[0]!;
      return await new Promise((resolveResponse,reject) => {
        const req = request(url, {
          method: input.method, headers: { ...input.headers, "Accept-Encoding": "identity" },
          signal, agent: false, minVersion: "TLSv1.3", rejectUnauthorized: true,
          family: target.family, lookup: (_host,_options,callback) => callback(null,target.address,target.family),
        }, response => {
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300 || (response.headers["content-encoding"] && response.headers["content-encoding"]!=="identity")) {
            response.destroy(); reject(new Error()); return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size>262_144) { response.destroy(); reject(new Error()); } else chunks.push(chunk);
          });
          response.once("end", () => resolveResponse({ status, body: Buffer.concat(chunks).toString("utf8") }));
          response.once("error", () => reject(new Error()));
          response.once("aborted", () => reject(new Error()));
        });
        req.once("error", () => reject(new Error()));
        req.end(input.body);
      });
    } catch { throw new Error("ارتباط امن درگاه کامل نشد"); }
    finally { if (aborted) signal.removeEventListener("abort",aborted); }
  };
}
