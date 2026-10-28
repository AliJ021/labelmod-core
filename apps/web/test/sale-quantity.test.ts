import { test } from "node:test";
import assert from "node:assert/strict";
import { quantityUnits, saleQuantity } from "../src/lib/sale-quantity.ts";
import { steppedQty } from "../src/lib/cart.ts";

test("whole default and exact optional thousandths, without hidden rounding", () => {
  assert.equal(saleQuantity("۱٫۰۰۰", false), "1");
  assert.equal(saleQuantity("۱٫۵", false), null);
  assert.equal(saleQuantity("۱٫۵", true), "1.5");
  assert.equal(saleQuantity("٠٫٠٠١", true), "0.001");
  assert.equal(saleQuantity("99999999999.999", true), "99999999999.999");
  for (const v of ["0", "-1", "1.0001", "1e2", "1,5", "100000000000", ""]) assert.equal(saleQuantity(v, true), null, v);
  assert.equal(quantityUnits("1.123"), 1123n);
  assert.equal(steppedQty("1.500", 1), "2.5");
  assert.equal(steppedQty("1.500", -1), "0.5");
  assert.equal(steppedQty("0.5", -1), null);
  assert.equal(steppedQty("99999999999.999", 1), null);
});
