import { test, expect, type MockApi } from "./fixtures";
import type { Page } from "@playwright/test";

function pos(api: MockApi) {
  api.defaults["GET /payment-methods"] = { methods: [] };
  api.defaults["GET /shifts/current"] = { id: "s1", branchId: "b1", status: "open", openingCash: "0" };
  api.defaults["GET /gift-options"] = { wraps: [], colors: [], flowers: [] };
}
async function camera(page: Page) {
  await page.goto("/");
  await page.getByRole("tab", { name: "صندوق", exact: true }).click();
  await page.getByRole("button", { name: "دوربین", exact: true }).click();
}

for (const action of ["lock", "logout"] as const) {
  test(`${action} keeps the session view until the server confirms success`, async ({ page, api }) => {
    let attempt = 0;
    api.handlers.set(`POST /auth/${action}`, async route => {
      attempt++;
      if (attempt === 1) await route.abort();
      else if (attempt === 2) await route.fulfill({ status: 503, json: {} });
      else if (attempt === 3) await route.fulfill({ json: { ok: false, locked: false } });
      else await route.fulfill({ json: action === "lock" ? { locked: true } : { ok: true } });
    });
    await page.goto("/");
    const button = page.getByRole("button", { name: action === "lock" ? "قفل صفحه" : "خروج", exact: true });
    for (let i = 0; i < 3; i++) {
      await button.click();
      await expect(page.getByRole("alert")).toContainText("در سرور تأیید نشد");
      await expect(page.getByRole("tab", { name: "کالا و قیمت", exact: true })).toBeVisible();
    }
    await button.click();
    await expect(page.getByRole("tab", { name: "کالا و قیمت", exact: true })).toHaveCount(0);
    expect(attempt).toBe(4);
  });
}

test("treasury retries use the normalized full payment body as their identity", async ({ page, api }) => {
  api.defaults["GET /treasury/accounts"] = { accounts: [{ id: "a1", name: "بانک آزمایشی", kind: "bank", isActive: true }] };
  const calls: Array<{ key: string | undefined; body: Record<string, unknown> }> = [];
  api.handlers.set("POST /treasury/transactions", async route => {
    calls.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
    await route.fulfill({ status: 503, json: { error: { message: "خطای موقت آزمون" } } });
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "خزانه و چک", exact: true }).click();
  await page.getByRole("combobox", { name: "نوع", exact: true }).selectOption("capital");
  await page.getByRole("combobox", { name: "به حساب", exact: true }).selectOption("a1");
  const amount = page.getByRole("textbox", { name: "مبلغ (تومان)", exact: true });
  const ref = page.getByRole("textbox", { name: "شماره پیگیری — اختیاری" });
  const note = page.getByRole("textbox", { name: "شرح", exact: true });
  const submit = page.getByRole("button", { name: "ثبت و ارسال به دفتر", exact: true });
  async function send() {
    const count = calls.length;
    await submit.click();
    await expect.poll(() => calls.length).toBe(count + 1);
    await expect(submit).toBeEnabled();
  }
  await amount.fill("1000"); await ref.fill(" R1 "); await note.fill(" شرح اول "); await send();
  await amount.fill("۱۰۰۰"); await ref.fill("R1"); await note.fill("شرح اول"); await send();
  expect(calls[0]!.key).toBeTruthy(); expect(calls[1]).toEqual(calls[0]);
  await ref.fill("R2"); await send(); expect(calls[2]!.key).not.toBe(calls[0]!.key);
  await note.fill("شرح دوم"); await send(); expect(calls[3]!.key).not.toBe(calls[2]!.key);
  await send(); expect(calls[4]).toEqual(calls[3]);
});

test("closing the camera ignores a late detection and stops its track", async ({ page, api }) => {
  pos(api);
  await page.addInitScript(() => {
    const state = { stopped: 0, detecting: false, resolve: (_: Array<{ rawValue: string }>) => {} };
    Object.assign(window, { cameraTest: state });
    Object.assign(window, { BarcodeDetector: class {
      detect() { state.detecting = true; return new Promise(resolve => { state.resolve = resolve; }); }
    } });
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: async () => ({ getTracks: () => [{ stop() { state.stopped++; } }] }) } });
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", { set() {} });
    Object.defineProperty(HTMLMediaElement.prototype, "readyState", { get: () => 4 });
    HTMLMediaElement.prototype.play = async () => {};
  });
  await camera(page);
  await expect.poll(() => page.evaluate(() => (window as unknown as { cameraTest: { detecting: boolean } }).cameraTest.detecting)).toBe(true);
  await page.getByRole("button", { name: "بستن دوربین", exact: true }).last().click();
  await page.evaluate(async () => {
    const state = (window as unknown as { cameraTest: { resolve: (v: Array<{ rawValue: string }>) => void } }).cameraTest;
    state.resolve([{ rawValue: "5901234123457" }]);
    await new Promise(resolve => setTimeout(resolve, 200));
  });
  expect(api.calls.filter(call => call.startsWith("POST /invoices"))).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { cameraTest: { stopped: number } }).cameraTest.stopped)).toBe(1);
});

test("failed WASM preparation never opens the camera", async ({ page, api }) => {
  pos(api);
  let wasm = 0;
  await page.route("**/*.wasm", async route => { wasm++; await route.abort(); });
  await page.addInitScript(() => {
    Object.defineProperty(window, "BarcodeDetector", { value: undefined });
    Object.assign(window, { cameraRequests: 0 });
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: async () => { (window as unknown as { cameraRequests: number }).cameraRequests++; throw new Error("must not request camera"); } } });
  });
  await camera(page);
  await expect(page.getByRole("alert")).toContainText("دوربین باز نشد");
  expect(wasm).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as unknown as { cameraRequests: number }).cameraRequests)).toBe(0);
});

for (const mode of ["late-stream", "play-failure"] as const) {
  test(`camera stops tracks after ${mode}`, async ({ page, api }) => {
    pos(api);
    await page.addInitScript(mode => {
      const state = { requested: false, stopped: 0, release: () => {} };
      Object.assign(window, { cameraCleanup: state, BarcodeDetector: class { async detect() { return []; } } });
      Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: async () => {
        state.requested = true;
        if (mode === "late-stream") await new Promise<void>(resolve => { state.release = resolve; });
        return { getTracks: () => [{ stop() { state.stopped++; } }] };
      } } });
      Object.defineProperty(HTMLMediaElement.prototype, "srcObject", { set() {} });
      HTMLMediaElement.prototype.play = async () => { throw new DOMException("synthetic play failure", "NotReadableError"); };
    }, mode);
    await camera(page);
    await expect.poll(() => page.evaluate(() => (window as unknown as { cameraCleanup: { requested: boolean } }).cameraCleanup.requested)).toBe(true);
    if (mode === "late-stream") {
      await page.getByRole("button", { name: "بستن دوربین", exact: true }).last().click();
      await page.evaluate(() => (window as unknown as { cameraCleanup: { release: () => void } }).cameraCleanup.release());
    } else await expect(page.getByRole("alert")).toContainText("دوربین در اختیار برنامه دیگری است");
    await expect.poll(() => page.evaluate(() => (window as unknown as { cameraCleanup: { stopped: number } }).cameraCleanup.stopped)).toBe(1);
    expect(api.calls.filter(call => call.startsWith("POST /invoices"))).toEqual([]);
  });
}

test("local WASM decodes EAN13 through the camera fallback", async ({ page, api }) => {
  pos(api);
  // The real decoder reads pixels through the browser canvas API; only the camera is synthetic.
  await page.addInitScript(() => {
    Object.defineProperty(window, "BarcodeDetector", { value: undefined });
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", { set() {} });
    Object.defineProperty(HTMLMediaElement.prototype, "readyState", { get: () => 4 });
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { get: () => 345 });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { get: () => 120 });
    HTMLMediaElement.prototype.play = async () => {};
    // Independent EAN-13 fixture 5901234123457, including its valid check digit.
    const left = ["0001101","0011001","0010011","0111101","0100011","0110001","0101111","0111011","0110111","0001011"];
    const even = ["0100111","0110011","0011011","0100001","0011101","0111001","0000101","0010001","0001001","0010111"];
    const digits = "5901234123457";
    const bars = "101" + [...digits.slice(1,7)].map((d,i) => ("LGGLLG"[i] === "L" ? left : even)[Number(d)]).join("") + "01010" + [...digits.slice(7)].map(d => [...left[Number(d)]!].map(b => b === "1" ? "0" : "1").join("")).join("") + "101";
    const original = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...args: [CanvasImageSource, ...number[]]) {
      if (args[0] instanceof HTMLVideoElement) {
        this.fillStyle = "white"; this.fillRect(0,0,this.canvas.width,this.canvas.height);
        this.fillStyle = "black";
        [...bars].forEach((b,i) => { if (b === "1") this.fillRect(30+i*3,10,3,100); });
      } else Reflect.apply(original, this, args);
    };
    if (typeof OffscreenCanvasRenderingContext2D !== "undefined") {
      const offscreenDraw = OffscreenCanvasRenderingContext2D.prototype.drawImage;
      OffscreenCanvasRenderingContext2D.prototype.drawImage = function (this: OffscreenCanvasRenderingContext2D, ...args: [CanvasImageSource, ...number[]]) {
        if (args[0] instanceof HTMLVideoElement) {
          this.fillStyle = "white"; this.fillRect(0,0,this.canvas.width,this.canvas.height);
          this.fillStyle = "black";
          [...bars].forEach((b,i) => { if (b === "1") this.fillRect(30+i*3,10,3,100); });
        } else Reflect.apply(offscreenDraw, this, args);
      };
    }
  });
  const invoice = { id: "camera-draft", status: "draft", channel: "pos", branchId: "b1", warehouseId: "w1", shiftId: "s1", lines: [], payableAmount: "0", receivedAmount: "0", grossAmount: "0", discountAmount: "0", netAmount: "0", taxAmount: "0", shippingAmount: "0", gift: null };
  api.defaults["POST /invoices"] = invoice;
  let barcode: string | undefined;
  api.handlers.set("POST /invoices/camera-draft/scan", async route => { barcode = route.request().postDataJSON().barcode; await route.fulfill({ json: { invoice, replayed: false } }); });
  await camera(page);
  await expect.poll(() => barcode).toBe("5901234123457");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "بستن دوربین", exact: true }).last().click();
});
