/**
 * Headless, no-browser measurement for VISUAL 1 (docs/DECISIONS.md): "60% of the screen is empty" / "few
 * lanes should use the space, many lanes should scroll". Calls the REAL computeRowHeights/
 * naturalContentExtent (engine/rowHeight.ts, the exact functions SwimlaneEngine.ts calls every frame) for
 * representative lane counts and viewport heights, and prints the actual numbers -- not a claim about them.
 *
 * Run: npx tsx scripts/verify-layout.ts
 */
import { LANE_H_MIN, LANE_H_MAX, LANE_COLLAPSED_H, computeRowHeights, naturalContentExtent, availableLaneHeight } from "../src/engine/rowHeight";

const RULER_H = 28;
// RunView.tsx's fixed chrome heights: HEADER_H=56, HERO_H=150, TIMELINE_H=150.
const CHROME_H = 56 + 150 + 150;

function containerHeightFor(viewportH: number): number {
  return viewportH - CHROME_H;
}

function report(label: string, laneCount: number, viewportH: number) {
  const containerH = containerHeightFor(viewportH);
  const avail = availableLaneHeight(containerH, RULER_H);
  const progs = new Array(laneCount).fill(0); // all open
  const heights = computeRowHeights(progs, containerH, RULER_H);
  const extent = naturalContentExtent(progs, containerH, RULER_H);
  const fits = extent <= avail + 0.5;
  const rowH = heights[0] ?? 0;
  console.log(
    `${label}: viewport=${viewportH}px -> lane region=${containerH}px, available=${avail.toFixed(0)}px | ` +
      `${laneCount} open lane(s) -> row height=${rowH.toFixed(0)}px (floor ${LANE_H_MIN}, ceiling ${LANE_H_MAX}), ` +
      `content=${extent.toFixed(0)}px, ${fits ? "FITS (no scroll)" : `OVERFLOWS by ${(extent - avail).toFixed(0)}px -> scrolls`}`,
  );
}

console.log("--- 4 lanes (the real synthetic-40 fixture's shape) ---");
report("1920x1080", 4, 1080);
report("1366x768 ", 4, 768);

console.log("\n--- 1 lane ---");
report("1920x1080", 1, 1080);
report("1366x768 ", 1, 768);

console.log("\n--- 12 lanes (stress case: many more lanes than fit) ---");
report("1920x1080", 12, 1080);
report("1366x768 ", 12, 768);

console.log("\n--- Collapsed-lane row height sanity check (should always be exactly LANE_COLLAPSED_H) ---");
const collapsedHeights = computeRowHeights([1, 1, 1, 1], containerHeightFor(1080), RULER_H);
console.log(`4 fully-collapsed lanes -> heights: ${collapsedHeights.map((h) => h.toFixed(1)).join(", ")} (expected all ${LANE_COLLAPSED_H})`);
const ok = collapsedHeights.every((h) => Math.abs(h - LANE_COLLAPSED_H) < 0.5);
console.log(ok ? "PASS" : "FAIL");
if (!ok) process.exitCode = 1;
