/** دونات کانال‌ها: فقط هندسه؛ منفی یا جمع صفر یعنی بی دونات. */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { channelArcs } from "../src/lib/channel-share.ts";

describe("سهم کانال‌ها", () => {
  test("سهم‌ها پشت‌هم و جمعشان یک", () => {
    const arcs = channelArcs([{ channel: "pos", salesAmount: "300" }, { channel: "web", salesAmount: "100" }])!;
    assert.deepEqual(arcs.map(a => [a.channel, a.start, a.length]), [["pos", 0, 0.75], ["web", 0.75, 0.25]]);
  });
  test("فروش منفی یک کانال (مرجوعی بیش از فروش) دونات نمی‌سازد", () => {
    assert.equal(channelArcs([{ channel: "pos", salesAmount: "300" }, { channel: "web", salesAmount: "-100" }]), null);
  });
  test("روز بی فروش یا فقط صفر، دونات ندارد", () => {
    assert.equal(channelArcs([]), null);
    assert.equal(channelArcs([{ channel: "pos", salesAmount: "0" }]), null);
  });
  test("کانال صفر کمانی نمی‌گیرد ولی بقیه درست می‌مانند", () => {
    const arcs = channelArcs([{ channel: "pos", salesAmount: "5" }, { channel: "phone", salesAmount: "0" }])!;
    assert.deepEqual(arcs.map(a => a.channel), ["pos"]);
    assert.equal(arcs[0]!.length, 1);
  });
  test("مبلغ بزرگ‌تر از دقت number سهم را خراب نمی‌کند", () => {
    const big = (10n ** 20n).toString();
    const arcs = channelArcs([{ channel: "pos", salesAmount: big }, { channel: "web", salesAmount: big }])!;
    assert.deepEqual(arcs.map(a => a.length), [0.5, 0.5]);
  });
});
