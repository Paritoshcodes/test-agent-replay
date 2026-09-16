/**
 * Headless, no-browser measurement for BUG 2 (docs/DECISIONS.md): "measure it, don't eyeball it."
 * Builds the REAL swimlane model from the REAL synthetic-40 fixture, runs the REAL labelPolicyFor()
 * (engine/labelPolicy.ts, the exact function SwimlaneEngine.ts calls every frame -- not a re-implementation
 * that could drift from what actually renders), computes each visible label's approximate rendered
 * bounding box from the SAME font-size/max-width CSS values in global.css, and checks every same-lane,
 * same-vertical-slot (up/down alternation) pair of visible labels for horizontal overlap.
 *
 * Run: npx tsx scripts/verify-labels.ts
 */
import { buildSwimlaneModel, callOf, fullArgSummary, isToolCall } from "../src/engine/swimlane";
import { labelPolicyFor } from "../src/engine/labelPolicy";
import { synthetic40Step } from "../src/fixtures/synthetic";

const ZOOM_LEVELS = [1, 2, 4, 8, 16] as const;
const MIN_ZOOM_STEPS = 6;

// Mirrors SwimlaneEngine.resize()'s formula exactly.
function layoutFor(W: number) {
  const leftGutter = W < 640 ? 140 : W < 1300 ? 200 : 240;
  const plotL = leftGutter + 16;
  const plotR = Math.max(leftGutter + 32, W - 20);
  return { plotL, plotR };
}

function clampViewport(k0: number, k1: number, kEnd: number) {
  const span = Math.max(MIN_ZOOM_STEPS / 16, k1 - k0);
  if (k1 - k0 < span) k1 = k0 + span;
  if (k0 < 0) {
    k1 -= k0;
    k0 = 0;
  }
  if (k1 > kEnd) {
    k0 -= k1 - kEnd;
    k1 = kEnd;
  }
  k0 = Math.max(0, k0);
  return { k0, k1 };
}

// Font metrics from styles/global.css: base font-size clamp(13px,...,14px) -> assume 14px * rem.
// .sw-lbl-tool: 0.72rem, .sw-lbl-arg: 0.66rem. A monospace (Geist Mono) glyph is close to 0.6x font-size.
const BASE_PX = 14;
const CHAR_W_TOOL = 0.72 * BASE_PX * 0.6;
const CHAR_W_ARG = 0.66 * BASE_PX * 0.6;
const MAX_W_TOOL = 200; // .sw-lbl-tool max-width
const MAX_W_ARG = 220; // .sw-lbl-arg max-width

function labelHalfWidth(tool: string, arg: string, mode: "full" | "tool"): number {
  const toolW = Math.min(MAX_W_TOOL, tool.length * CHAR_W_TOOL);
  const argW = mode === "full" && arg ? Math.min(MAX_W_ARG, arg.length * CHAR_W_ARG) : 0;
  return Math.max(toolW, argW) / 2;
}

interface Placed {
  id: string;
  x: number;
  halfWidth: number;
}

function checkOverlaps(placed: Placed[]): { a: string; b: string; gap: number }[] {
  const sorted = [...placed].sort((a, b) => a.x - b.x);
  const overlaps: { a: string; b: string; gap: number }[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i];
    const next = sorted[i + 1];
    const gap = next.x - next.halfWidth - (cur.x + cur.halfWidth);
    if (gap < 0) overlaps.push({ a: cur.id, b: next.id, gap });
  }
  return overlaps;
}

function run() {
  const model = buildSwimlaneModel(synthetic40Step);
  const numLanes = model.lanes.length;
  console.log(`Model: ${model.lanes.length} lanes, ${model.n} steps, kEnd=${model.kEnd}`);
  for (const lane of model.lanes) {
    console.log(`  lane ${lane.id}: ${lane.nodes.length} nodes, densityRank=${lane.densityRank}, required=${lane.requiredCount}, permitted=${lane.permittedCount}`);
  }

  let totalChecked = 0;
  let totalOverlaps = 0;
  const failures: string[] = [];

  for (const W of [1920, 1366]) {
    const { plotL, plotR } = layoutFor(W);
    for (const factor of ZOOM_LEVELS) {
      const span = Math.max(MIN_ZOOM_STEPS, model.kEnd / factor);
      // Three representative pan positions: start, middle, end of the run.
      const centers = [span / 2, model.kEnd / 2, model.kEnd - span / 2];
      for (const center of centers) {
        const { k0, k1 } = clampViewport(center - span / 2, center + span / 2, model.kEnd);
        const density = (plotR - plotL) / (k1 - k0);
        const xOf = (k: number) => plotL + ((k - k0) / (k1 - k0)) * (plotR - plotL);

        // Group by lane, then by up/down slot (matches SwimlaneStage's `i % 2` alternation).
        for (const lane of model.lanes) {
          const groups: Placed[][] = [[], []];
          lane.nodes.forEach((node, i) => {
            if (node.k < k0 - 1 || node.k > k1 + 1) return; // not in view
            const call = callOf(node);
            const tool = isToolCall(call) ? call.tool : node.ghost ? "never called" : "";
            if (!tool) return;
            const isException = node.k === Math.round(center) || node.k === model.divergenceK;
            const policy = labelPolicyFor({ density, laneDensityRank: lane.densityRank, numLanes, isException });
            if (policy.labelMode === "hidden") return;
            const arg = fullArgSummary(call);
            const halfWidth = labelHalfWidth(tool, arg, policy.labelMode);
            groups[i % 2].push({ id: `${lane.id}/${node.id}(k=${node.k})`, x: xOf(node.k), halfWidth });
          });
          for (const group of groups) {
            totalChecked += group.length;
            const overlaps = checkOverlaps(group);
            totalOverlaps += overlaps.length;
            for (const o of overlaps) {
              failures.push(`W=${W} zoom=${factor}x center=${center.toFixed(1)} lane=${lane.id}: ${o.a} overlaps ${o.b} (gap=${o.gap.toFixed(1)}px)`);
            }
          }
        }
      }
    }
  }

  console.log(`\nChecked ${totalChecked} visible-label placements across ${[1920, 1366].length} widths x ${ZOOM_LEVELS.length} zoom levels x 3 pan positions.`);
  if (totalOverlaps === 0) {
    console.log("ZERO overlaps found. PASS.");
  } else {
    console.log(`${totalOverlaps} overlaps found. FAIL.`);
    for (const f of failures) console.log(`  ${f}`);
    process.exitCode = 1;
  }
}

run();

// Extra diagnostic: exactly how many labels show at FIT zoom (factor=1, centered mid-run) per width --
// confirms "no labels except exceptions" at fit, not just "no overlaps" (zero overlaps is trivially true
// if nothing is visible at all, so this checks the COUNT separately).
for (const W of [1920, 1366]) {
  const { plotL, plotR } = layoutFor(W);
  const model = buildSwimlaneModel(synthetic40Step);
  const numLanes = model.lanes.length;
  const span = model.kEnd;
  const density = (plotR - plotL) / span;
  let shown = 0;
  let exceptionsOnly = 0;
  const currentK = Math.round(model.kEnd / 2);
  for (const lane of model.lanes) {
    for (const node of lane.nodes) {
      const isException = node.k === currentK || node.k === model.divergenceK;
      const policy = labelPolicyFor({ density, laneDensityRank: lane.densityRank, numLanes, isException });
      if (policy.labelMode !== "hidden") {
        shown++;
        if (isException) exceptionsOnly++;
      }
    }
  }
  console.log(`FIT zoom, W=${W}: density=${density.toFixed(1)}px/step, ${shown} labels shown, ${exceptionsOnly} of which are exceptions (current/divergence)`);
}
