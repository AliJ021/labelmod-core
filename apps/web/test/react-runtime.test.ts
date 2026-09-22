import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

test("installed React and its renderer can render together", () => {
  assert.equal(renderToString(createElement("span", null, "حسابداری")), "<span>حسابداری</span>");
});
