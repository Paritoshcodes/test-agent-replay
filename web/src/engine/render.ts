import { HIST, type Engine } from "./Engine";
import type { ForkNode } from "./model";
import { P, rgba, type RGB } from "./palette";
import { clamp, easeOutBack, easeOutCubic } from "./math";

/**
 * Canvas painter, one full-resolution pass per frame at the device pixel ratio. No offscreen bloom, no
 * blur: every mark is a hairline or a solid. Drama comes from motion (spring, ripple, beams), not glow.
 */

const TAU = Math.PI * 2;
const GRID = 22;
const LEVELS = 10;
const buckets: number[][] = Array.from({ length: LEVELS }, () => []);

export function renderScene(e: Engine): void {
  const ctx = e.ctx!;
  const L = e.layout;
  ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, L.W, L.H);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  drawGrid(e, ctx);
  drawRulers(e, ctx);
  drawTerritory(e, ctx);
  drawTearRuler(e, ctx);
  drawTrail(e, ctx);
  drawSplit(e, ctx);
  drawRails(e, ctx);
  drawThreads(e, ctx);
  drawBeams(e, ctx);
  for (const n of e.model.nodes) drawNode(e, ctx, n);
  drawHeads(e, ctx);
  drawPlayhead(e, ctx);
  drawShocks(e, ctx);
}

// ------------------------------------------------------------------ primitives

function path(e: Engine, c: CanvasRenderingContext2D, u0: number, u1: number, yf: (u: number) => number): boolean {
  if (u1 - u0 < 1e-4) return false;
  const x0 = e.xOf(u0);
  const x1 = e.xOf(u1);
  const n = Math.max(2, Math.ceil((x1 - x0) / 4));
  c.beginPath();
  for (let i = 0; i <= n; i++) {
    const u = u0 + ((u1 - u0) * i) / n;
    if (i === 0) c.moveTo(e.xOf(u), yf(u));
    else c.lineTo(e.xOf(u), yf(u));
  }
  return true;
}

function stroke(c: CanvasRenderingContext2D, color: RGB, a: number, w: number): void {
  c.strokeStyle = rgba(color, a);
  c.lineWidth = w;
  c.stroke();
}

function circle(c: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  c.beginPath();
  c.arc(x, y, Math.max(0, r), 0, TAU);
}

function roundSquare(c: CanvasRenderingContext2D, x: number, y: number, s: number, r: number): void {
  c.beginPath();
  c.roundRect(x - s, y - s, s * 2, s * 2, r);
}

// ------------------------------------------------------------------ field

function drawGrid(e: Engine, ctx: CanvasRenderingContext2D): void {
  const L = e.layout;
  const cur = e.cursor;
  const ox = -cur.nx * 6;
  const oy = -cur.ny * 4;
  const x0 = e.xOf(0);
  const y0 = L.yG;
  const maxD = Math.hypot(L.W, L.H) * 0.85;
  const rev = e.gridReveal();
  const xp = e.xOf(clamp(e.p, 0, e.model.kEnd));
  const shocks = e.shocks.filter((s) => e.time >= s.t0);
  for (const b of buckets) b.length = 0;

  const cols = Math.ceil(L.W / GRID) + 2;
  const rows = Math.ceil(L.H / GRID) + 2;
  for (let i = 0; i < cols; i++) {
    const bx = i * GRID + ((ox % GRID) + GRID) % GRID - GRID / 2;
    for (let j = 0; j < rows; j++) {
      const by = j * GRID + ((oy % GRID) + GRID) % GRID - GRID / 2;
      const front = clamp((rev * 1.25 - Math.hypot(bx - x0, by - y0) / maxD) / 0.1);
      if (front <= 0) continue;
      let x = bx;
      let y = by;
      let a = 0.1;
      if (by > L.top && by < L.bottom) a += 0.12 * Math.exp(-(((bx - xp) / 110) ** 2));
      if (cur.on > 0.01) a += 0.36 * cur.on * Math.exp(-(((bx - cur.px) ** 2 + (by - cur.py) ** 2) / (150 * 150)));
      for (const s of shocks) {
        const T = (e.time - s.t0) / 1.4;
        if (T >= 1) continue;
        const r = s.kind === "heal" ? (1 - easeOutCubic(T)) * 520 : 8 + easeOutCubic(T) * (s.kind === "arrive" ? 520 : 1300);
        const dx = bx - s.x;
        const dy = by - s.y;
        const dist = Math.hypot(dx, dy) || 1;
        const band = Math.exp(-(((dist - r) / 46) ** 2));
        const fade = (1 - T) ** 2 * s.strength;
        const push = (s.kind === "heal" ? -7 : 11) * band * fade;
        x += (dx / dist) * push;
        y += (dy / dist) * push;
        a += 0.55 * band * fade;
      }
      a *= front;
      if (a < 0.02) continue;
      buckets[Math.min(LEVELS - 1, Math.floor(a * LEVELS))].push(x, y);
    }
  }
  const s = 1.1;
  for (let b = 0; b < LEVELS; b++) {
    const pts = buckets[b];
    if (!pts.length) continue;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 2) ctx.rect(pts[i] - s / 2, pts[i + 1] - s / 2, s, s);
    ctx.fillStyle = rgba(P.fg, (b + 0.5) / LEVELS);
    ctx.fill();
  }
}

function drawRulers(e: Engine, ctx: CanvasRenderingContext2D): void {
  const L = e.layout;
  const reveal = e.lineReveal() * e.model.kEnd;
  const hovered = e.model.nodes.find((n) => n.id === e.hover);
  ctx.lineWidth = 1;
  for (let k = 0; k <= e.model.kEnd; k++) {
    const vis = clamp((reveal - k + 0.2) / 0.3);
    if (vis <= 0) continue;
    const x = Math.round(e.xOf(k)) + 0.5;
    const hot = hovered && hovered.k === k ? (e.bloom.get(hovered.id) ?? 0) : 0;
    ctx.beginPath();
    ctx.moveTo(x, L.top + 36);
    ctx.lineTo(x, L.bottom);
    ctx.strokeStyle = rgba(P.fg, (0.04 + 0.1 * hot) * vis);
    ctx.stroke();
  }
}

function hatch(ctx: CanvasRenderingContext2D, xa: number, xb: number, ya: number, yb: number, off: number, a: number): void {
  if (xb - xa < 1) return;
  const h = yb - ya;
  ctx.save();
  ctx.beginPath();
  ctx.rect(xa, ya, xb - xa, h);
  ctx.clip();
  ctx.beginPath();
  for (let x = Math.floor((xa - h) / 8) * 8 + off; x < xb; x += 8) {
    ctx.moveTo(x, yb);
    ctx.lineTo(x + h, ya);
  }
  ctx.strokeStyle = rgba(P.fg, a);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function drawTerritory(e: Engine, ctx: CanvasRenderingContext2D): void {
  const b = e.model.boundary;
  if (b === null) return;
  const L = e.layout;
  const reveal = e.lineReveal() * e.model.kEnd;
  const vis = clamp((reveal - b - 0.5) / 0.4);
  if (vis <= 0) return;
  const x0 = Math.round(e.xOf(b + 0.5)) + 0.5;
  const x1 = Math.min(L.mainW, e.xOf(e.model.kEnd) + 56);
  const ya = Math.max(L.top + 44, L.yG - 104);
  const yb = Math.min(L.bottom - 44, L.yG + L.gap + 104);
  const xp = clamp(e.xOf(clamp(e.p, 0, e.model.kEnd)), x0, x1);
  const off = e.reduced ? 0 : (e.time * 5) % 8;
  ctx.globalAlpha = vis;
  ctx.fillStyle = rgba(P.fg, 0.014);
  ctx.fillRect(x0, ya, x1 - x0, yb - ya);
  hatch(ctx, x0, xp, ya, yb, off, 0.07);
  hatch(ctx, xp, x1, ya, yb, off, 0.03);
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.moveTo(x0, ya - 22);
  ctx.lineTo(x0, yb);
  stroke(ctx, P.fg, e.p >= b + 0.5 ? 0.5 : 0.22, 1);
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x0, Math.round(ya) + 0.5);
  ctx.lineTo(x1, Math.round(ya) + 0.5);
  ctx.moveTo(x0, Math.round(yb) - 0.5);
  ctx.lineTo(x1, Math.round(yb) - 0.5);
  stroke(ctx, P.fg, 0.07, 1);
  ctx.globalAlpha = 1;
}

function drawTearRuler(e: Engine, ctx: CanvasRenderingContext2D): void {
  const d = e.model.d;
  if (d === null || !e.diverged) return;
  const L = e.layout;
  const x = Math.round(e.xOf(d - 0.5)) + 0.5;
  const since = e.time - e.tearT;
  const flash = e.reduced ? 0 : Math.exp(-since * 2.4);
  const s = clamp(e.sep);
  ctx.setLineDash([2, 4]);
  ctx.beginPath();
  ctx.moveTo(x, L.yG - 56);
  ctx.lineTo(x, L.yG + L.gap * s + 56);
  stroke(ctx, P.red, (0.28 + 0.6 * flash) * s, 1);
  ctx.setLineDash([]);
}

// ------------------------------------------------------------------ the fork

function goldY(e: Engine): (u: number) => number {
  const y = e.layout.yG;
  return () => y;
}

function drawRails(e: Engine, ctx: CanvasRenderingContext2D): void {
  const m = e.model;
  const head = clamp(e.p, 0, m.kEnd);
  const R = e.lineReveal() * m.kEnd;
  const gy = goldY(e);

  if (path(e, ctx, 0, Math.min(head, R), gy)) stroke(ctx, P.fg, 0.95, 1.5);
  if (R > head && path(e, ctx, head, R, gy)) stroke(ctx, P.gray4, 1, 1.5);
  if (head > 0.001 && path(e, ctx, 0, head, (u) => e.candidateY(u))) stroke(ctx, P.blue, 1, 1.5);
}

function histAt(e: Engine, back: number): number {
  return e.sepHist[(e.histI - back + HIST * 4) % HIST];
}

function drawTrail(e: Engine, ctx: CanvasRenderingContext2D): void {
  const d = e.model.d;
  if (d === null || e.reduced) return;
  if (Math.abs(e.sepV) < 0.12 && e.time - e.tearT > 0.5) return;
  const head = clamp(e.p, 0, e.model.kEnd);
  const from = Math.max(0, d - 1);
  for (let i = 1; i <= 4; i++) {
    const s = histAt(e, i * 3);
    if (Math.abs(s - e.sep) < 0.01) continue;
    if (path(e, ctx, from, head, (u) => e.candidateY(u, s))) stroke(ctx, P.blue, 0.2 * (1 - i / 5), 1);
  }
}

function drawSplit(e: Engine, ctx: CanvasRenderingContext2D): void {
  if (e.reduced || e.model.d === null) return;
  const t = (e.time - e.tearT) / 0.4;
  if (t < 0 || t >= 1) return;
  const k = (1 - t) ** 2;
  const head = clamp(e.p, 0, e.model.kEnd);
  const from = Math.max(0, e.model.d - 1.2);
  ctx.globalCompositeOperation = "lighter";
  for (const [dx, color] of [
    [-3, P.red],
    [3, P.blue],
  ] as const) {
    ctx.save();
    ctx.translate(dx * k, 0);
    if (path(e, ctx, from, head, (u) => e.candidateY(u))) stroke(ctx, color, 0.6 * k, 1.5);
    ctx.restore();
  }
  ctx.globalCompositeOperation = "source-over";
}

function drawThreads(e: Engine, ctx: CanvasRenderingContext2D): void {
  const m = e.model;
  if (m.d === null) return;
  const L = e.layout;
  for (const row of m.run.result.steps) {
    if (row.step < m.d || !row.golden || !row.candidate) continue;
    const k = row.step;
    const vis = clamp((e.p - k) / 0.3);
    if (vis <= 0) continue;
    const x = Math.round(e.xOf(k)) + 0.5;
    const ya = L.yG + 9;
    const yb = e.candidateY(k) - 9;
    if (yb - ya < 8) continue;
    const tone = row.cause ? P.red : P.fg;
    ctx.setLineDash([1, 4]);
    ctx.beginPath();
    ctx.moveTo(x, ya);
    ctx.lineTo(x, yb);
    stroke(ctx, tone, 0.3 * vis, 1);
    ctx.setLineDash([]);
    if (!e.reduced) {
      const f = (e.time * 0.55 + k * 0.29) % 1;
      circle(ctx, x, ya + (yb - ya) * easeOutCubic(f), 1.6);
      ctx.fillStyle = rgba(tone, 0.9 * vis * Math.sin(Math.PI * f));
      ctx.fill();
    }
  }
}

function drawBeams(e: Engine, ctx: CanvasRenderingContext2D): void {
  if (e.reduced) return;
  const head = clamp(e.p, 0, e.model.kEnd);
  const gy = goldY(e);
  for (const b of e.beams) {
    const yf = b.lane === "g" ? gy : (u: number) => e.candidateY(u);
    const color = b.lane === "g" ? P.fg : P.blueHi;
    const tail = 0.9;
    const u1 = Math.min(b.u, head);
    const u0 = Math.max(0, b.u - tail);
    if (u1 <= u0) continue;
    const N = 14;
    ctx.lineWidth = 1.6;
    for (let i = 0; i < N; i++) {
      const a0 = b.u - tail + (tail * i) / N;
      const a1 = b.u - tail + (tail * (i + 1)) / N;
      const s0 = Math.max(a0, u0);
      const s1 = Math.min(a1, u1);
      if (s1 <= s0) continue;
      ctx.beginPath();
      ctx.moveTo(e.xOf(s0), yf(s0));
      ctx.lineTo(e.xOf((s0 + s1) / 2), yf((s0 + s1) / 2));
      ctx.lineTo(e.xOf(s1), yf(s1));
      ctx.strokeStyle = rgba(color, ((i + 1) / N) ** 2);
      ctx.stroke();
    }
    if (b.u <= head) {
      circle(ctx, e.xOf(b.u), yf(b.u), 1.8);
      ctx.fillStyle = rgba(color, 1);
      ctx.fill();
    }
  }
}

function drawNode(e: Engine, ctx: CanvasRenderingContext2D, node: ForkNode): void {
  const pres = e.presence(node);
  if (pres <= 0) return;
  const x = e.xOf(node.k);
  const y = e.laneY(node.lane, node.k);
  const sc = e.reduced ? 1 : easeOutBack(pres, 2.4);
  const past = e.p >= node.k - 0.02;
  const bloom = e.bloom.get(node.id) ?? 0;
  const dim = node.unattributed ? 0.6 : 1;
  const cause = node.row?.cause ?? null;
  const cut = (r: number) => {
    circle(ctx, x, y, r * sc);
    ctx.fillStyle = rgba(P.bg, 1);
    ctx.fill();
  };
  const dot = (r: number, c: RGB, a = 1) => {
    circle(ctx, x, y, r * sc);
    ctx.fillStyle = rgba(c, a * dim);
    ctx.fill();
  };
  const ring = (r: number, c: RGB, a: number, w = 1.25) => {
    circle(ctx, x, y, r * sc);
    stroke(ctx, c, a * dim, w);
  };

  switch (node.kind) {
    case "origin": {
      cut(10);
      dot(4.5, P.fg);
      ring(9, P.gray5, 1);
      if (!e.reduced) {
        const a = e.time * 1.6;
        ctx.beginPath();
        ctx.arc(x, y, 9 * sc, a, a + 1.1);
        stroke(ctx, P.fg, 0.8, 1.25);
      }
      break;
    }
    case "step": {
      const color = node.lane === "candidate" ? P.blue : P.fg;
      if (node.lane === "candidate" && node.flagged) {
        cut(8);
        dot(4.5, P.red);
        ring(8.5, P.red, 0.55);
        if (cause === "UNSOURCED_ARGUMENT") {
          ctx.beginPath();
          ctx.moveTo(x, y - 12.5 * sc);
          ctx.lineTo(x + 3 * sc, y - 15.5 * sc);
          ctx.lineTo(x, y - 18.5 * sc);
          ctx.lineTo(x - 3 * sc, y - 15.5 * sc);
          ctx.closePath();
          ctx.fillStyle = rgba(P.red, dim);
          ctx.fill();
        }
      } else if (node.flagged) {
        cut(7);
        ctx.setLineDash([2, 2.5]);
        ring(5, P.red, past ? 0.95 : 0.45);
        ctx.setLineDash([]);
        dot(1.5, P.gray7);
      } else if (past) {
        cut(7);
        dot(4, color);
      } else {
        cut(6);
        ring(4.25, P.gray5, 1);
      }
      break;
    }
    case "ghost": {
      cut(7);
      ctx.setLineDash([2, 2.5]);
      ring(5, P.gray7, 0.8);
      ctx.setLineDash([]);
      break;
    }
    case "answer": {
      const color = node.lane === "candidate" ? P.blue : P.fg;
      roundSquare(ctx, x, y, 8 * sc, 3);
      ctx.fillStyle = rgba(P.bg, 1);
      ctx.fill();
      roundSquare(ctx, x, y, 5.5 * sc, 2);
      if (past) {
        ctx.fillStyle = rgba(color, dim);
        ctx.fill();
      } else {
        stroke(ctx, P.gray5, 1, 1.25);
      }
      if (node.lane === "fused" && past && !e.model.run.result.answer_matched) {
        circle(ctx, x + 8 * sc, y - 8 * sc, 2.2 * sc);
        ctx.fillStyle = rgba(P.amber, 1);
        ctx.fill();
      }
      break;
    }
  }

  if (bloom > 0.005) {
    const r = (10 + 5 * bloom) * sc;
    circle(ctx, x, y, r);
    stroke(ctx, node.flagged ? P.red : P.fg, 0.55 * bloom, 1);
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = (i * TAU) / 4;
      ctx.moveTo(x + Math.cos(a) * (r + 3), y + Math.sin(a) * (r + 3));
      ctx.lineTo(x + Math.cos(a) * (r + 7), y + Math.sin(a) * (r + 7));
    }
    stroke(ctx, P.fg, 0.7 * bloom, 1);
  }

  // The node under the playhead pings like a sonar return.
  if (!e.reduced && pres >= 1 && Math.abs(e.p - node.k) < 0.3 && e.mode !== "rewind") {
    const f = ((e.time + node.k * 0.13) % 2.1) / 2.1;
    const tone = node.flagged ? P.red : node.lane === "candidate" ? P.blue : P.fg;
    circle(ctx, x, y, 7 + 17 * easeOutCubic(f));
    stroke(ctx, tone, 0.5 * (1 - f) ** 1.5, 1);
  }
}

function drawHeads(e: Engine, ctx: CanvasRenderingContext2D): void {
  const kEnd = e.model.kEnd;
  const R = e.lineReveal() * kEnd;
  const L = e.layout;
  if (R > 0.001 && R < kEnd - 0.001) {
    const x = e.xOf(R);
    const g = ctx.createLinearGradient(x - 90, 0, x, 0);
    g.addColorStop(0, rgba(P.fg, 0));
    g.addColorStop(1, rgba(P.fg, 0.9));
    ctx.beginPath();
    ctx.moveTo(Math.max(e.xOf(0), x - 90), L.yG);
    ctx.lineTo(x, L.yG);
    ctx.strokeStyle = g;
    ctx.lineWidth = 2;
    ctx.stroke();
    circle(ctx, x, L.yG, 2.4);
    ctx.fillStyle = rgba(P.fg, 1);
    ctx.fill();
  }
  const head = clamp(e.p, 0, kEnd);
  if (head > 0.02 && head < kEnd - 0.02) {
    const x = e.xOf(head);
    const y = e.candidateY(head);
    circle(ctx, x, y, 2.6);
    ctx.fillStyle = rgba(P.blueHi, 1);
    ctx.fill();
    circle(ctx, x, y, 5.5);
    stroke(ctx, P.blue, 0.45, 1);
  }
}

// ------------------------------------------------------------------ instrument

function drawPlayhead(e: Engine, ctx: CanvasRenderingContext2D): void {
  const L = e.layout;
  const x = Math.round(e.xOf(clamp(e.p, -0.25, e.model.kEnd + 0.25))) + 0.5;
  const reveal = e.reduced ? 1 : clamp((e.time - e.introT0) / 0.6);
  const hot = e.mode === "drag" ? 1 : 0;
  const top = L.top + 30;
  const g = ctx.createLinearGradient(0, top, 0, L.trackY);
  g.addColorStop(0, rgba(P.fg, 0.55 + 0.3 * hot));
  g.addColorStop(0.5, rgba(P.fg, 0.2 + 0.2 * hot));
  g.addColorStop(1, rgba(P.fg, 0.5 + 0.3 * hot));
  ctx.globalAlpha = reveal;
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x, L.bottom);
  ctx.strokeStyle = g;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  const ys = [L.yG];
  if (e.model.d !== null && e.sep > 0.05) ys.push(e.candidateY(clamp(e.p, 0, e.model.kEnd)));
  for (const y of ys) {
    ctx.moveTo(x - 9, Math.round(y) + 0.5);
    ctx.lineTo(x - 4, Math.round(y) + 0.5);
    ctx.moveTo(x + 4, Math.round(y) + 0.5);
    ctx.lineTo(x + 9, Math.round(y) + 0.5);
  }
  stroke(ctx, P.fg, 0.8, 1);
  ctx.globalAlpha = 1;
}

function drawShocks(e: Engine, ctx: CanvasRenderingContext2D): void {
  for (const s of e.shocks) {
    const T = (e.time - s.t0) / 1.4;
    if (T < 0 || T >= 1) continue;
    const fade = (1 - T) ** 2 * s.strength;
    if (s.kind === "heal") {
      circle(ctx, s.x, s.y, (1 - easeOutCubic(T)) * 520);
      stroke(ctx, P.fg, 0.35 * fade, 1);
      continue;
    }
    const tone = s.kind === "tear" ? P.red : e.model.d === null ? P.green : P.fg;
    const r = 8 + easeOutCubic(T) * (s.kind === "arrive" ? 520 : 1300);
    circle(ctx, s.x, s.y, r);
    stroke(ctx, tone, 0.8 * fade, 1.25);
    circle(ctx, s.x, s.y, r * 0.965);
    stroke(ctx, tone, 0.12 * fade, 8);
  }
}
