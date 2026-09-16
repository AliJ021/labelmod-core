# Browser regression
Run against a freshly built production bundle:

`pnpm --filter @labelmod/web build`

`pnpm --filter @labelmod/web exec playwright install --with-deps chromium webkit`

`pnpm --filter @labelmod/web test:e2e`

Playwright is pinned in package.json and pnpm-lock.yaml. CI runs Chromium and WebKit in both themes at widths 320, 375, 768, 1024, 1440 and 1920. Ten scenarios per project produce 240 browser cases. Tests use only synthetic data; unexpected API requests, external requests and uncaught browser errors fail the test. Money fields follow the API's string contract. This suite does not replace PostgreSQL integration tests.

Visual artifacts (catalog, product detail, settings, dashboard, customers, permissions, reports, treasury, warehouse and password review) wait for actual local font loads; screenshots and failure traces are uploaded by CI. Layout checks cover long names, wide tables and 200% text enlargement. Images require human review; they are not a claim of automatic aesthetic scoring.

Reduced motion is emulated live in both engines. Chromium tests reduced transparency through CDP. Playwright does not expose that media emulation for WebKit, so its transparency fallback is tested by activating the actual CSS media rules. This is explicitly not a test of a native OS preference in WebKit. WebKit automation is engine coverage, not testing on a physical iPhone.

For local Windows environments where official browser downloads are unavailable, `PLAYWRIGHT_EDGE=1` and `--project='chromium-*'` use installed Microsoft Edge. CI always uses Playwright's pinned browsers.
