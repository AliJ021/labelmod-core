import { test } from "node:test";
import assert from "node:assert/strict";
import { LABEL_PRESETS, labelRowProblem, ROW_LIMITS } from "../src/lib/label-print.ts";

// Pure web/server contract: run once under Node, not once per browser/theme/width.
// Geometry, clipping, PDF pages and quiet zones remain real-browser tests.
const modulePath = "../../api/src/catalog/label.ts";
const label = await import(modulePath) as {
  ROLL_PRESETS_MM: ReadonlyArray<{ width: number; height: number }>;
  ROLL_MIN_WIDTH_MM: number; ROLL_MIN_HEIGHT_MM: number;
  ROLL_PRINTABLE_MAX_MM: number; ROLL_MEDIA_MIN_MM: number; ROLL_MEDIA_MAX_MM: number;
  ROLL_ROW_LIMITS: { maxColumns: number; maxGapMm: number; maxOffsetMm: number };
  rollRowProblem(width: number, row: { columns: number; gapMm: number; mediaWidthMm: number; offsetXMm: number; startSlot: number }): string | null;
};

test("label presets and minimum size agree between web and server", () => {
  assert.deepEqual(LABEL_PRESETS.map(({ width, height }) => ({ width, height })), label.ROLL_PRESETS_MM.map(p => ({ width: p.width, height: p.height })));
  assert.deepEqual([label.ROLL_MIN_WIDTH_MM, label.ROLL_MIN_HEIGHT_MM], [30, 20]);
});

test("web row validation mirrors server limits and every accept/reject in the grid", () => {
  assert.deepEqual(ROW_LIMITS, { printableMax: label.ROLL_PRINTABLE_MAX_MM, mediaMin: label.ROLL_MEDIA_MIN_MM, mediaMax: label.ROLL_MEDIA_MAX_MM,
    maxColumns: label.ROLL_ROW_LIMITS.maxColumns, maxGap: label.ROLL_ROW_LIMITS.maxGapMm, maxOffset: label.ROLL_ROW_LIMITS.maxOffsetMm });
  const mismatches: string[] = [];
  for (const width of [30, 40, 50, 58]) for (const columns of [1, 2, 3]) for (const gapMm of [-1, 0, 2, 3, 4, 5, 21])
    for (const mediaWidthMm of [14, 60, 100, 103, 106, 110, 118, 119]) for (const offsetXMm of [-11, -7, -1.5, -0.5, 0, 1.5, 2, 11]) for (const startSlot of [1, 2, 4]) {
      const row = { columns, gapMm, mediaWidthMm, offsetXMm, startSlot };
      if ((label.rollRowProblem(width, row) === null) !== (labelRowProblem(width, row) === null)) mismatches.push(JSON.stringify({ width, ...row }));
    }
  assert.deepEqual(mismatches, []);
});
