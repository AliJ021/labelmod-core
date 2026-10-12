/**
 * خواندن بارکد با دوربین.
 *
 * مهم‌ترین ادعا: دوربین یک بارکد را ده‌ها بار در ثانیه می‌بیند و
 * بدون مهار، یک بار گرفتن گوشی جلوی برچسب سی قلم به سبد اضافه
 * می‌کند.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  BARCODE_FORMATS,
  cameraError,
  hasNativeDetector,
  nativeDetector,
  resolveDetector,
  videoDetector,
  ScanThrottle,
} from "../src/lib/camera-scan.ts";

describe("مهار تکرار", () => {
  test("اولین خواندن پذیرفته می‌شود", () => {
    const t = new ScanThrottle(1500);
    assert.equal(t.accept("2001234567890", 1000), true);
  });

  test("همان بارکد داخل پنجره، دوباره شمرده نمی‌شود", () => {
    // این همان چیزی است که «یک اسکن، سی قلم» را می‌سازد.
    const t = new ScanThrottle(1500);
    t.accept("2001234567890", 1000);
    for (let at = 1030; at < 2500; at += 30) {
      assert.equal(t.accept("2001234567890", at), false, `در ${at}`);
    }
  });

  test("بارکد متفاوت، فوراً پذیرفته می‌شود", () => {
    // اسکن پشت‌سرهم دو کالا نباید منتظر پنجره بماند.
    const t = new ScanThrottle(1500);
    t.accept("2001234567890", 1000);
    assert.equal(t.accept("2009876543210", 1050), true);
  });

  test("نگه‌داشتن ممتد گوشی پنجره را تمام نمی‌کند", () => {
    // اگر زمان آخرین دیدن به‌روز نمی‌شد، گرفتن ممتد گوشی بعد از
    // ۱٫۵ ثانیه همان قلم را دوباره اضافه می‌کرد.
    const t = new ScanThrottle(1500);
    t.accept("2001234567890", 1000);
    for (let at = 1100; at < 6000; at += 100) {
      assert.equal(t.accept("2001234567890", at), false, `در ${at}`);
    }
  });

  test("پس از برداشتن گوشی و اسکن دوباره، پذیرفته می‌شود", () => {
    // اسکن **عمدی** دوم همان کالا باید بشمارد.
    const t = new ScanThrottle(1500);
    t.accept("2001234567890", 1000);
    assert.equal(t.accept("2001234567890", 3000), true, "پس از مکث");
  });

  test("reset حافظه را پاک می‌کند", () => {
    const t = new ScanThrottle(1500);
    t.accept("2001234567890", 1000);
    t.reset();
    assert.equal(t.accept("2001234567890", 1050), true);
  });

  test("پنجره تنظیم‌پذیر است", () => {
    const t = new ScanThrottle(100);
    t.accept("x", 1000);
    assert.equal(t.accept("x", 1050), false);
    assert.equal(t.accept("x", 1200), true);
  });
});

describe("تشخیص توان مرورگر", () => {
  test("مسیر بومی بدون بارگذاری WASM یا DOM کار می‌کند", async () => {
    class Native {
      async detect() { return [{ rawValue: "00123" }]; }
    }
    assert.ok(await resolveDetector({ BarcodeDetector: Native }) instanceof Native);
  });
  test("کروم اندروید — آشکارساز بومی", () => {
    const g = { BarcodeDetector: class {} } as unknown as Record<string, unknown>;
    assert.equal(hasNativeDetector(g), true);
    assert.notEqual(nativeDetector(g), null);
  });

  test("سافاری — بدون آشکارساز بومی", () => {
    // یعنی کتابخانه باید بار شود؛ و چون `import()` پویاست، کاربر
    // اندروید هرگز دانلودش نمی‌کند.
    assert.equal(hasNativeDetector({}), false);
    assert.equal(nativeDetector({}), null);
  });

  test("فرمت‌ها همان‌هایی‌اند که این فروشگاه چاپ می‌کند", () => {
    // بارکد داخلی این پروژه EAN-13 با پیشوند ۲۰ است.
    assert.ok(BARCODE_FORMATS.includes("ean_13"));
    assert.ok(BARCODE_FORMATS.includes("ean_8"));
  });
});

describe("فریم ویدیوی رمزگشای محلی", () => {
  test("فریم آماده‌نشده یا بدون اندازه بوم و رمزگشا را مصرف نمی‌کند", async () => {
    const detector = videoDetector(async () => { throw new Error("نباید خوانده شود"); },
      () => { throw new Error("نباید بوم ساخته شود"); });
    for (const frame of [{ readyState: 1, videoWidth: 640, videoHeight: 480 },
      { readyState: 4, videoWidth: 0, videoHeight: 480 }, { readyState: 4, videoWidth: 640, videoHeight: 0 }])
      assert.deepEqual(await detector.detect(frame as HTMLVideoElement), []);
  });

  test("بوم دوباره استفاده می‌شود؛ اندازهٔ تازه و متن با صفر ابتدایی حفظ می‌شود", async () => {
    let made = 0;
    const drawn: unknown[][] = [], readSizes: number[][] = [];
    const image = { width: 640, height: 480 } as ImageData;
    const context = { drawImage: (...args: unknown[]) => { drawn.push(args); },
      getImageData: (...args: number[]) => { readSizes.push(args); return image; } };
    const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
    const detector = videoDetector(async pixels => { assert.equal(pixels, image); return [{ text: "0012345" }]; },
      () => { made++; return canvas; });
    const frame = { readyState: 4, videoWidth: 640, videoHeight: 480 } as HTMLVideoElement;
    assert.deepEqual(await detector.detect(frame), [{ rawValue: "0012345" }]);
    Object.assign(frame, { videoWidth: 320, videoHeight: 240 });
    await detector.detect(frame);
    assert.equal(made, 1); assert.equal(canvas.width, 320); assert.equal(canvas.height, 240);
    assert.deepEqual(drawn.map(args => args.slice(1)), [[0, 0, 640, 480], [0, 0, 320, 240]]);
    assert.deepEqual(readSizes, [[0, 0, 640, 480], [0, 0, 320, 240]]);
  });

  test("خطای یک فریم مانع خواندن فریم بعدی نیست", async () => {
    let calls = 0;
    const context = { drawImage() {}, getImageData: () => ({}) as ImageData };
    const detector = videoDetector(async () => { if (++calls === 1) throw new Error("فریم خراب"); return []; },
      () => ({ width: 0, height: 0, getContext: () => context }) as unknown as HTMLCanvasElement);
    const frame = { readyState: 4, videoWidth: 100, videoHeight: 100 } as HTMLVideoElement;
    await assert.rejects(detector.detect(frame), /فریم خراب/);
    assert.deepEqual(await detector.detect(frame), []);
  });
});

describe("پیام خطای دوربین", () => {
  test("اجازه داده نشده — رایج‌ترین حالت", () => {
    const err = Object.assign(new Error("x"), { name: "NotAllowedError" });
    assert.match(cameraError(err), /اجازه دوربین/);
  });

  test("دوربینی نیست", () => {
    const err = Object.assign(new Error("x"), { name: "NotFoundError" });
    assert.match(cameraError(err), /پیدا نشد/);
  });

  test("دوربین در اختیار برنامه دیگر", () => {
    const err = Object.assign(new Error("x"), { name: "NotReadableError" });
    assert.match(cameraError(err), /برنامه دیگری/);
  });

  test("هر چیز دیگر، راه جایگزین را می‌گوید", () => {
    // بن‌بست بی‌راه‌حل نه: ورودی دستی بارکد همیشه هست.
    assert.match(cameraError(new Error("?")), /دستی/);
    assert.match(cameraError(null), /دستی/);
  });
});
