# Browser regression
Run against a freshly built production bundle:

`pnpm --filter @labelmod/web build`

`pnpm --filter @labelmod/web exec playwright install --with-deps chromium webkit`

`pnpm --filter @labelmod/web test:e2e`

Playwright is pinned in package.json and pnpm-lock.yaml. CI runs Chromium and WebKit in both themes at widths 320, 375, 768, 1024, 1440 and 1920 (24 projects). The current case count is whatever `playwright test --list` prints for the exact commit; CI splits the full list into four `--shard` jobs and the aggregate `browser-regression` check fails unless every shard succeeds. Sharding changes scheduling only, never coverage. On a failed shard CI also prints failure evidence into the job log: per-test `diagnostics.log` (page/context/browser close or crash, console errors, failed requests as method + pathname only; no headers, bodies, query strings or fragments), `error-context.md`, a trace timeline, concurrent and same-worker tests, resource samples and kernel OOM lines. It is written only for failed tests and never changes pass/fail. Every printed line passes through the same structural redaction (`e2e/redact.ts` and the report script), which drops query and fragment values and replaces malformed URLs with a placeholder; `test/e2e-redact.test.ts` locks both implementations. Open for later security review: Playwright's own list reporter output, printed before that evidence step, is not redacted and may show ordinary application hrefs with query parameters (synthetic data only); it is not rewritten here. Tests use only synthetic data; unexpected API requests, external requests and uncaught browser errors fail the test. Money fields follow the API's string contract. This suite does not replace PostgreSQL integration tests.

Visual artifacts (catalog, product detail, settings, dashboard, customers, permissions, reports, treasury, warehouse and password review) wait for actual local font loads; screenshots and failure traces are uploaded by CI. Layout checks cover long names, wide tables and 200% text enlargement. Images require human review; they are not a claim of automatic aesthetic scoring.

Reduced motion is emulated live in both engines. Chromium tests reduced transparency through CDP. Playwright does not expose that media emulation for WebKit, so its transparency fallback is tested by activating the actual CSS media rules. This is explicitly not a test of a native OS preference in WebKit. WebKit automation is engine coverage, not testing on a physical iPhone.

For local Windows environments where official browser downloads are unavailable, `PLAYWRIGHT_EDGE=1` and `--project='chromium-*'` use installed Microsoft Edge. CI always uses Playwright's pinned browsers.

## Scanner WASM compatibility (zxing-wasm)

The camera fallback imports both the reader glue (`zxing-wasm/reader`) and the local `zxing_reader.wasm?url` from the same exactly pinned package (currently 3.1.5). The native `BarcodeDetector` path returns before either dynamic import. The fallback copies a ready video frame into a reused canvas, passes its `ImageData` to `readBarcodes` with EAN13/EAN8/Code128 and `textMode: "Plain"`, and preserves raw barcode strings. WASM preparation still finishes before requesting the camera. All decoder assets remain local and the CSP is unchanged.

The former `barcode-detector` wrapper embedded its own Emscripten glue in `dist`: its latest published 3.2.2 release embeds 3.1.3, whereas PR #149 upgraded only the direct WASM to 3.1.5. As with PR #103 (3.1.4), changing an override could not repair that embedded glue. The wrapper is now removed, rather than mixing two builds or ignoring the upgrade. `test/zxing-compat.test.ts` follows the actual dynamic import specifiers, requires the same installed package root and exact exported version, and compares the local binary's SHA-256 with the hash exported by the reader glue.

To upgrade: (1) pin `zxing-wasm` exactly and regenerate the lockfile; (2) run `pnpm --filter @labelmod/web test` including the compatibility and independent Code128 decode tests; (3) build the production bundle; (4) run `security-ui.spec.ts` "local WASM decodes EAN13 through the camera fallback" and the camera preparation/cleanup cases; (5) confirm there are no out-of-bounds, external-request or uncaught-browser errors. Do not remove the version/hash checks if upstream changes its exports: establish an equivalent binding check first.
