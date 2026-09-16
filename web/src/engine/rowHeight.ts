import { clamp, lerp } from "./math";

/**
 * VISUAL 1 fix (docs/DECISIONS.md: "60% of the screen is empty"), pulled into its own pure, DOM-free
 * module for the same reason as labelPolicy.ts: one real implementation, shared by SwimlaneEngine.ts and
 * scripts/verify-layout.ts, instead of a hand-duplicated formula that could quietly drift from what
 * actually renders.
 */

export const LANE_H_MIN = 56;
// VISUAL 1 re-fix (docs/DECISIONS.md): 156 was reached by the natural division for anything from 3 lanes
// up at typical viewport heights, so raising it changes nothing there -- but for 1-2 open lanes (the real
// case that read as "60% of the screen is empty, lanes cramped anyway") it was the binding constraint,
// capping a single lane at ~23% of the available height. 320 lets 1-2 lanes actually stretch to fill most
// of the region; 3+ lanes are still governed by the natural division below this, unchanged.
export const LANE_H_MAX = 320;
export const LANE_COLLAPSED_H = 28;
export const LANE_GAP = 10;

/** Vertical px actually available for the lane stack, given the container height and ruler height. */
export function availableLaneHeight(containerH: number, rulerH: number): number {
  return Math.max(0, containerH - (rulerH + 10) - 16);
}

/** A collapsed lane always takes LANE_COLLAPSED_H (fixed -- collapsing means "take less room"). Every OPEN
 *  lane shares whatever vertical space is left after that, equally, clamped to [LANE_H_MIN, LANE_H_MAX] --
 *  few open lanes stretch generously toward LANE_H_MAX; many open lanes fall back to LANE_H_MIN once the
 *  equal share drops below it, which is also the signal that content no longer fits and the stack should
 *  scroll instead of crushing rows further. `progs` is each lane's own collapse progress (0 open .. 1
 *  collapsed), for lerping smoothly through the animation instead of snapping between the two heights. */
export function computeRowHeights(progs: number[], containerH: number, rulerH: number): number[] {
  const n = progs.length;
  if (n === 0) return [];
  let collapsedTotal = 0;
  let openCount = 0;
  for (const p of progs) {
    if (p >= 0.5) collapsedTotal += LANE_COLLAPSED_H;
    else openCount++;
  }
  const gapsTotal = Math.max(0, n - 1) * LANE_GAP;
  const remaining = availableLaneHeight(containerH, rulerH) - collapsedTotal - gapsTotal;
  const openHeight = openCount > 0 ? clamp(remaining / openCount, LANE_H_MIN, LANE_H_MAX) : LANE_H_MIN;
  return progs.map((p) => lerp(LANE_COLLAPSED_H, openHeight, clamp(1 - p * 2)));
}

export function naturalContentExtent(progs: number[], containerH: number, rulerH: number): number {
  const heights = computeRowHeights(progs, containerH, rulerH);
  return heights.reduce((a, b) => a + b, 0) + Math.max(0, heights.length - 1) * LANE_GAP;
}
