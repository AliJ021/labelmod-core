/**
 * LM-106-L03 — شواهد شکست مرورگر هرگز مقدار Query یا Fragment را چاپ نمی‌کنند.
 *
 * دو پیاده‌سازی هست و هر دو در لاگ CI می‌نویسند: `e2e/redact.ts` (fixture آزمون) و
 * `.github/scripts/e2e-failure-report.py` (گزارش شکست). هر دو با یک مجموعه ورودی
 * مصنوعی سنجیده می‌شوند، به‌علاوهٔ یک اجرای کامل گزارش روی یک شکست ساختگی. همهٔ مقدارها
 * ساختگی‌اند؛ هیچ اعتبارنامهٔ واقعی‌ای اینجا نیست.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { redactText, safeRequestPath, REDACTED, UNPARSEABLE } from "../e2e/redact.ts";

const SECRET = "SENSITIVE_VALUE";
const PARAMS = ["token", "access_token", "code", "key", "secret", "password"];
const REPORT = fileURLToPath(new URL("../../../.github/scripts/e2e-failure-report.py", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../e2e/fixtures.ts", import.meta.url));

const ABSOLUTE_URLS = [
  ...PARAMS.map(p => `http://127.0.0.1:4173/api/auth/can?${p}=${SECRET}`),
  `https://example.test/api/x?page=1&token=${SECRET}&b=2`,
  `https://example.test/callback#access_token=${SECRET}`,
  `https://user:${SECRET}@example.test/private`,
  `http://example.test:8080/p?code=${SECRET}#frag-${SECRET}`,
];
const MALFORMED = [
  `http://[::1/x?token=${SECRET}`,
  `http://?password=${SECRET}`,
  `https://%zz/?secret=${SECRET}`,
  `data:text/plain,${SECRET}`,
  `javascript:alert('${SECRET}')`,
  `blob:http://example.test/${SECRET}`,
  `not a url ?key=${SECRET}`,
  `${SECRET}`.replace(SECRET, `::://?token=${SECRET}`),
];
const FREE_TEXT = [
  ...PARAMS.map(p => `GET /api/auth/can?${p}=${SECRET}`),
  ...PARAMS.map(p => `bare ?${p}=${SECRET}`),
  `Fetch API cannot load http://127.0.0.1:4173/api/auth/can?operation=period.close&token=${SECRET} due to access control checks.`,
  `navigating to "http://127.0.0.1:4173/?page=reports&access_token=${SECRET}", waiting until "load"`,
  `two: /a?code=${SECRET} and http://h.test/b?key=${SECRET}.`,
  `relative fragment /cb#access_token=${SECRET}`,
  `quoted value http://h.test/p?token='${SECRET}' and /q?secret="${SECRET}" and ?code=(${SECRET})`,
  `- link "x" [ref=e1]:\n  - /url: /?page=pos&secret=${SECRET}`,
  ...ABSOLUTE_URLS,
  ...MALFORMED,
];

describe("redactText / safeRequestPath (fixture)", () => {
  it("never emits a query, fragment or userinfo value", () => {
    for (const input of FREE_TEXT) assert.ok(!redactText(input).includes(SECRET), `leaked: ${redactText(input)}`);
    for (const input of [...ABSOLUTE_URLS, ...MALFORMED]) assert.ok(!safeRequestPath(input).includes(SECRET), `leaked: ${safeRequestPath(input)}`);
  });

  it("keeps the route that failed, and nothing after it", () => {
    assert.equal(safeRequestPath(`http://127.0.0.1:4173/api/auth/can?operation=x&token=${SECRET}`), "/api/auth/can");
    assert.equal(safeRequestPath("http://127.0.0.1:4173/"), "/");
    assert.equal(
      redactText(`Fetch API cannot load http://127.0.0.1:4173/api/auth/can?token=${SECRET} due to access control checks.`),
      `Fetch API cannot load http://127.0.0.1:4173/api/auth/can?${REDACTED} due to access control checks.`,
    );
    assert.equal(redactText(`requestfailed GET /api/x?code=${SECRET} :: net::ERR_FAILED`), `requestfailed GET /api/x?${REDACTED} :: net::ERR_FAILED`);
  });

  it("does not fall back to raw text for malformed or opaque URLs", () => {
    assert.equal(safeRequestPath(`http://[::1/x?token=${SECRET}`), UNPARSEABLE);
    assert.equal(safeRequestPath(`not a url ?key=${SECRET}`), UNPARSEABLE);
    assert.equal(safeRequestPath(`data:text/plain,${SECRET}`), "data:[omitted]");
    assert.equal(safeRequestPath(`javascript:alert('${SECRET}')`), "javascript:[omitted]");
    assert.equal(redactText(`see http://[::1/x?token=${SECRET}`), `see ${UNPARSEABLE}`);
  });

  it("leaves ordinary diagnostic text untouched", () => {
    const plain = "page close event; status=failed pageClosed=true r.failure()?.errorText a ? b : c";
    assert.equal(redactText(plain), plain);
  });

  it("the fixture writes diagnostics only through the redactor", () => {
    // فقط بلوک fixture شواهد؛ `url.search` در MockApi دادهٔ خودِ ادعاهای آزمون است، نه شواهد.
    const whole = readFileSync(FIXTURE, "utf8");
    const source = whole.slice(whole.indexOf("diagnostics: ["), whole.indexOf("api: [", whole.indexOf("diagnostics: [")));
    assert.ok(source.length > 200, "diagnostics fixture block not found");
    assert.match(source, /writeFile\(testInfo\.outputPath\("diagnostics\.log"\), redactText\(/);
    assert.match(source, /requestfailed \$\{r\.method\(\)\} \$\{safeRequestPath\(r\.url\(\)\)\}/);
    assert.match(source, /navigated \$\{safeRequestPath\(f\.url\(\)\)\}/);
    assert.doesNotMatch(source, /\.search\b/, "no query string may be read into diagnostics");
  });
});

function python(args: string[], input?: string) {
  // -B: بی __pycache__ در کنار اسکریپت.
  const run = spawnSync("python3", ["-B", ...args], { input, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

describe("e2e-failure-report.py", () => {
  const loadRedact = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("report", ${JSON.stringify(REPORT)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps([m.redact(x) for x in json.load(sys.stdin)]))`;

  it("redact() never emits a query, fragment or userinfo value", () => {
    const out = JSON.parse(python(["-c", loadRedact], JSON.stringify(FREE_TEXT))) as string[];
    out.forEach((line, i) => assert.ok(!line.includes(SECRET), `leaked for ${FREE_TEXT[i]}: ${line}`));
  });

  it("matches the fixture redactor on well-formed input", () => {
    const parity = [
      ...ABSOLUTE_URLS,
      ...FREE_TEXT.slice(0, 12),
      `Fetch API cannot load http://127.0.0.1:4173/api/auth/can?operation=period.close&token=${SECRET} due to access control checks.`,
      `see http://[::1/x?token=${SECRET}`,
      `data:text/plain,${SECRET}`,
    ];
    assert.deepEqual(JSON.parse(python(["-c", loadRedact], JSON.stringify(parity))), parity.map(redactText));
  });

  it("a full failure report prints the failing route but no secret", () => {
    const root = mkdtempSync(join(tmpdir(), "lmc-redact-"));
    try {
      const folder = join(root, "fake-failure-webkit-dark-375");
      mkdirSync(folder);
      writeFileSync(join(folder, "diagnostics.log"), `requestfailed GET /api/auth/can?token=${SECRET} :: cancelled\nconsole.error: http://127.0.0.1:4173/x?secret=${SECRET}\n`);
      writeFileSync(join(folder, "error-context.md"), `# Page snapshot\n- /url: /?page=pos&password=${SECRET}\n`);
      const events = [
        { type: "before", callId: "c1", apiName: "goto" },
        { type: "log", callId: "c1", message: `navigating to "http://127.0.0.1:4173/?access_token=${SECRET}"` },
        { type: "console", messageType: "error", text: `Fetch API cannot load http://127.0.0.1:4173/api/auth/can?code=${SECRET}` },
        { type: "after", callId: "c1", error: { message: `failed at /api/x?key=${SECRET}` } },
      ].map(e => JSON.stringify(e)).join("\n");
      python(["-c", "import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w') as z: z.writestr('0-trace.trace', sys.argv[2])", join(folder, "trace.zip"), events]);
      const results = { suites: [{ title: "x", specs: [{ title: "fake failure", file: "fake.spec.ts", line: 1, tests: [{ projectName: "webkit-dark-375", results: [{
        status: "failed", workerIndex: 0, parallelIndex: 0, startTime: "2026-09-28T00:00:00.000Z", duration: 1000,
        errors: [{ message: `Error: Unexpected API request\n+ "GET /auth/can?operation=period.close&token=${SECRET}"` }],
        attachments: [{ name: "trace", path: join(folder, "trace.zip") }],
      }] }] }] }] };
      writeFileSync(join(root, "results.json"), JSON.stringify(results));
      const report = python([REPORT, root]);
      assert.match(report, /FAILED \[webkit-dark-375\] fake\.spec\.ts:1/);
      assert.match(report, /\/api\/auth\/can\?\[redacted\]/);
      assert.match(report, /navigating to "http:\/\/127\.0\.0\.1:4173\/\?\[redacted\]/);
      assert.ok(!report.includes(SECRET), `report leaked a secret:\n${report}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
