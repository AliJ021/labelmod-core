/**
 * فرستندهٔ Push سایت — ADR-007 بندهای ۵ و ۶.
 *
 * ── چرا این پرونده وجود دارد ────────────────────────────────────────
 *
 * دو تا از قیدهای این طراحی **امنیتی**اند و هر دو بی‌صدا می‌شکنند:
 *
 *   SSRF   مقصدی که به شبکهٔ داخلی برسد — یا Redirectی که به آن ببرد
 *   امضا   بدنه‌ای که دست‌کاری شود و همچنان پذیرفته شود
 *
 * هیچ‌کدام در عمل خطا نمی‌دهند؛ فقط کار می‌کنند و نباید بکنند.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  isPrivateAddress,
  makePinnedPost,
  makeWebPushSender,
  pinnedLookup,
  resolveSafeTarget,
  signBody,
  signatureMatches,
  type PinnedPost,
} from "../src/worker/web-push.ts";
import { SmsError } from "../src/worker/sms.ts";

const SECRET = "s3cr3t-برای-تست";

const base = {
  enabled: true,
  baseUrl: "https://shop.example.com",
  secret: SECRET,
};

/** هدف امن ساختگی — تست به DNS واقعی وابسته نمی‌شود. */
const safeTarget = async (raw: string) => ({
  url: new URL(raw),
  ip: "203.0.113.10",
  ips: ["203.0.113.10"],
});

/** یک `post` ساختگی با وضعیت ثابت. */
const okPost = (status = 200): PinnedPost => async () => ({ status });

test("محدودهٔ داخلی رد می‌شود — و محدودهٔ عمومی رد نمی‌شود", () => {
  for (const ip of [
    "127.0.0.1", "127.9.9.9", "0.0.0.0", "10.1.2.3", "172.16.0.1",
    "172.31.255.254", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "224.0.0.1", "::1", "::", "fd00::1", "fc00::1", "fe80::1",
    // ⚠️ IPv4 در پوشش IPv6 — بی این حالت، یک حلقهٔ کامل باز بود.
    "::ffff:127.0.0.1", "::ffff:169.254.169.254",
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} باید داخلی شمرده شود`);
  }
  // کنترل مثبت: اگر همه‌چیز «داخلی» شمرده شود، این تابع هیچ‌چیز را
  // نمی‌سنجد و هر Push هم شکست می‌خورد.
  for (const ip of ["8.8.8.8", "203.0.113.10", "172.32.0.1", "192.169.0.1", "2001:db8::1"]) {
    assert.equal(isPrivateAddress(ip), false, `${ip} باید عمومی شمرده شود`);
  }
  // چیزی که IP نیست، IP امن هم نیست.
  assert.equal(isPrivateAddress("not-an-ip"), true);
});

test("نمایش‌های معادل IPv6 و IPv4 از کنترل مقصد عبور نمی‌کنند", async () => {
  const internal = ["::ffff:7f00:1", "0:0:0:0:0:ffff:a9fe:a9fe",
    "0:0:0:0:0:0:0:1", "0000:0:0:0:0:0:0:0", "febf::1", "ff02::1", "fe80::1%lo"];
  for (const ip of internal) {
    assert.equal(isPrivateAddress(ip), true, ip);
    await assert.rejects(() => resolveSafeTarget("https://example.test", async () => ["8.8.8.8", ip]));
    await assert.rejects(() => resolveSafeTarget(`https://[${ip}]/`));
  }
  for (const host of ["2130706433", "0x7f000001", "0177.0.0.1", "127.1", "[::ffff:127.0.0.1]"]) {
    await assert.rejects(() => resolveSafeTarget(`https://${host}/`));
  }
  for (const ip of ["::ffff:808:808", "0:0:0:0:0:ffff:8.8.4.4", "2001:4860:4860::8888"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
    assert.deepEqual((await resolveSafeTarget("https://example.test", async () => [ip])).ips, [ip]);
  }
});

test("تنظیم مقصد با userinfo یا query یا fragment رد می‌شود و نصب زیرپوشه حفظ می‌شود", async () => {
  for (const baseUrl of ["https://u:p@shop.example.com", "https://shop.example.com/?x=1", "https://shop.example.com/#fragment"]) {
    let posts = 0;
    const sender = makeWebPushSender({ ...base, baseUrl }, {
      resolveTarget: (raw) => resolveSafeTarget(raw, async () => ["8.8.8.8"]),
      post: async () => { posts++; return { status: 200 }; },
    });
    await assert.rejects(() => sender.send({ topic: "web.stock_push", payload: {} }), SmsError);
    assert.equal(posts, 0);
  }
  for (const suffix of ["/wordpress", "/wordpress/", "/wordpress///"]) {
    let destination = "";
    await makeWebPushSender({ ...base, baseUrl: `https://shop.example.com:8443${suffix}` }, {
      resolveTarget: safeTarget,
      post: async ({ url }) => { destination = url.href; return { status: 200 }; },
    }).send({ topic: "web.price_push", payload: {} });
    assert.equal(destination, "https://shop.example.com:8443/wordpress/wp-json/lmc/v1/price");
  }
});

test("نشانی غیر https رد می‌شود، و خطایش **دائمی** است", async () => {
  await assert.rejects(
    () => resolveSafeTarget("http://shop.example.com/x"),
    (e: unknown) => {
      assert.ok(e instanceof SmsError);
      // Backoff برای نشانی‌ای که هرگز https نمی‌شود، فقط صف را شلوغ می‌کند.
      assert.equal(e.permanent, true);
      return true;
    },
  );
});

test("همهٔ پاسخ‌های DNS سنجیده می‌شوند، نه فقط اولی", async () => {
  // ⚠️ یافتهٔ FND-R60-02، نیمهٔ دوم. `lookup(host)` تنها **یک** نشانی
  //    می‌داد، پس نامی که هم‌زمان یک نشانی عمومی و یک نشانی داخلی
  //    بدهد بسته به ترتیب پاسخ DNS گاهی رد می‌شد و گاهی نه. نگهبانی
  //    که گاهی کار کند، نگهبان نیست.
  //
  //    نشانی عمومی عمداً **اول** است — همان حالتی که نسخهٔ قبلی از آن
  //    رد می‌شد.
  await assert.rejects(
    () => resolveSafeTarget(
      "https://rebind.example.com/x",
      async () => ["203.0.113.10", "169.254.169.254"],
    ),
    (e: unknown) => {
      assert.ok(e instanceof SmsError);
      assert.equal(e.permanent, true);
      assert.match(e.message, /169\.254\.169\.254/);
      return true;
    },
  );

  // کنترل مثبت: فهرستی که همه‌اش عمومی است باید **قبول** شود، وگرنه
  // ادعای بالا با یک «همیشه رد کن» هم سبز می‌شد و Push را می‌بست.
  const ok = await resolveSafeTarget(
    "https://good.example.com/x",
    async () => ["203.0.113.10", "2001:db8::7"],
  );
  assert.deepEqual(ok.ips, ["203.0.113.10", "2001:db8::7"]);
  assert.equal(ok.ip, "203.0.113.10");

  // و پاسخ خالی یک «شاید» نیست: چیزی برای پین‌کردن نیست، پس اتصالی هم
  // نباید برقرار شود.
  await assert.rejects(
    () => resolveSafeTarget("https://empty.example.com/x", async () => []),
    (e: unknown) => {
      assert.ok(e instanceof SmsError);
      return true;
    },
  );

  // و نشانی IP خام هم از همان سنجش می‌گذرد — بی DNS.
  await assert.rejects(() => resolveSafeTarget("https://127.0.0.1/x"));
  const raw = await resolveSafeTarget("https://203.0.113.10/x");
  assert.deepEqual(raw.ips, ["203.0.113.10"]);
});

test("نام میزبانی که به IP داخلی برسد رد می‌شود", async () => {
  // ⚠️ سنجش روی **IP نهایی** است نه روی رشته: `localtest.me` یک نام
  //    عمومی است که به 127.0.0.1 می‌رسد — دقیقاً کاری که SSRF می‌کند.
  //    اینجا با یک هدف ساختگی همان مسیر رانده می‌شود، بی وابستگی به DNS.
  const send = makeWebPushSender(base, {
    resolveTarget: async (raw) => {
      const url = new URL(raw);
      const ip = "127.0.0.1";
      if (isPrivateAddress(ip)) {
        throw new SmsError(`مقصد «${url.hostname}» داخلی است`, true);
      }
      return { url, ip, ips: [ip] };
    },
    post: async () => {
      throw new Error("نباید به اتصال برسد");
    },
  });
  await assert.rejects(() => send.send({ topic: "web.stock_push", payload: { variationId: "v" } }));
});

test("پاسخ ۳xx یک شکست دائمی است — و Redirect اصلاً دنبال نمی‌شود", async () => {
  const send = makeWebPushSender(base, {
    resolveTarget: safeTarget,
    post: okPost(302),
  });
  await assert.rejects(
    () => send.send({ topic: "web.stock_push", payload: { variationId: "v" } }),
    (e: unknown) => {
      assert.ok(e instanceof SmsError);
      assert.equal(e.permanent, true);
      return true;
    },
  );
});

test("IPهای سنجیده‌شده به اتصال **پین** می‌شوند", async () => {
  // ⚠️ یافتهٔ FND-R60-02. نسخهٔ قبلی `ip` را می‌گرفت و دور می‌انداخت و
  //    `fetch` دوباره DNS می‌زد؛ یعنی چیزی که سنجیده شد و چیزی که به
  //    آن وصل می‌شویم دو پاسخ **متفاوت** بودند.
  let pinned: string[] | undefined;
  const send = makeWebPushSender(base, {
    resolveTarget: async (raw) => ({
      url: new URL(raw),
      ip: "203.0.113.10",
      ips: ["203.0.113.10", "2001:db8::7"],
    }),
    post: async (target) => { pinned = target.ips; return { status: 200 }; },
  });
  await send.send({ topic: "web.stock_push", payload: { variationId: "v" } });
  assert.deepEqual(pinned, ["203.0.113.10", "2001:db8::7"],
    "فهرست IP سنجیده‌شده باید دست‌نخورده به لایهٔ اتصال برسد");
});

test("هر ارسال دوباره Resolve می‌کند — نتیجه Cache نمی‌شود", async () => {
  // نشانی‌ای که امروز عمومی است و فردا داخلی می‌شود، نباید تا ابد از
  // نگهبان رد باشد. هر تلاش مجددِ صف یک سنجش تازه می‌گیرد.
  let calls = 0;
  const send = makeWebPushSender(base, {
    resolveTarget: async (raw) => { calls++; return await safeTarget(raw); },
    post: okPost(),
  });
  await send.send({ topic: "web.stock_push", payload: { variationId: "v" } });
  await send.send({ topic: "web.stock_push", payload: { variationId: "v" } });
  assert.equal(calls, 2);
});

test("`pinnedLookup` هر نامی را به همان فهرست برمی‌گرداند", () => {
  const look = pinnedLookup(["203.0.113.10", "2001:db8::7"]);

  // حالت آرایه‌ای — `net.connect` در autoSelectFamily همین را می‌خواهد.
  look("attacker-controlled.example", { all: true }, (err, addrs) => {
    assert.equal(err, null);
    assert.deepEqual(addrs, [
      { address: "203.0.113.10", family: 4 },
      { address: "2001:db8::7", family: 6 },
    ]);
  });

  // حالت تکی — و نام میزبان **هیچ اثری** ندارد؛ همین نکتهٔ پین است.
  look("whatever.invalid", {}, (err, addr, family) => {
    assert.equal(err, null);
    assert.equal(addr, "203.0.113.10");
    assert.equal(family, 4);
  });

  // فیلتر خانواده رعایت می‌شود، و نبودِ پاسخ **خطا** است نه بازگشت به DNS.
  look("x", { family: 6, all: true }, (err, addrs) => {
    assert.equal(err, null);
    assert.deepEqual(addrs, [{ address: "2001:db8::7", family: 6 }]);
  });
  let sawError = false;
  pinnedLookup(["203.0.113.10"])("x", { family: 6 }, (err) => {
    sawError = err instanceof Error;
  });
  assert.equal(sawError, true, "بی نشانی مناسب باید خطا بدهد، نه اینکه پین را رها کند");

  // و یک ورودی که IP نیست، اصلاً فهرست نمی‌سازد.
  assert.throws(() => pinnedLookup(["not-an-ip"]));
});

test("`makePinnedPost` واقعاً `lookup` را به اتصال می‌دهد", async () => {
  // ⚠️ بی این ادعا، `pinnedLookup` می‌توانست درست باشد و **هیچ‌جا صدا
  //    زده نشود** — همان کلاس «نگهبانی که هست و کار نمی‌کند».
  let opts: Record<string, unknown> | undefined;
  const fakeRequest = ((o: Record<string, unknown>, cb: (r: unknown) => void) => {
    opts = o;
    const res = {
      statusCode: 204,
      resume() {},
      on(ev: string, fn: () => void) { if (ev === "end") setImmediate(fn); },
    };
    setImmediate(() => cb(res));
    return { on() {}, end() {}, destroy() {} };
  }) as unknown as Parameters<typeof makePinnedPost>[0];

  const post = makePinnedPost(fakeRequest);
  const out = await post(
    { url: new URL("https://shop.example.com/wp-json/lmc/v1/stock?x=1"), ips: ["203.0.113.10"] },
    { headers: { "content-type": "application/json" }, body: "{}", timeoutMs: 1000 },
  );

  assert.equal(out.status, 204);
  assert.equal(opts?.hostname, "shop.example.com");
  assert.equal(opts?.path, "/wp-json/lmc/v1/stock?x=1");
  assert.equal(opts?.port, 443);
  // SNI و بررسی گواهی روی **نام** می‌مانند — پین‌کردن IP نباید TLS را
  // ضعیف کند.
  assert.equal(opts?.servername, "shop.example.com");

  // و `lookup` همان پین است، نه DNS.
  const look = opts?.lookup as ReturnType<typeof pinnedLookup>;
  assert.equal(typeof look, "function");
  let got: unknown;
  look("shop.example.com", { all: true }, (_e, a) => { got = a; });
  assert.deepEqual(got, [{ address: "203.0.113.10", family: 4 }]);
});

test("امضا روی بدنهٔ خام است و هدرها کامل می‌روند", async () => {
  const seen: { headers?: Record<string, string>; body?: string } = {};
  const send = makeWebPushSender(base, {
    resolveTarget: safeTarget,
    now: () => 1_789_311_045_000,
    nonce: () => "abcdef0123456789",
    post: async (_t, init) => {
      seen.headers = init.headers;
      seen.body = init.body;
      return { status: 200 };
    },
  });

  await send.send({
    topic: "web.stock_push",
    payload: { variationId: "01a0", sku: "S-1", onHand: 7, version: 42 },
  });

  assert.equal(seen.headers?.["x-lmc-timestamp"], "1789311045");
  assert.equal(seen.headers?.["x-lmc-nonce"], "abcdef0123456789");

  // امضا **مستقل** بازمحاسبه می‌شود، نه با همان تابعی که تولیدش کرده —
  // وگرنه فقط سازگاری تابع با خودش ثابت می‌شد.
  const expected = createHmac("sha256", SECRET)
    .update(`1789311045.abcdef0123456789.${seen.body}`, "utf8")
    .digest("hex");
  assert.equal(seen.headers?.["x-lmc-signature"], `sha256=${expected}`);
});

test("یک بایت تغییر در بدنه، امضا را عوض می‌کند", () => {
  const a = signBody(SECRET, "1", "n", '{"onHand":7}');
  const b = signBody(SECRET, "1", "n", '{"onHand":8}');
  assert.notEqual(a, b);
  // و جداکننده واقعاً جدا می‌کند: بی نقطه، این دو یکی می‌شدند.
  assert.notEqual(signBody(SECRET, "1", "23", "x"), signBody(SECRET, "12", "3", "x"));
});

test("مقایسهٔ امضا با طول متفاوت نمی‌شکند", () => {
  assert.equal(signatureMatches("abc", "abc"), true);
  assert.equal(signatureMatches("abc", "abcd"), false);
  assert.equal(signatureMatches("abc", "abd"), false);
});

test("مسیر مقصد از روی موضوع انتخاب می‌شود", async () => {
  const urls: string[] = [];
  const send = makeWebPushSender(base, {
    resolveTarget: async (raw) => { urls.push(raw); return await safeTarget(raw); },
    post: okPost(),
  });
  await send.send({ topic: "web.stock_push", payload: { variationId: "v" } });
  await send.send({ topic: "web.price_push", payload: { variationId: "v" } });
  await send.send({ topic: "web.instore_push", payload: { invoiceId: "i", branchId: "b" } });
  assert.deepEqual(urls, [
    "https://shop.example.com/wp-json/lmc/v1/stock",
    "https://shop.example.com/wp-json/lmc/v1/price",
    "https://shop.example.com/wp-json/lmc/v1/instore",
  ]);
});

test("خاموش‌بودن یک شکست نیست", async () => {
  let called = false;
  const send = makeWebPushSender(
    { ...base, enabled: false },
    { resolveTarget: safeTarget,
      post: async () => { called = true; return { status: 200 }; } },
  );
  await send.send({ topic: "web.stock_push", payload: { variationId: "v" } });
  assert.equal(called, false, "با خاموش‌بودن نباید درخواستی برود");
});

test("کلید نبود → خطا، و **دائمی نیست**", async () => {
  const send = makeWebPushSender({ ...base, secret: undefined }, { resolveTarget: safeTarget });
  await assert.rejects(
    () => send.send({ topic: "web.stock_push", payload: { variationId: "v" } }),
    (e: unknown) => {
      assert.ok(e instanceof SmsError);
      // مالک می‌تواند کلید را بگذارد و پیام‌های در صف بعداً بروند.
      // دائمی‌کردنش یعنی موجودی امروز برای همیشه نرود.
      assert.equal(e.permanent, false);
      return true;
    },
  );
});

test("«رد شد» از «نرسید» جدا است", async () => {
  const make = (status: number) =>
    makeWebPushSender(base, {
      resolveTarget: safeTarget,
      post: okPost(status),
    });

  // ۴۰۱ یعنی امضا غلط است؛ تلاش صدم هم درستش نمی‌کند.
  await assert.rejects(
    () => make(401).send({ topic: "web.stock_push", payload: { variationId: "v" } }),
    (e: unknown) => { assert.ok(e instanceof SmsError); assert.equal(e.permanent, true); return true; },
  );
  // ۵۰۳ یعنی سایت الان بالا نیست؛ Backoff بگیرد و دوباره برود.
  await assert.rejects(
    () => make(503).send({ topic: "web.stock_push", payload: { variationId: "v" } }),
    (e: unknown) => { assert.ok(e instanceof SmsError); assert.equal(e.permanent, false); return true; },
  );
});

test("محدودیت نرخ و timeout مقصد قابل تلاش مجدد هستند", async () => {
  for (const status of [408, 429]) {
    const sender = makeWebPushSender(base, { resolveTarget: safeTarget, post: okPost(status) });
    await assert.rejects(() => sender.send({ topic: "web.instore_push", payload: {} }),
      (e: unknown) => { assert.ok(e instanceof SmsError); assert.equal(e.permanent, false); return true; });
  }
});
