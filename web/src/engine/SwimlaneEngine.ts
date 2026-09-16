import type { GateRun, StepReport } from "../types/gate";
import type { ForkEvent } from "../api";
import { buildSwimlaneModel, type Lane, type LaneNode, type SwimlaneModel } from "./swimlane";
import { clamp, damp, springStep } from "./math";
import { renderSwimlaneScene } from "./swimlaneRender";
import { labelPolicyFor } from "./labelPolicy";
import {
  LANE_COLLAPSED_H,
  LANE_GAP,
  availableLaneHeight as pureAvailableLaneHeight,
  computeRowHeights as pureComputeRowHeights,
  naturalContentExtent as pureNaturalContentExtent,
} from "./rowHeight";

/**
 * The multi-lane timeline's clock, layout and canvas driver -- the swimlane-view sibling of Engine.ts,
 * not a subclass of it. Kept as a separate class rather than generalizing Engine.ts in place: Engine.ts's
 * physics (the tear/heal spring, the shockwave field, the two-lane geometry) are entangled with "exactly
 * one golden lane and one candidate lane" in a way that does not generalize to N agent lanes without
 * rewriting nearly all of it anyway -- doing that as a NEW file keeps the old engine, and the fixture demo
 * it drives at "/", completely unchanged (see docs/DECISIONS.md, Phase 1: "a layout and navigation
 * upgrade, not a redesign" -- for the real-run view specifically; the four-tape demo was never the thing
 * with the layout bug).
 *
 * What IS reused: math.ts's spring/easing primitives (unchanged), the same "playhead as a single float
 * position `p`, sprung toward integer targets" interaction model, and the same monochrome/hairline visual
 * vocabulary (palette.ts, unchanged).
 */

export interface Layout {
  W: number;
  H: number;
  dpr: number;
  rulerH: number;
  leftGutter: number;
  plotL: number;
  plotR: number;
  contentH: number; // total height of all visible lane rows, stacked
}

export interface LaneRect {
  lane: Lane;
  y: number; // vertical center of this lane's track
  top: number;
  height: number; // current (possibly mid-collapse) row height
  /** This lane's OWN nodes/track should draw -- false once this lane is more than half collapsed, or an
   *  ancestor lane is collapsed (in which case this lane has zero height too, see laneRects). */
  visible: boolean;
  /** The lane HEADER (name/toggle/badge) should draw -- true whenever no ANCESTOR is collapsed, regardless
   *  of this lane's own collapse state: a self-collapsed lane keeps its own header visible (with a call
   *  count badge) so it can be expanded again; only a collapsed ANCESTOR hides a lane entirely. */
  headerVisible: boolean;
}

export interface Viewport {
  k0: number;
  k1: number;
}

export type ForkStatus = "idle" | "validating" | "running" | "complete" | "failed";

export interface ForkUIState {
  status: ForkStatus;
  mutation: { tool: string; field: string; value: unknown } | null;
  originNodeId: string | null;
  stepsReceived: number;
  answer: string | null;
  verdict: "PASS" | "FAIL" | null;
  error: { message: string; transient: boolean } | null;
}

export interface SwimlaneUIState {
  step: number;
  playing: boolean;
  dragging: boolean;
  diverged: boolean;
  panning: boolean;
  /** Phase 2.2 (docs/DECISIONS.md): null until the FIRST fork this session (RunInspector's "Fork from
   *  here"); re-set to a fresh idle-shaped object each time a NEW fork starts, so a second fork from a
   *  different step doesn't inherit the previous one's stale answer/steps. */
  fork: ForkUIState | null;
}

type Mode = "idle" | "play" | "settle" | "scrub" | "pan";

const MIN_ZOOM_STEPS = 6; // fewest steps a full zoom-in should ever show, so zoom has a floor

export const ZOOM_LEVELS = [1, 2, 4, 8, 16] as const;

interface Anchor {
  el: HTMLElement;
  t: string;
  o: string;
}

export class SwimlaneEngine {
  model: SwimlaneModel;
  reduced = false;
  time = 0;

  p = 0;
  pv = 0;
  mode: Mode = "idle";
  private settleTarget = 0;

  viewport: Viewport = { k0: 0, k1: 1 };
  private viewportTarget: Viewport = { k0: 0, k1: 1 };
  zoomIndex = 0;
  fitToWidth = true;

  private collapseProgress = new Map<string, number>(); // laneId -> 0 (open) .. 1 (collapsed)
  private collapseTarget = new Map<string, number>();

  diverged = false;
  private tearShocks: { t0: number; x: number }[] = [];

  layout: Layout = { W: 1, H: 1, dpr: 1, rulerH: 28, leftGutter: 176, plotL: 200, plotR: 1, contentH: 1 };
  ctx: CanvasRenderingContext2D | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private container: HTMLElement | null = null;
  private anchors = new Map<string, Anchor>();
  private refs = new Map<string, (el: HTMLElement | null) => void>();
  private raf = 0;
  private lastNow = 0;
  private dirty = true;

  hover: string | null = null;
  private grabX = 0;
  private grabK0 = 0;
  private grabY = 0;
  private grabScrollY = 0;
  /** Vertical scroll through the lane stack, in px -- only nonzero once there are too many lanes to
   *  stretch-fit (see computeRowHeights); clamped to [0, maxScrollY()] every time it's set. */
  laneScrollY = 0;

  private ui: SwimlaneUIState;
  private listeners = new Set<() => void>();

  constructor(run: GateRun, collapsedByDefault?: Set<string>) {
    this.model = buildSwimlaneModel(run, collapsedByDefault);
    for (const lane of this.model.lanes) this.collapseProgress.set(lane.id, lane.collapsed ? 1 : 0);
    this.viewport = { k0: 0, k1: this.model.kEnd };
    this.viewportTarget = { ...this.viewport };
    this.ui = { step: 0, playing: false, dragging: false, diverged: false, panning: false, fork: null };
  }

  // ------------------------------------------------------------------ React bridge

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getUI = (): SwimlaneUIState => this.ui;

  private notify(): void {
    this.listeners.forEach((l) => l());
  }

  private syncUI(): void {
    const u = this.ui;
    const step = Math.round(clamp(this.p, 0, this.model.kEnd));
    const playing = this.mode === "play";
    const dragging = this.mode === "scrub";
    const panning = this.mode === "pan";
    if (u.step !== step || u.diverged !== this.diverged || u.playing !== playing || u.dragging !== dragging || u.panning !== panning) {
      this.ui = { step, diverged: this.diverged, playing, dragging, panning, fork: u.fork };
      this.notify();
    }
  }

  ref(key: string): (el: HTMLElement | null) => void {
    let f = this.refs.get(key);
    if (!f) {
      f = (el) => {
        if (el) this.anchors.set(key, { el, t: "", o: "" });
        else this.anchors.delete(key);
        this.dirty = true;
      };
      this.refs.set(key, f);
    }
    return f;
  }

  // ------------------------------------------------------------------ lifecycle

  attach(canvas: HTMLCanvasElement, container: HTMLElement): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.container = container;
    this.resize();
    if (this.reduced) this.p = 0;
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
    if (!this.canvas || !this.container) return;
    const rect = this.container.getBoundingClientRect();
    const W = Math.max(1, Math.round(rect.width));
    const H = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
    // Widened (VISUAL 3, docs/DECISIONS.md): a specialist name like "sub_verifier_agent" was ellipsizing
    // in the old 176px gutter while whole lanes of empty space sat unused beside it. Still capped, not
    // unbounded -- see SwimlaneStage's LaneHead, which wraps onto a second line for anything longer still.
    const leftGutter = W < 640 ? 140 : W < 1300 ? 200 : 240;
    this.layout = {
      W,
      H,
      dpr,
      rulerH: 28,
      leftGutter,
      plotL: leftGutter + 16,
      plotR: Math.max(leftGutter + 32, W - 20),
      contentH: this.computeContentHeight(),
    };
    this.laneScrollY = clamp(this.laneScrollY, 0, this.maxScrollY());
    this.dirty = true;
  }

  // ------------------------------------------------------------------ geometry

  xOf(k: number): number {
    const L = this.layout;
    const { k0, k1 } = this.viewport;
    const span = Math.max(1e-6, k1 - k0);
    return L.plotL + ((k - k0) / span) * (L.plotR - L.plotL);
  }

  kOfX(x: number): number {
    const L = this.layout;
    const { k0, k1 } = this.viewport;
    return k0 + ((x - L.plotL) / (L.plotR - L.plotL)) * (k1 - k0);
  }

/** Vertical space actually available for the lane stack, below the ruler and above the bottom padding --
   *  delegates to engine/rowHeight.ts (shared with scripts/verify-layout.ts, see that module's docstring
   *  for why: one real implementation, not a hand-duplicated formula that could drift from what renders). */
  private availableLaneHeight(): number {
    return pureAvailableLaneHeight(this.layout.H, this.layout.rulerH);
  }

  private computeRowHeights(progs: number[]): number[] {
    return pureComputeRowHeights(progs, this.layout.H, this.layout.rulerH);
  }

  /** The lane stack's own natural height (before any scroll offset) -- used to bound laneScrollY. */
  private naturalContentExtent(): number {
    const visible = this.model.lanes.filter((l) => this.isLaneVisible(l.id));
    return pureNaturalContentExtent(visible.map((l) => this.collapseProgress.get(l.id) ?? 0), this.layout.H, this.layout.rulerH);
  }

  maxScrollY(): number {
    return Math.max(0, this.naturalContentExtent() - this.availableLaneHeight());
  }

  private computeContentHeight(): number {
    return this.naturalContentExtent();
  }

  /** Every lane's current vertical rect, mid-collapse-animation and mid-scroll included. A lane folded
   *  away by a collapsed ANCESTOR takes zero space and no row at all -- its whole subtree disappears, not
   *  just its nodes; a lane collapsed on its OWN account still gets a slim row (LANE_COLLAPSED_H) so its
   *  header and requires/permits summary stay reachable to expand it again. */
  laneRects(): LaneRect[] {
    const meta = this.model.lanes.map((lane) => ({ lane, laneVisible: this.isLaneVisible(lane.id), prog: this.collapseProgress.get(lane.id) ?? 0 }));
    const heights = this.computeRowHeights(meta.filter((m) => m.laneVisible).map((m) => m.prog));
    const out: LaneRect[] = [];
    let y = this.layout.rulerH + 10 - this.laneScrollY;
    let hi = 0;
    for (const m of meta) {
      if (!m.laneVisible) {
        out.push({ lane: m.lane, top: y, y, height: 0, visible: false, headerVisible: false });
        continue;
      }
      const height = heights[hi++];
      out.push({ lane: m.lane, top: y, y: y + height / 2, height, visible: m.prog < 0.5, headerVisible: true });
      y += height + LANE_GAP;
    }
    return out;
  }

  laneY(laneId: string): number {
    const r = this.laneRects().find((r) => r.lane.id === laneId);
    return r ? r.y : this.layout.rulerH + 10 + LANE_COLLAPSED_H;
  }

  nodeXY(node: LaneNode): [number, number] {
    return [this.xOf(node.k), this.laneY(node.laneId)];
  }

  // ------------------------------------------------------------------ zoom / pan

  private clampViewport(v: Viewport): Viewport {
    const kEnd = this.model.kEnd;
    let { k0, k1 } = v;
    const span = Math.max(MIN_ZOOM_STEPS / Math.max(1, ZOOM_LEVELS[ZOOM_LEVELS.length - 1]), k1 - k0);
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

  fitAll(): void {
    this.fitToWidth = true;
    this.zoomIndex = 0;
    this.viewportTarget = { k0: 0, k1: this.model.kEnd };
    this.dirty = true;
  }

  /** Discrete zoom, centered on `atK` (defaults to the playhead). */
  setZoom(index: number, atK?: number): void {
    this.fitToWidth = index === 0;
    this.zoomIndex = clamp(index, 0, ZOOM_LEVELS.length - 1);
    const factor = ZOOM_LEVELS[this.zoomIndex];
    const full = this.model.kEnd;
    const span = Math.max(MIN_ZOOM_STEPS, full / factor);
    const center = atK ?? clamp(this.p, 0, full);
    this.viewportTarget = this.clampViewport({ k0: center - span / 2, k1: center + span / 2 });
    this.dirty = true;
  }

  zoomBy(dir: 1 | -1, atK?: number): void {
    this.setZoom(this.zoomIndex + dir, atK);
  }

  /** Wheel over the lanes area: plain wheel zooms around the cursor, shift+wheel pans. */
  wheelZoom(deltaY: number, atX: number): void {
    this.fitToWidth = false;
    const atK = this.kOfX(atX);
    const cur = this.viewportTarget;
    const span = cur.k1 - cur.k0;
    const factor = Math.pow(1.0018, deltaY);
    const newSpan = clamp(span * factor, MIN_ZOOM_STEPS, this.model.kEnd);
    const t = span > 0 ? (atK - cur.k0) / span : 0.5;
    const next = { k0: atK - newSpan * t, k1: atK + newSpan * (1 - t) };
    this.viewportTarget = this.clampViewport(next);
    this.zoomIndex = ZOOM_LEVELS.reduce((best, z, i) => (Math.abs(this.model.kEnd / z - newSpan) < Math.abs(this.model.kEnd / ZOOM_LEVELS[best] - newSpan) ? i : best), 0);
    this.dirty = true;
  }

  wheelPan(deltaX: number): void {
    const span = this.viewportTarget.k1 - this.viewportTarget.k0;
    const shift = (deltaX / (this.layout.plotR - this.layout.plotL)) * span;
    this.viewportTarget = this.clampViewport({ k0: this.viewportTarget.k0 + shift, k1: this.viewportTarget.k1 + shift });
    this.fitToWidth = false;
    this.dirty = true;
  }

  /** Set the viewport directly (the minimap dragging its window) -- not sprung, since the minimap already
   *  IS the direct-manipulation surface; springing here would fight the user's own drag. */
  setViewportImmediate(v: Viewport): void {
    const c = this.clampViewport(v);
    this.viewport = c;
    this.viewportTarget = c;
    this.fitToWidth = c.k0 <= 0.01 && c.k1 >= this.model.kEnd - 0.01;
    this.dirty = true;
  }

  beginPan(clientX: number, clientY = 0): void {
    this.mode = "pan";
    this.grabX = clientX;
    this.grabK0 = this.viewport.k0;
    this.grabY = clientY;
    this.grabScrollY = this.laneScrollY;
    this.syncUI();
  }

  /** Dragging the lane background pans BOTH axes at once: horizontal moves the time viewport (as before),
   *  vertical scrolls the lane stack when there are more lanes than fit (VISUAL 1, docs/DECISIONS.md) --
   *  the same gesture already documented in the transport hints, extended rather than adding a new one. */
  pan(clientX: number, clientY = 0): void {
    if (this.mode !== "pan") return;
    const span = this.viewport.k1 - this.viewport.k0;
    const dx = clientX - this.grabX;
    const dk = -(dx / (this.layout.plotR - this.layout.plotL)) * span;
    this.viewportTarget = this.clampViewport({ k0: this.grabK0 + dk, k1: this.grabK0 + dk + span });
    this.viewport = this.viewportTarget;
    this.fitToWidth = false;
    const dy = clientY - this.grabY;
    this.laneScrollY = clamp(this.grabScrollY - dy, 0, this.maxScrollY());
    this.dirty = true;
  }

  endPan(): void {
    if (this.mode !== "pan") return;
    this.mode = "idle";
    this.syncUI();
  }

  private ensurePlayheadVisible(): void {
    const margin = (this.viewportTarget.k1 - this.viewportTarget.k0) * 0.08;
    const { k0, k1 } = this.viewportTarget;
    if (this.p < k0 + margin) {
      const span = k1 - k0;
      const nk0 = clamp(this.p - margin, 0, this.model.kEnd - span);
      this.viewportTarget = this.clampViewport({ k0: nk0, k1: nk0 + span });
    } else if (this.p > k1 - margin) {
      const span = k1 - k0;
      const nk1 = clamp(this.p + margin, span, this.model.kEnd);
      this.viewportTarget = this.clampViewport({ k0: nk1 - span, k1: nk1 });
    }
  }

  // ------------------------------------------------------------------ lane collapse

  toggleLane(laneId: string): void {
    const lane = this.model.laneById.get(laneId);
    if (!lane) return;
    lane.collapsed = !lane.collapsed;
    this.collapseTarget.set(laneId, lane.collapsed ? 1 : 0);
    this.dirty = true;
    // React never sees `lane.collapsed` mutate on its own (SwimlaneStage reads it straight off the plain
    // Lane object at render time, not through subscribe/getUI) -- a new `ui` object reference, even with
    // identical field values, is what makes useSyncExternalStore treat this as a change worth re-rendering
    // for (aria-expanded, the chevron rotation, the collapsed-count badge all live in that re-render).
    this.ui = { ...this.ui };
    this.notify();
  }

  isLaneVisible(laneId: string): boolean {
    // A lane is visible unless the whole nested subtree it belongs to has been folded from above.
    let cur = this.model.laneById.get(laneId);
    while (cur?.parentLaneId) {
      const parent = this.model.laneById.get(cur.parentLaneId);
      if (parent?.collapsed) return false;
      cur = parent;
    }
    return true;
  }

  // ------------------------------------------------------------------ fork (Phase 2.2, docs/DECISIONS.md)

  private forkOriginK = 0;
  // agent name -> the fork lane id ("fork:<agent>") created for it, lazily -- a fork lane only exists once
  // its FIRST step actually arrives, not speculatively at beginFork() time.
  private forkLaneByAgent = new Map<string, string>();

  private recomputeDensityRanks(): void {
    // Same rule buildSwimlaneModel used originally (sparsest lane = rank 0), just re-run over the CURRENT
    // lane set (now possibly including fork lanes) -- render-only, see Lane.densityRank's own docstring.
    [...this.model.lanes].sort((a, b) => a.nodes.length - b.nodes.length).forEach((lane, i) => (lane.densityRank = i));
  }

  /** Called once, when "Fork from here" actually starts a run (RunInspector) -- `originNodeId` is the
   *  step being forked from (its own recorded tool call), `mutation` is the single field being changed
   *  (2.2.1: only one in v1). Reserves timeline space for the fork's own steps (a fresh gate replay's step
   *  numbers start at 1 again, offset from the origin's own k) and points the viewport at it, since fork
   *  steps would otherwise render past the original run's own kEnd, off the right edge of the CURRENT
   *  viewport. Resets any PRIOR fork's lanes/nodes first -- only one fork is shown at a time. */
  beginFork(originNodeId: string, mutation: { tool: string; field: string; value: unknown }): void {
    this.clearForkLanes();
    const origin = this.model.nodeById.get(originNodeId);
    this.forkOriginK = origin ? origin.k : this.model.kEnd;
    // Reserved, not grown per-step: this project's own scenarios top out at a handful of fork steps
    // (the hero case is 3), so a fixed buffer avoids per-event viewport/zoom-math churn for no real
    // benefit; addForkStep still grows it further below if a step ever needs more room than this.
    const FORK_RESERVED_STEPS = 16;
    this.model.kEnd = Math.max(this.model.kEnd, this.forkOriginK + FORK_RESERVED_STEPS);
    this.fitToWidth = false;
    const span = Math.max(MIN_ZOOM_STEPS, Math.min(this.model.kEnd, FORK_RESERVED_STEPS + 4));
    this.viewportTarget = this.clampViewport({ k0: this.forkOriginK - span * 0.25, k1: this.forkOriginK - span * 0.25 + span });
    // Reuses the SAME divergence-tear ripple the timeline already draws for a real divergence (palette.ts/
    // swimlaneRender.ts's drawTearShocks) -- "something changed here" is exactly what a fork's origin
    // means too, so this is the "extend the vocabulary" choice over inventing a second ripple effect.
    if (!this.reduced) this.tearShocks.push({ t0: this.time, x: this.xOf(this.forkOriginK) });
    this.ui = {
      ...this.ui,
      fork: { status: "running", mutation, originNodeId, stepsReceived: 0, answer: null, verdict: null, error: null },
    };
    this.notify();
    this.dirty = true;
  }

  /** Wipes any previous fork's lanes/nodes out of the model entirely (not just visually hidden) -- called
   *  at the start of a new fork (beginFork) and by RunView on "Save as scenario" -> dismiss, so a stale
   *  fork never lingers once superseded. */
  clearForkLanes(): void {
    for (const laneId of this.forkLaneByAgent.values()) {
      const lane = this.model.laneById.get(laneId);
      if (lane) for (const node of lane.nodes) this.model.nodeById.delete(node.id);
      this.model.laneById.delete(laneId);
    }
    this.model.lanes = this.model.lanes.filter((l) => !l.isFork);
    this.forkLaneByAgent.clear();
    this.recomputeDensityRanks();
  }

  /** One "step" event from the fork event protocol (docs/DECISIONS.md's Phase 2.1.2) -- field names match
   *  ContractStep verbatim (agent_replay/fork.py), so this is a direct, no-translation mapping onto the
   *  SAME StepReport/LaneNode shape every real run already uses -- callOf/isToolCall/fullArgSummary in
   *  SwimlaneStage.tsx need no fork-specific branch at all as a result. */
  addForkStep(e: Extract<ForkEvent, { type: "step" }>): void {
    const agent = e.agent ?? "fork";
    let laneId = this.forkLaneByAgent.get(agent);
    if (!laneId) {
      const origin = this.model.nodeById.get(this.ui.fork?.originNodeId ?? "");
      laneId = `fork:${agent}`;
      const lane: Lane = {
        id: laneId,
        depth: (origin ? this.model.laneById.get(origin.laneId)?.depth ?? 0 : 0) + 1,
        // Tethered to the ORIGIN call, in the origin's OWN lane -- drawTethers (swimlaneRender.ts) already
        // draws exactly this connector for any lane with spawnedByNodeId + a resolvable parentLaneId (it
        // was written generically for pass-through specialist lanes; a fork lane needs no new drawing code
        // at all, only these two fields set correctly).
        parentLaneId: origin?.laneId ?? null,
        spawnedByNodeId: this.ui.fork?.originNodeId ?? null,
        nodes: [], collapsed: false, requiredCount: 0, permittedCount: 0, densityRank: 0, isFork: true,
      };
      this.model.laneById.set(laneId, lane);
      this.model.lanes.push(lane);
      this.forkLaneByAgent.set(agent, laneId);
      this.collapseProgress.set(laneId, 0);
    }
    const lane = this.model.laneById.get(laneId)!;
    const k = this.forkOriginK + e.step;
    this.model.kEnd = Math.max(this.model.kEnd, Math.ceil(k) + 2);

    const step: StepReport = {
      step: e.step, golden: null, candidate: e.tool ? { tool: e.tool, args: e.args ?? {} } : null,
      gate_status: "recorded", cause: e.cause as StepReport["cause"], attribution: e.attribution as StepReport["attribution"],
      mutated: e.mutated, agent: e.agent, membership: e.membership as StepReport["membership"],
    };
    const node: LaneNode = { id: `fork:${agent}:${e.step}`, k, step, laneId, flagged: e.cause !== null, ghost: false, membership: step.membership };
    lane.nodes.push(node);
    this.model.nodeById.set(node.id, node);
    if (step.membership === "requires") lane.requiredCount += 1;
    else if (step.membership === "permits") lane.permittedCount += 1;
    this.recomputeDensityRanks();

    if (this.ui.fork) this.ui = { ...this.ui, fork: { ...this.ui.fork, stepsReceived: this.ui.fork.stepsReceived + 1 } };
    this.notify();
    this.dirty = true;
  }

  setForkAnswer(text: string): void {
    if (!this.ui.fork) return;
    this.ui = { ...this.ui, fork: { ...this.ui.fork, answer: text } };
    this.notify();
  }

  finishFork(verdict: "PASS" | "FAIL"): void {
    if (!this.ui.fork) return;
    this.ui = { ...this.ui, fork: { ...this.ui.fork, status: "complete", verdict } };
    this.notify();
  }

  failFork(message: string, transient: boolean): void {
    if (!this.ui.fork) return;
    this.ui = { ...this.ui, fork: { ...this.ui.fork, status: "failed", error: { message, transient } } };
    this.notify();
  }

  /** Set the instant "Run fork" is clicked, before startFork()'s own network round trip resolves -- lets
   *  the UI show "validating" immediately rather than a blank/idle state while POST /forks is in flight. */
  setForkValidating(originNodeId: string, mutation: { tool: string; field: string; value: unknown }): void {
    this.ui = { ...this.ui, fork: { status: "validating", mutation, originNodeId, stepsReceived: 0, answer: null, verdict: null, error: null } };
    this.notify();
  }

  /** Dismisses the current fork entirely -- its lanes/nodes AND its ui.fork record -- back to as if none
   *  had ever run. Called when the fork panel is closed/superseded (e.g. "Save as scenario" -> Done, or
   *  picking a different step to fork from instead). */
  resetFork(): void {
    this.clearForkLanes();
    this.ui = { ...this.ui, fork: null };
    this.notify();
    this.dirty = true;
  }

  // ------------------------------------------------------------------ playhead controls

  play(): void {
    if (this.p >= this.model.kEnd - 0.02) this.p = 0;
    this.mode = "play";
    this.syncUI();
  }

  pause(): void {
    if (this.mode !== "play") return;
    this.settleTo(Math.round(this.p + 0.3));
  }

  togglePlay(): void {
    if (this.mode === "play") this.pause();
    else this.play();
  }

  stepBy(dir: number): void {
    const base = this.mode === "settle" ? this.settleTarget : this.p;
    const target = dir > 0 ? Math.floor(base + 0.5) + dir : Math.ceil(base - 0.5) + dir;
    this.seek(target);
  }

  seek(k: number): void {
    const target = clamp(k, 0, this.model.kEnd);
    if (this.reduced) {
      this.p = target;
      this.pv = 0;
      this.mode = "idle";
      this.checkDivergence();
      this.ensurePlayheadVisible();
      this.syncUI();
      this.dirty = true;
      return;
    }
    this.settleTo(target);
  }

  private settleTo(target: number): void {
    this.settleTarget = clamp(target, 0, this.model.kEnd);
    this.mode = "settle";
    this.syncUI();
  }

  beginScrub(clientX: number): void {
    this.mode = "scrub";
    this.scrub(clientX);
  }

  scrub(clientX: number): void {
    if (this.mode !== "scrub") return;
    this.p = clamp(this.kOfX(clientX), 0, this.model.kEnd);
    this.checkDivergence();
    this.ensurePlayheadVisible();
    this.syncUI();
    this.dirty = true;
  }

  endScrub(): void {
    if (this.mode !== "scrub") return;
    this.mode = "idle";
    this.p = Math.round(this.p);
    this.syncUI();
  }

  setHover(id: string | null): void {
    this.hover = id;
    this.dirty = true;
  }

  // ------------------------------------------------------------------ divergence

  private checkDivergence(): void {
    const d = this.model.divergenceK;
    const now = d !== null && this.p >= d - 0.5;
    if (now && !this.diverged) {
      this.diverged = true;
      this.tearShocks.push({ t0: this.time, x: this.xOf(d! - 0.5) });
    } else if (!now && this.diverged) {
      this.diverged = false;
    }
  }

  // ------------------------------------------------------------------ frame

  private tick(now: number): void {
    const realDt = Math.min((now - this.lastNow) / 1000, 1 / 20);
    this.lastNow = now;
    if (this.reduced) {
      if (this.dirty) this.paint();
      return;
    }
    const dt = realDt;
    this.time += dt;

    switch (this.mode) {
      case "play": {
        this.p += 1.1 * dt;
        if (this.p >= this.model.kEnd) {
          this.p = this.model.kEnd;
          this.mode = "idle";
        }
        this.checkDivergence();
        this.ensurePlayheadVisible();
        break;
      }
      case "settle": {
        const [x, v] = springStep(this.p, this.pv, this.settleTarget, 210, 24, dt);
        this.p = x;
        this.pv = v;
        this.checkDivergence();
        this.ensurePlayheadVisible();
        if (Math.abs(x - this.settleTarget) < 0.0015 && Math.abs(v) < 0.01) {
          this.p = this.settleTarget;
          this.pv = 0;
          this.mode = "idle";
        }
        break;
      }
      default:
        break;
    }

    // Viewport spring: fit-to-width and zoom/follow transitions ease in rather than jump.
    const k = damp(10, dt);
    let vpMoved = false;
    if (Math.abs(this.viewport.k0 - this.viewportTarget.k0) > 1e-4 || Math.abs(this.viewport.k1 - this.viewportTarget.k1) > 1e-4) {
      this.viewport = {
        k0: this.viewport.k0 + (this.viewportTarget.k0 - this.viewport.k0) * k,
        k1: this.viewport.k1 + (this.viewportTarget.k1 - this.viewport.k1) * k,
      };
      vpMoved = true;
    }

    // Lane collapse springs.
    let collapseMoved = false;
    for (const [id, target] of this.collapseTarget) {
      const cur = this.collapseProgress.get(id) ?? 0;
      if (Math.abs(cur - target) > 1e-3) {
        const next = cur + (target - cur) * damp(12, dt);
        this.collapseProgress.set(id, next);
        collapseMoved = true;
      } else {
        this.collapseProgress.set(id, target);
      }
    }
    if (collapseMoved) this.layout.contentH = this.computeContentHeight();

    this.tearShocks = this.tearShocks.filter((s) => this.time - s.t0 < 1.3);

    if (vpMoved || collapseMoved || this.mode !== "idle" || this.tearShocks.length) this.dirty = true;
    this.paint();
    this.syncUI();
  }

  shocks(): { t0: number; x: number }[] {
    return this.tearShocks;
  }

  private paint(): void {
    if (!this.ctx) return;
    renderSwimlaneScene(this);
    this.writeAnchors();
    this.dirty = false;
  }

  markDirty(): void {
    this.dirty = true;
  }

  isDirty(): boolean {
    return this.dirty;
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
        a.el.style.visibility = opacity < 0.02 ? "hidden" : "visible";
        a.o = o;
      }
    }
  }

  /** Pixels available per integer step at the CURRENT viewport -- drives label level-of-detail. Exposed
   *  (not just used internally) so SwimlaneStage can read the same number for its own React-side decisions
   *  without duplicating the zoom math; the per-node label MODE itself is still written imperatively below,
   *  since it must update every frame during a zoom/pan animation, not just on the coarse UI-state changes
   *  React re-renders for (a zoom button click alone doesn't change `step`/`playing`/etc). */
  pxPerStep(): number {
    const span = Math.max(1e-6, this.viewport.k1 - this.viewport.k0);
    return (this.layout.plotR - this.layout.plotL) / span;
  }

  private setAttr(key: string, name: string, value: string): void {
    const a = this.anchors.get(key);
    if (!a) return;
    if (a.el.getAttribute(name) !== value) a.el.setAttribute(name, value);
  }

  /** BUG 2 fix (docs/DECISIONS.md): at fit/low zoom, 40 labels genuinely do not fit at any arrangement --
   *  smarter staggering cannot fix that, only showing fewer labels can. Policy: three nodes always get a
   *  label regardless of zoom (the playhead's current node, the divergence node, the hovered node); every
   *  other node's label is gated on BOTH the current zoom density AND its own lane's density rank (fewer
   *  total nodes in the lane = lower threshold = reveals earlier as you zoom in; "densest lanes last").
   *  The requires/permits pill on a label is gated separately and more strictly (VISUAL 2): only the
   *  hovered/current node, or the highest zoom tier, shows it per-node at all -- everywhere else the
   *  lane header's own "N required · M permitted" summary line is the signal, not a badge on every node.
   *  Thresholds are picked so fit zoom (measured: ~19-32 px/step on this fixture at 1366-1920px width) is
   *  comfortably below even the SPARSEST lane's reveal point -- see the report's verification steps for
   *  how to confirm this with real measurements instead of trusting the numbers below. */
  private writeAnchors(): void {
    const rects = this.laneRects();
    const density = this.pxPerStep();
    const currentStep = Math.round(clamp(this.p, 0, this.model.kEnd));
    const divergenceK = this.model.divergenceK;
    const numLanes = Math.max(1, this.model.lanes.length);
    for (const r of rects) {
      this.put(`lanehead:${r.lane.id}`, 0, r.top, r.headerVisible ? 1 : 0);
      for (const node of r.lane.nodes) {
        const inView = node.k >= this.viewport.k0 - 1 && node.k <= this.viewport.k1 + 1;
        this.put(`node:${node.id}`, this.xOf(node.k), r.y, r.visible && inView ? 1 : 0);
        const isCurrent = node.k === currentStep;
        const isHover = node.id === this.hover;
        const isException = isCurrent || isHover || node.k === divergenceK;
        const policy = labelPolicyFor({ density, laneDensityRank: r.lane.densityRank, numLanes, isException });
        this.setAttr(`node:${node.id}`, "data-labelmode", policy.labelMode);
        this.setAttr(`node:${node.id}`, "data-current", String(isCurrent));
        this.setAttr(`node:${node.id}`, "data-badge", String(policy.badge));
      }
    }
    const xp = this.xOf(clamp(this.p, 0, this.model.kEnd));
    this.put("playhead", xp, 0);

    if (this.hover) {
      const node = this.model.nodeById.get(this.hover);
      if (node) {
        const [x, y] = this.nodeXY(node);
        this.put("card", x, y);
      }
    }
  }
}
