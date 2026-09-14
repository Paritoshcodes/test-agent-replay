import { buildModel, type ForkModel, type ForkNode, type Lane } from "./model";
import type { GateRun } from "../types/gate";
import { clamp, damp, easeInCubic, easeInOutCubic, rubber, smootherstep, springStep } from "./math";
import { renderScene } from "./render";

/**
 * The instrument's clock, physics and canvas driver. Everything that moves every frame lives here, off
 * React: the playhead, the tear spring, shockwaves, beams, the cursor spotlight. React hears only about
 * discrete changes (integer step, torn or not, play state, loaded tape) through subscribe().
 */

export interface Layout {
  W: number;
  H: number;
  dpr: number;
  sideW: number;
  headerH: number;
  heroH: number;
  timelineH: number;
  mainW: number;
  plotL: number;
  plotR: number;
  top: number;
  bottom: number;
  yG: number;
  gap: number;
  rail: number;
  trackY: number;
}

export interface Shock {
  t0: number;
  x: number;
  y: number;
  strength: number;
  kind: "tear" | "heal" | "arrive";
}

export interface Beam {
  u: number;
  lane: "g" | "c";
  v: number;
}

export interface UIState {
  modelIndex: number;
  step: number;
  diverged: boolean;
  playing: boolean;
  dragging: boolean;
  rewinding: boolean;
}

type Mode = "idle" | "play" | "drag" | "settle" | "rewind";

interface Rewind {
  from: number;
  t0: number;
  dur: number;
  phase: "retract" | "undraw";
  undrawT0: number;
  next: ForkModel;
  index: number;
}

interface Anchor {
  el: HTMLElement;
  t: string;
  o: string;
  w: string;
}

export const HIST = 32;
const UNDRAW = 0.34;

export class Engine {
  model: ForkModel;
  reduced = false;
  time = 0;
  timeScale = 1;

  p = 0;
  pv = 0;
  mode: Mode = "idle";
  private settleTarget = 0;
  private settleK = 200;
  private settleC = 24;
  private samples: { t: number; p: number }[] = [];
  private grab = 0;
  private wheelIdle = 0;

  sep = 0;
  sepV = 0;
  sepTarget = 0;
  sepHist = new Float32Array(HIST);
  histI = 0;
  diverged = false;
  tearT = -99;

  shocks: Shock[] = [];
  beams: Beam[] = [];
  private beamClock = { g: 0.15, c: 1.0 };

  introT0 = 0;
  gridT0 = 0;
  private autoplayAt: number | null = null;
  private rewind: Rewind | null = null;

  /** tx/ty: pointer in px. px/py: smoothed. nx/ny: smoothed, normalized to [-1, 1] for parallax. */
  cursor = { tx: 0, ty: 0, px: 0, py: 0, nx: 0, ny: 0, tnx: 0, tny: 0, on: 0, onT: 0 };
  hover: string | null = null;
  bloom = new Map<string, number>();

  layout: Layout = { W: 1, H: 1, dpr: 1, sideW: 0, headerH: 0, heroH: 0, timelineH: 0, mainW: 1, plotL: 0, plotR: 1, top: 0, bottom: 1, yG: 0, gap: 0, rail: 4, trackY: 0 };
  ctx: CanvasRenderingContext2D | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private stage: HTMLElement | null = null;
  private anchors = new Map<string, Anchor>();
  private refs = new Map<string, (el: HTMLElement | null) => void>();
  private raf = 0;
  private lastNow = 0;
  private dirty = true;

  private ui: UIState;
  private listeners = new Set<() => void>();

  constructor(run: GateRun, index: number) {
    this.model = buildModel(run);
    this.ui = { modelIndex: index, step: 0, diverged: false, playing: false, dragging: false, rewinding: false };
  }

  // ------------------------------------------------------------------ React bridge

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getUI = (): UIState => this.ui;

  private notify(): void {
    this.listeners.forEach((l) => l());
  }

  private syncUI(): void {
    const u = this.ui;
    const step = Math.round(clamp(this.p, 0, this.model.kEnd));
    const playing = this.mode === "play";
    const dragging = this.mode === "drag";
    const rewinding = this.mode === "rewind";
    if (u.step !== step || u.diverged !== this.diverged || u.playing !== playing || u.dragging !== dragging || u.rewinding !== rewinding) {
      this.ui = { modelIndex: u.modelIndex, step, diverged: this.diverged, playing, dragging, rewinding };
      this.notify();
    }
  }

  /** Stable ref callback per key: the engine writes transforms straight to these elements every frame. */
  ref(key: string): (el: HTMLElement | null) => void {
    let f = this.refs.get(key);
    if (!f) {
      f = (el) => {
        if (el) this.anchors.set(key, { el, t: "", o: "", w: "" });
        else this.anchors.delete(key);
        this.dirty = true;
      };
      this.refs.set(key, f);
    }
    return f;
  }

  // ------------------------------------------------------------------ lifecycle

  attach(canvas: HTMLCanvasElement, stage: HTMLElement): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.stage = stage;
    this.resize();
    this.gridT0 = this.time;
    this.introT0 = this.time + 0.3;
    if (this.reduced) this.finalState();
    else this.autoplayAt = this.time + 2.0;
    this.lastNow = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      this.tick(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  detach(): void {
    cancelAnimationFrame(this.raf);
    this.canvas = null;
    this.ctx = null;
  }

  resize(): void {
    if (!this.canvas) return;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
    const L = (this.layout = this.computeLayout(W, H, dpr));
    const s = this.stage;
    if (s) {
      s.style.setProperty("--side-w", `${L.sideW}px`);
      s.style.setProperty("--header-h", `${L.headerH}px`);
      s.style.setProperty("--hero-h", `${L.heroH}px`);
      s.style.setProperty("--timeline-h", `${L.timelineH}px`);
      s.style.setProperty("--plot-l", `${L.plotL}px`);
      s.style.setProperty("--canvas-top", `${L.top}px`);
      s.style.setProperty("--canvas-bottom", `${L.bottom}px`);
    }
    this.dirty = true;
  }

  private computeLayout(W: number, H: number, dpr: number): Layout {
    const wide = W >= 1700;
    const sideW = wide ? 408 : W >= 1300 ? 360 : 320;
    const headerH = 56;
    const heroH = H >= 1000 ? 152 : 132;
    const timelineH = H >= 1000 ? 112 : 104;
    const mainW = W - sideW;
    const top = headerH + heroH;
    const bottom = H - timelineH;
    const ch = bottom - top;
    return {
      W,
      H,
      dpr,
      sideW,
      headerH,
      heroH,
      timelineH,
      mainW,
      plotL: wide ? 96 : 76,
      plotR: mainW - (wide ? 112 : 92),
      top,
      bottom,
      yG: Math.round(top + ch * 0.34),
      gap: Math.round(clamp(ch * 0.37, 150, 280)),
      rail: 4,
      trackY: bottom + 30,
    };
  }

  // ------------------------------------------------------------------ geometry

  xOf(k: number): number {
    const L = this.layout;
    return L.plotL + (k / this.model.kEnd) * (L.plotR - L.plotL);
  }

  kOfX(x: number): number {
    const L = this.layout;
    return ((x - L.plotL) / (L.plotR - L.plotL)) * this.model.kEnd;
  }

  /** 0 on the shared rail, 1 on the candidate lane: the S-curve of the tear. */
  shape(u: number): number {
    const d = this.model.d;
    if (d === null) return 0;
    return smootherstep((u - (d - 0.9)) / 0.8);
  }

  candidateY(u: number, sep = this.sep): number {
    const L = this.layout;
    const s = sep * this.shape(u);
    return L.yG + L.rail * (1 - Math.min(1, s)) + L.gap * s;
  }

  laneY(lane: Lane, k: number): number {
    const L = this.layout;
    if (lane === "candidate") return this.candidateY(k);
    if (lane === "fused") return L.yG + L.rail / 2;
    return L.yG;
  }

  /** How far the recorded golden line has been drawn in, in [0, 1]. */
  lineReveal(): number {
    if (this.reduced) return 1;
    const r = this.rewind;
    if (r && r.phase === "undraw") return 1 - easeInCubic((this.time - r.undrawT0) / UNDRAW);
    return easeInOutCubic((this.time - this.introT0) / 1.2);
  }

  gridReveal(): number {
    if (this.reduced) return 1;
    return clamp((this.time - this.gridT0) / 1.6);
  }

  /** 0..1 presence of a node: golden-side nodes arrive with the recording, candidate ones with the replay. */
  presence(node: ForkNode): number {
    if (node.lane === "candidate") {
      if (this.reduced) return this.p >= node.k - 0.02 ? 1 : 0;
      return clamp((this.p - node.k + 0.12) / 0.26);
    }
    const r = this.lineReveal() * this.model.kEnd;
    return clamp((r - node.k + 0.1) / 0.3);
  }

  // ------------------------------------------------------------------ controls

  setReduced(r: boolean): void {
    if (this.reduced === r) return;
    this.reduced = r;
    if (r) this.finalState();
    this.dirty = true;
  }

  /** Reduced motion: no clock-driven motion, everything at its resting end state. */
  private finalState(): void {
    if (this.rewind) {
      this.model = this.rewind.next;
      this.ui = { ...this.ui, modelIndex: this.rewind.index };
      this.rewind = null;
    }
    this.autoplayAt = null;
    this.mode = "idle";
    this.p = this.model.kEnd;
    this.pv = 0;
    this.diverged = this.model.d !== null;
    this.sep = this.sepTarget = this.diverged ? 1 : 0;
    this.sepV = 0;
    this.sepHist.fill(this.sep);
    this.shocks = [];
    this.beams = [];
    this.ui = { ...this.ui, step: -1 };
    this.syncUI();
    this.dirty = true;
  }

  loadRun(run: GateRun, index: number): void {
    const target = this.rewind ? this.rewind.index : this.ui.modelIndex;
    if (index === target) return;
    const next = buildModel(run);
    this.hover = null;
    if (this.reduced) {
      this.model = next;
      this.ui = { ...this.ui, modelIndex: index };
      this.finalState();
      this.notify();
      return;
    }
    this.autoplayAt = null;
    if (this.rewind) {
      this.rewind.next = next;
      this.rewind.index = index;
      return;
    }
    const from = clamp(this.p, 0, this.model.kEnd);
    this.rewind = { from, t0: this.time, dur: 0.22 + 0.045 * from, phase: "retract", undrawT0: 0, next, index };
    this.mode = "rewind";
    this.syncUI();
  }

  play(): void {
    if (this.mode === "rewind") return;
    this.autoplayAt = null;
    if (this.reduced) {
      this.p = this.p >= this.model.kEnd - 0.01 ? 0 : this.model.kEnd;
      this.afterJump();
      return;
    }
    if (this.p >= this.model.kEnd - 0.02) this.p = 0;
    this.mode = "play";
    this.syncUI();
  }

  pause(): void {
    if (this.mode !== "play") return;
    this.autoplayAt = null;
    this.settleTo(Math.round(this.p + 0.3), 170, 24);
  }

  togglePlay(): void {
    if (this.mode === "play") this.pause();
    else this.play();
  }

  stepBy(dir: number): void {
    if (this.mode === "rewind") return;
    const base = this.mode === "settle" ? this.settleTarget : this.p;
    const target = dir > 0 ? Math.floor(base + 0.5) + dir : Math.ceil(base - 0.5) + dir;
    this.seek(target, "key");
  }

  seek(k: number, how: "key" | "click" = "click"): void {
    if (this.mode === "rewind") return;
    this.autoplayAt = null;
    const target = clamp(k, 0, this.model.kEnd);
    if (this.reduced) {
      this.p = target;
      this.pv = 0;
      this.mode = "idle";
      this.afterJump();
      return;
    }
    // Keyboard steps repeat fast: near-critically damped and quick. Clicks can afford a little travel.
    if (how === "key") this.settleTo(target, 520, 45);
    else this.settleTo(target, 150, 20);
  }

  private settleTo(target: number, k: number, c: number): void {
    this.settleTarget = clamp(target, 0, this.model.kEnd);
    this.settleK = k;
    this.settleC = c;
    this.mode = "settle";
    this.syncUI();
  }

  private afterJump(): void {
    this.checkThreshold();
    this.syncUI();
    this.dirty = true;
  }

  beginDrag(clientX: number): void {
    if (this.mode === "rewind") return;
    this.autoplayAt = null;
    const onHandle = Math.abs(clientX - this.xOf(clamp(this.p, 0, this.model.kEnd))) < 16;
    this.grab = onHandle ? this.p - this.kOfX(clientX) : 0;
    this.mode = "drag";
    this.samples = [];
    this.drag(clientX);
  }

  drag(clientX: number): void {
    if (this.mode !== "drag") return;
    const raw = this.kOfX(clientX) + this.grab;
    const end = this.model.kEnd;
    let p = raw;
    if (raw < 0) p = this.reduced ? 0 : rubber(raw, 0.9);
    else if (raw > end) p = this.reduced ? end : end + rubber(raw - end, 0.9);
    this.p = p;
    const now = performance.now();
    this.samples.push({ t: now, p });
    while (this.samples.length > 2 && now - this.samples[0].t > 80) this.samples.shift();
    const first = this.samples[0];
    const dt = (now - first.t) / 1000;
    this.pv = dt > 0.004 ? (p - first.p) / dt : 0;
    if (this.reduced) this.checkThreshold();
    this.syncUI();
    this.dirty = true;
  }

  endDrag(): void {
    if (this.mode !== "drag") return;
    const last = this.samples[this.samples.length - 1];
    const fresh = last && performance.now() - last.t < 70;
    const v = fresh ? clamp(this.pv, -30, 30) : 0;
    if (this.reduced) {
      this.p = Math.round(clamp(this.p, 0, this.model.kEnd));
      this.pv = 0;
      this.mode = "idle";
      this.afterJump();
      return;
    }
    // Momentum: project where the flick would coast under friction, snap that to the nearest step.
    this.pv = v;
    this.settleTo(Math.round(this.p + v * 0.14), 190, 23);
  }

  wheel(delta: number): void {
    if (this.mode === "rewind") return;
    this.autoplayAt = null;
    this.mode = "drag";
    this.samples = [];
    this.p = clamp(this.p + delta * 0.004, -0.25, this.model.kEnd + 0.25);
    this.wheelIdle = 0.16;
    if (this.reduced) {
      this.p = clamp(this.p, 0, this.model.kEnd);
      this.checkThreshold();
    }
    this.syncUI();
    this.dirty = true;
  }

  setCursor(x: number, y: number): void {
    const c = this.cursor;
    if (c.onT === 0 && c.on < 0.01) {
      c.px = x;
      c.py = y;
    }
    c.tx = x;
    c.ty = y;
    c.tnx = (x / this.layout.W) * 2 - 1;
    c.tny = (y / this.layout.H) * 2 - 1;
    c.onT = 1;
    this.dirty = true;
  }

  clearCursor(): void {
    this.cursor.onT = 0;
    this.cursor.tnx = 0;
    this.cursor.tny = 0;
    this.dirty = true;
  }

  setHover(id: string | null): void {
    this.hover = id;
    this.dirty = true;
  }

  // ------------------------------------------------------------------ the divergence

  private checkThreshold(): void {
    const d = this.model.d;
    if (d === null) return;
    const T = d - 0.5;
    if (!this.diverged && this.p >= T) this.tear();
    else if (this.diverged && this.p < T) this.heal();
  }

  private tear(): void {
    this.diverged = true;
    this.sepTarget = 1;
    if (this.reduced) {
      this.sep = 1;
      this.sepV = 0;
      return;
    }
    const d = this.model.d!;
    const x = this.xOf(d - 0.5);
    const y = this.layout.yG + this.layout.gap * 0.18;
    this.tearT = this.time;
    this.sepV += 1.6;
    this.shocks.push({ t0: this.time, x, y, strength: 1, kind: "tear" });
    this.shocks.push({ t0: this.time + 0.12, x, y, strength: 0.55, kind: "tear" });
  }

  private heal(): void {
    this.diverged = false;
    this.sepTarget = 0;
    if (this.reduced) {
      this.sep = 0;
      this.sepV = 0;
      return;
    }
    if (this.mode === "rewind") return;
    const d = this.model.d!;
    this.shocks.push({ t0: this.time, x: this.xOf(d - 0.5), y: this.layout.yG + this.layout.gap * 0.12, strength: 0.5, kind: "heal" });
  }

  private arrive(): void {
    const L = this.layout;
    const x = this.xOf(this.model.kEnd);
    if (this.model.d === null) {
      this.shocks.push({ t0: this.time, x, y: L.yG + L.rail / 2, strength: 0.7, kind: "arrive" });
    } else {
      this.shocks.push({ t0: this.time, x, y: L.yG, strength: 0.35, kind: "arrive" });
      this.shocks.push({ t0: this.time + 0.06, x, y: this.candidateY(this.model.kEnd), strength: 0.35, kind: "arrive" });
    }
  }

  // ------------------------------------------------------------------ frame

  private tick(now: number): void {
    const realDt = Math.min((now - this.lastNow) / 1000, 1 / 20);
    this.lastNow = now;
    const c = this.cursor;
    if (this.reduced) {
      c.px = c.tx;
      c.py = c.ty;
      c.on = c.onT;
      if (this.dirty) this.draw();
      return;
    }
    const dt = realDt * this.timeScale;
    this.time += dt;

    this.stepPlayhead(dt);
    this.checkThreshold();
    this.stepEffects(dt);

    const k = damp(14, realDt);
    c.px += (c.tx - c.px) * k;
    c.py += (c.ty - c.py) * k;
    const kp = damp(3.5, realDt);
    c.nx += (c.tnx - c.nx) * kp;
    c.ny += (c.tny - c.ny) * kp;
    c.on += (c.onT - c.on) * damp(6, realDt);

    this.draw();
    this.syncUI();
  }

  private stepPlayhead(dt: number): void {
    if (this.autoplayAt !== null && this.time >= this.autoplayAt && this.mode === "idle") this.play();
    const end = this.model.kEnd;
    const prev = this.p;
    switch (this.mode) {
      case "play": {
        const d = this.model.d;
        let speed = 1.15;
        // Time dilates through the fork, then gives the beat back.
        if (d !== null) speed *= 0.16 + 0.84 * clamp(Math.abs(this.p - (d - 0.5)) / 0.8);
        this.p += speed * dt;
        if (this.p >= end) {
          this.p = end;
          this.mode = "idle";
          this.arrive();
        }
        break;
      }
      case "settle": {
        const [x, v] = springStep(this.p, this.pv, this.settleTarget, this.settleK, this.settleC, dt);
        this.p = x;
        this.pv = v;
        if (Math.abs(x - this.settleTarget) < 0.0015 && Math.abs(v) < 0.01) {
          this.p = this.settleTarget;
          this.pv = 0;
          this.mode = "idle";
        }
        break;
      }
      case "drag": {
        if (this.wheelIdle > 0) {
          this.wheelIdle -= dt;
          if (this.wheelIdle <= 0) this.settleTo(Math.round(this.p), 190, 23);
        }
        break;
      }
      case "rewind": {
        const r = this.rewind!;
        if (r.phase === "retract") {
          const t = (this.time - r.t0) / r.dur;
          this.p = r.from * (1 - easeInCubic(t));
          if (t >= 1) {
            this.p = 0;
            r.phase = "undraw";
            r.undrawT0 = this.time;
          }
        } else if (this.time - r.undrawT0 >= UNDRAW) {
          this.model = r.next;
          this.ui = { ...this.ui, modelIndex: r.index };
          this.rewind = null;
          this.p = 0;
          this.pv = 0;
          this.diverged = false;
          this.sep = this.sepTarget = this.sepV = 0;
          this.sepHist.fill(0);
          this.beams = [];
          this.bloom.clear();
          this.introT0 = this.time;
          this.mode = "idle";
          this.autoplayAt = this.time + 1.45;
          this.notify();
        }
        break;
      }
      default:
        break;
    }
    if (this.mode === "play" || this.mode === "rewind" || this.mode === "idle") this.pv = dt > 0 ? (this.p - prev) / dt : 0;
  }

  private stepEffects(dt: number): void {
    const tearing = this.sepTarget > 0.5;
    [this.sep, this.sepV] = springStep(this.sep, this.sepV, this.sepTarget, tearing ? 150 : 170, tearing ? 9 : 19, dt);
    this.histI = (this.histI + 1) % HIST;
    this.sepHist[this.histI] = this.sep;

    this.shocks = this.shocks.filter((s) => this.time - s.t0 < 1.6);

    // Beams: signal packets riding the replayed past, in the direction data flows.
    const head = clamp(this.p, 0, this.model.kEnd);
    if (this.mode !== "rewind") {
      for (const lane of ["g", "c"] as const) {
        this.beamClock[lane] -= dt;
        if (this.beamClock[lane] <= 0 && head > 0.8) {
          this.beamClock[lane] = 1.5 + Math.random() * 0.9;
          this.beams.push({ u: 0, lane, v: 2.3 + Math.random() * 0.5 });
        }
      }
    }
    for (const b of this.beams) b.u += b.v * dt;
    this.beams = this.beams.filter((b) => b.u - 0.9 < head);

    for (const node of this.model.nodes) {
      const target = this.hover === node.id ? 1 : 0;
      const cur = this.bloom.get(node.id) ?? 0;
      const next = cur + (target - cur) * damp(target ? 18 : 10, dt);
      if (!target && next < 0.002) this.bloom.delete(node.id);
      else this.bloom.set(node.id, next);
    }
  }

  // ------------------------------------------------------------------ output

  private draw(): void {
    if (!this.ctx) return;
    renderScene(this);
    this.writeAnchors();
    this.dirty = false;
  }

  private put(key: string, x: number, y: number, opacity?: number): void {
    const a = this.anchors.get(key);
    if (!a) return;
    const t = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    if (a.t !== t) {
      a.el.style.transform = t;
      a.t = t;
    }
    if (opacity !== undefined) {
      const o = clamp(opacity).toFixed(3);
      if (a.o !== o) {
        a.el.style.opacity = o;
        a.el.style.visibility = opacity < 0.01 ? "hidden" : "visible";
        a.o = o;
      }
    }
  }

  private width(key: string, w: number): void {
    const a = this.anchors.get(key);
    if (!a) return;
    const s = `${Math.max(0, w).toFixed(1)}px`;
    if (a.w !== s) {
      a.el.style.width = s;
      a.w = s;
    }
  }

  private writeAnchors(): void {
    const L = this.layout;
    const m = this.model;
    const reveal = this.lineReveal() * m.kEnd;

    for (const node of m.nodes) {
      const x = this.xOf(node.k);
      const y = this.laneY(node.lane, node.k);
      this.put(`node:${node.id}`, x, y, this.presence(node));
      if (this.hover === node.id) this.put("card", x, y);
    }
    for (let k = 0; k <= m.kEnd; k++) this.put(`tick:${k}`, this.xOf(k), 0, clamp((reveal - k + 0.2) / 0.3));

    const xp = this.xOf(clamp(this.p, -0.25, m.kEnd + 0.25));
    this.put("handle", xp, 0);
    this.put("phead", xp, L.top);
    this.put("track", L.plotL, 0);
    this.width("track", (L.plotR - L.plotL) * clamp(this.lineReveal()));
    this.put("fill", L.plotL, 0);
    this.width("fill", clamp(xp - L.plotL, 0, L.plotR - L.plotL));
    const txt = this.anchors.get("phead-text");
    if (txt) {
      const s = clamp(this.p, 0, m.kEnd).toFixed(2).padStart(5, "0");
      if (txt.t !== s) {
        txt.el.textContent = s;
        txt.t = s;
      }
    }

    const b = m.boundary;
    if (b !== null) {
      const xb = this.xOf(b + 0.5);
      const vis = clamp((reveal - b - 0.5) / 0.4);
      this.put("boundary", xb, Math.max(L.top + 12, L.yG - 132), vis);
      this.put("track-hatch", xb, 0, vis);
      this.width("track-hatch", L.plotR - xb + 12);
    }
    const d = m.d;
    if (d !== null) {
      const x = this.xOf(d - 0.5);
      const y = (L.yG + this.candidateY(d - 0.5)) / 2;
      this.put("tear", x, y, this.diverged ? clamp(this.sep * 1.6) : 0);
    }

    const c = this.cursor;
    this.put("parallax", -c.nx * 6, -c.ny * 4);
  }
}
