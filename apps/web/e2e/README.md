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

The camera fallback combines two pieces from different packages: the Emscripten glue embedded in `barcode-detector`'s own `dist` (it does not import the installed `zxing-wasm`), and `zxing_reader.wasm`, which `src/lib/camera-scan.ts` locates from the direct `apps/web` `zxing-wasm` dependency. They must come from the same zxing-wasm build: 3.1.3 glue with the 3.1.4 WASM fails every scan with `RuntimeError: memory access out of bounds` (PR #103). A pnpm override on `barcode-detector>zxing-wasm` only changes the dependency graph, not the embedded glue. `test/zxing-compat.test.ts` compares the version embedded in `barcode-detector/pure` with the shipped WASM version.

To upgrade: (1) take a `barcode-detector` release; (2) check which `zxing-wasm@x.y.z` its `dist` embeds; (3) set the direct `zxing-wasm` to exactly that version, never on its own; (4) run `pnpm --filter @labelmod/web test`; (5) build the production bundle; (6) run `security-ui.spec.ts` "local WASM decodes EAN13 through the camera fallback"; (7) confirm there is no `memory access out of bounds` in its diagnostics.
