import type { SwimlaneEngine, LaneRect } from "./SwimlaneEngine";
import type { Lane, LaneNode } from "./swimlane";
import { P, rgba, type RGB } from "./palette";
import { clamp, easeOutCubic } from "./math";

/**
 * Canvas painter for the swimlane view. Same monochrome/hairline vocabulary as engine/render.ts
 * (palette.ts's tokens, no blur, no glow -- drama from motion and contrast, not filters), simplified where
 * the old engine's effects were specific to its exactly-two-lanes geometry (the grid-distortion field, the
 * beam packets): a swimlane stack has no single shared "golden rail" for those to run along. What is kept:
 * the tear ripple on divergence and the hatched "everything downstream is unattributed" territory band,
 * both of which generalize cleanly to "spans every visible lane" instead of "spans the gap between two".
 */

const TAU = Math.PI * 2;

function circle(c: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  c.beginPath();
  c.arc(x, y, Math.max(0, r), 0, TAU);
}

function stroke(c: CanvasRenderingContext2D, color: RGB, a: number, w: number): void {
  c.strokeStyle = rgba(color, a);
  c.lineWidth = w;
  c.stroke();
}

export function renderSwimlaneScene(e: SwimlaneEngine): void {
  const ctx = e.ctx!;
  const L = e.layout;
  ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, L.W, L.H);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  drawDotGrid(e, ctx);
  drawRuler(e, ctx);
  const rects = e.laneRects();
  const bottom = rects.length ? rects[rects.length - 1].top + rects[rects.length - 1].height : L.H;

  // VISUAL 1 (docs/DECISIONS.md): lanes can now scroll vertically. Everything below the ruler is clipped
  // to [rulerH, H] so a lane scrolled up past the top of the stack disappears BEHIND the ruler instead of
  // drawing over its ticks/labels -- the canvas bitmap's own edges already bound [0,H], but nothing
  // previously stopped content from painting into the ruler's own reserved band at the top.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, L.rulerH, L.W, Math.max(0, L.H - L.rulerH));
  ctx.clip();
  drawTerritory(e, ctx, bottom);
  // VISUAL 1 re-fix (docs/DECISIONS.md): a taller row (rowHeight.ts's LANE_H_MAX raised from 156 to 320)
  // did nothing to make the extra height read as intentional -- drawLaneTrack only ever painted a single
  // hairline at the row's vertical center, so a taller row was just more empty pixels around that line, the
  // literal "lanes cramped anyway" complaint even after the row itself grew. This band fills the row's own
  // [top, top+height] extent so a tall row visibly IS the lane's territory, not an accident of layout math.
  for (const r of rects) if (r.visible) drawLaneBand(e, ctx, r);
  for (const r of rects) if (r.visible) drawLaneTrack(e, ctx, r.lane, r.y);
  drawTethers(e, ctx, rects);
  for (const r of rects) if (r.visible) for (const node of r.lane.nodes) drawNode(e, ctx, node, r.y);
  drawForkOrigin(e, ctx, rects);
  drawPlayhead(e, ctx, bottom);
  ctx.restore();

  drawTearShocks(e, ctx);
}

function drawDotGrid(e: SwimlaneEngine, ctx: CanvasRenderingContext2D): void {
  const L = e.layout;
  const GRID = 24;
  ctx.fillStyle = rgba(P.fg, 0.045);
  for (let x = L.plotL % GRID; x < L.W; x += GRID) {
    for (let y = L.rulerH; y < L.H; y += GRID) {
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

function drawRuler(e: SwimlaneEngine, ctx: CanvasRenderingContext2D): void {
  const L = e.layout;
  const { k0, k1 } = e.viewport;
  const span = k1 - k0;
  // Adaptive tick step: always land on a "nice" integer spacing so labels never collide regardless of zoom.
  const targetPxPerTick = 64;
  const rawStep = (span * targetPxPerTick) / (L.plotR - L.plotL);
  const niceSteps = [1, 2, 5, 10, 20, 25, 50, 100];
  const step = niceSteps.find((s) => s >= rawStep) ?? niceSteps[niceSteps.length - 1];

  ctx.beginPath();
  ctx.moveTo(L.plotL, L.rulerH - 0.5);
  ctx.lineTo(L.plotR, L.rulerH - 0.5);
  stroke(ctx, P.fg, 0.14, 1);

  ctx.font = "10px var(--mono, monospace)";
  ctx.fillStyle = rgba(P.gray7, 1);
  ctx.textAlign = "center";
  const start = Math.floor(k0 / step) * step;
  for (let k = start; k <= k1 + step; k += step) {
    if (k < 0 || k > e.model.kEnd) continue;
    const x = e.xOf(k);
    if (x < L.plotL - 4 || x > L.plotR + 4) continue;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, L.rulerH - 6);
    ctx.lineTo(Math.round(x) + 0.5, L.rulerH);
    stroke(ctx, P.gray5, 1, 1);
    const label = k === 0 ? "T0" : k === e.model.kEnd ? "ANS" : String(Math.round(k));
    ctx.fillText(label, x, L.rulerH - 10);
  }
}

function drawTerritory(e: SwimlaneEngine, ctx: CanvasRenderingContext2D, bottom: number): void {
  const b = e.model.boundaryK;
  if (b === null) return;
  const L = e.layout;
  const x0 = e.xOf(b + 0.5);
  if (x0 > L.plotR) return;
  const x1 = L.plotR;
  ctx.save();
  ctx.beginPath();
  ctx.rect(Math.max(L.plotL, x0), L.rulerH, x1 - Math.max(L.plotL, x0), bottom - L.rulerH);
  ctx.clip();
  ctx.fillStyle = rgba(P.fg, 0.02);
  ctx.fillRect(x0, L.rulerH, x1 - x0, bottom - L.rulerH);
  const off = e.reduced ? 0 : (e.time * 4) % 8;
  ctx.beginPath();
  for (let x = Math.floor((x0 - 40) / 8) * 8 + off; x < x1; x += 8) {
    ctx.moveTo(x, bottom);
    ctx.lineTo(x + 40, bottom - 40);
  }
  stroke(ctx, P.fg, 0.05, 1);
  ctx.restore();
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.moveTo(Math.round(x0) + 0.5, L.rulerH);
  ctx.lineTo(Math.round(x0) + 0.5, bottom);
  stroke(ctx, P.fg, 0.32, 1);
  ctx.setLineDash([]);
}

function drawLaneBand(e: SwimlaneEngine, ctx: CanvasRenderingContext2D, r: LaneRect): void {
  const L = e.layout;
  const w = L.plotR - L.plotL;
  // Phase 2.2 (docs/DECISIONS.md): a fork lane's band/track is dashed and blue-tinted rather than a new
  // color or fill -- "live" is already blue in this vocabulary (palette.ts: "blue the live replay"), and a
  // fork is exactly a live run; dashed is this vocabulary's existing "hypothetical/not-yet-real" marker
  // (ghost/MISSING_STEP nodes already use it). No third scheme, per the task's own instruction.
  ctx.fillStyle = rgba(r.lane.isFork ? P.blue : P.fg, r.lane.isFork ? 0.03 : r.lane.depth === 0 ? 0.022 : 0.015);
  ctx.fillRect(L.plotL, r.top, w, r.height);
  ctx.beginPath();
  ctx.moveTo(L.plotL, Math.round(r.top) + 0.5);
  ctx.lineTo(L.plotR, Math.round(r.top) + 0.5);
  if (r.lane.isFork) ctx.setLineDash([4, 3]);
  stroke(ctx, r.lane.isFork ? P.blue : P.gray4, r.lane.isFork ? 0.4 : 0.6, 1);
  ctx.setLineDash([]);
}

function drawLaneTrack(e: SwimlaneEngine, ctx: CanvasRenderingContext2D, lane: Lane, y: number): void {
  const L = e.layout;
  ctx.beginPath();
  ctx.moveTo(L.plotL, Math.round(y) + 0.5);
  ctx.lineTo(L.plotR, Math.round(y) + 0.5);
  if (lane.isFork) ctx.setLineDash([6, 4]);
  stroke(ctx, lane.isFork ? P.blue : lane.depth === 0 ? P.fg : P.gray5, lane.isFork ? 0.6 : lane.depth === 0 ? 0.5 : 0.35, 1.25);
  ctx.setLineDash([]);
}

function drawTethers(e: SwimlaneEngine, ctx: CanvasRenderingContext2D, rects: { lane: Lane; y: number; visible: boolean }[]): void {
  const byId = new Map(rects.map((r) => [r.lane.id, r]));
  for (const r of rects) {
    if (!r.lane.spawnedByNodeId || !r.visible) continue;
    const parentRect = r.lane.parentLaneId ? byId.get(r.lane.parentLaneId) : undefined;
    const parentNode = e.model.nodeById.get(r.lane.spawnedByNodeId);
    if (!parentRect || !parentNode) continue;
    const x = e.xOf(parentNode.k);
    if (x < e.layout.plotL - 2 || x > e.layout.plotR + 2) continue;
    ctx.beginPath();
    ctx.moveTo(x, parentRect.y + 3);
    ctx.lineTo(x, r.y - 3);
    stroke(ctx, P.gray5, 0.55, 1);
    circle(ctx, x, r.y, 1.6);
    ctx.fillStyle = rgba(P.gray7, 0.8);
    ctx.fill();
  }
}

function drawNode(e: SwimlaneEngine, ctx: CanvasRenderingContext2D, node: LaneNode, y: number): void {
  const x = e.xOf(node.k);
  const L = e.layout;
  if (x < L.plotL - 12 || x > L.plotR + 12) return;
  const past = e.p >= node.k - 0.02;
  const color = node.flagged ? P.red : node.laneId === e.model.rootLaneId ? P.fg : P.blue;

  if (node.ghost) {
    circle(ctx, x, y, 6);
    ctx.setLineDash([2, 2.5]);
    stroke(ctx, P.gray7, 0.85, 1.25);
    ctx.setLineDash([]);
    return;
  }

  if (node.flagged) {
    circle(ctx, x, y, 7.5);
    ctx.fillStyle = rgba(P.bg, 1);
    ctx.fill();
    circle(ctx, x, y, 4);
    ctx.fillStyle = rgba(P.red, 1);
    ctx.fill();
    circle(ctx, x, y, 8);
    stroke(ctx, P.red, 0.55, 1.25);
    return;
  }

  // requires = solid filled dot. permits = a hollow ring -- the membership distinction lives IN the mark
  // itself, not a tooltip (Phase 1 addendum, docs/DECISIONS.md): a viewer scanning the lane sees at a
  // glance which calls are mandatory and which are merely allowed.
  if (node.membership === "permits") {
    circle(ctx, x, y, past ? 5.5 : 4.5);
    ctx.fillStyle = rgba(P.bg, 1);
    ctx.fill();
    stroke(ctx, color, past ? 0.9 : 0.5, 1.5);
  } else {
    circle(ctx, x, y, past ? 5 : 4);
    ctx.fillStyle = rgba(color, past ? 1 : 0.5);
    ctx.fill();
    if (!past) {
      circle(ctx, x, y, 5.5);
      stroke(ctx, color, 0.4, 1);
    }
  }

  if (Math.abs(e.p - node.k) < 0.35 && !e.reduced) {
    const f = ((e.time + node.k * 0.13) % 1.6) / 1.6;
    circle(ctx, x, y, 7 + 14 * easeOutCubic(f));
    stroke(ctx, color, 0.4 * (1 - f), 1);
  }
}

/** 2.2.2's own requirement: "the mutated step must be visibly marked as the origin of the fork" --
 * persistent (not just the one-shot tear ripple beginFork() already fires), for as long as a fork is
 * active. A dashed ring around the origin node, reusing the exact dash pattern fork lanes/ghost nodes
 * already use, plus a small upward tick -- no new visual language invented for this either. */
function drawForkOrigin(e: SwimlaneEngine, ctx: CanvasRenderingContext2D, rects: LaneRect[]): void {
  const fork = e.getUI().fork;
  if (!fork || !fork.originNodeId) return;
  const origin = e.model.nodeById.get(fork.originNodeId);
  if (!origin) return;
  const rect = rects.find((r) => r.lane.id === origin.laneId);
  if (!rect || !rect.visible) return;
  const x = e.xOf(origin.k);
  const L = e.layout;
  if (x < L.plotL - 12 || x > L.plotR + 12) return;
  const pulse = e.reduced ? 0 : (Math.sin(e.time * 2.4) + 1) / 2;
  ctx.setLineDash([3, 3]);
  circle(ctx, x, rect.y, 10 + pulse * 2);
  stroke(ctx, P.blue, 0.55 + pulse * 0.25, 1.5);
  ctx.setLineDash([]);
}

function drawPlayhead(e: SwimlaneEngine, ctx: CanvasRenderingContext2D, bottom: number): void {
  const L = e.layout;
  const x = Math.round(e.xOf(clamp(e.p, e.viewport.k0, e.viewport.k1))) + 0.5;
  if (x < L.plotL - 1 || x > L.plotR + 1) return;
  const g = ctx.createLinearGradient(0, L.rulerH, 0, bottom);
  g.addColorStop(0, rgba(P.fg, 0.6));
  g.addColorStop(1, rgba(P.fg, 0.15));
  ctx.beginPath();
  ctx.moveTo(x, L.rulerH);
  ctx.lineTo(x, bottom);
  ctx.strokeStyle = g;
  ctx.lineWidth = 1;
  ctx.stroke();
  circle(ctx, x, L.rulerH, 2.2);
  ctx.fillStyle = rgba(P.fg, 1);
  ctx.fill();
}

function drawTearShocks(e: SwimlaneEngine, ctx: CanvasRenderingContext2D): void {
  const rects = e.laneRects();
  const bottom = rects.length ? rects[rects.length - 1].top + rects[rects.length - 1].height : e.layout.H;
  for (const s of e.shocks()) {
    const T = (e.time - s.t0) / 1.3;
    if (T < 0 || T >= 1) continue;
    const fade = (1 - T) ** 2;
    const r = 10 + easeOutCubic(T) * 900;
    const cy = (e.layout.rulerH + bottom) / 2;
    circle(ctx, s.x, cy, r);
    stroke(ctx, P.red, 0.5 * fade, 1.25);
  }
}
