import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useReducedMotion } from "motion/react";
import { SwimlaneEngine } from "../engine/SwimlaneEngine";
import { buildModel } from "../engine/model";
import type { UIState } from "../engine/Engine";
import type { GateRun } from "../types/gate";
import type { CommitRunSummary } from "../api";
import { RunHeader } from "./RunHeader";
import { Hero } from "./Hero";
import { SwimlaneStage } from "./SwimlaneStage";
import { SwimlaneNodeCard } from "./SwimlaneNodeCard";
import { SwimlaneTimeline } from "./SwimlaneTimeline";
import { RunInspector } from "./RunInspector";
import { DiffPanel } from "./DiffPanel";
import { ForkPanel, type PendingFork } from "./ForkPanel";

interface Props {
  gateRun: GateRun;
  runId: string;
  scenario: string;
  summary?: CommitRunSummary;
  backTo?: { sha: string; label: string };
  navigate: (path: string) => void;
  /** True when rendered inside CommitPage's triage layout, not standalone (RunPage/the fixture demo).
   * `.stage`'s own `position: fixed` covers the full viewport regardless of its parent's layout -- fine
   * standalone, but it would paint straight over the triage rail if left on here. See .stage-embedded. */
  embedded?: boolean;
}

// Fixed chrome heights for the new swimlane view (Phase 1, docs/DECISIONS.md) -- unlike the old two-lane
// engine, nothing here needs to be JS-computed from window size; they're written once as CSS vars so
// Hero/RunHeader/DiffPanel (all unchanged, all already read var(--header-h) etc.) keep working untouched.
const HEADER_H = 56;
const HERO_H = 150;
const TIMELINE_H = 150;
// The Inspector's own reserved width when open and NOT in narrow-drawer mode -- same responsive steps the
// old Engine.computeLayout used, just no longer computed inside a canvas engine.
function inspectorWidth(w: number): number {
  return w >= 1700 ? 408 : w >= 1300 ? 360 : 320;
}
const NARROW_BREAKPOINT = 980;

/**
 * Hosts one SwimlaneEngine for one real run. Structurally the same idea as before Phase 1 (Hero/
 * RunHeader/RunInspector/DiffPanel are the exact same components, unchanged -- "a layout and navigation
 * upgrade, not a redesign") but the canvas/overlay/timeline in the middle are now the swimlane engine
 * (engine/SwimlaneEngine.ts) instead of the old single-fork Engine: one lane per agent, collapsible,
 * zoomable, with a minimap, instead of a fixed-width two-lane fork that a 40-step run would overflow.
 *
 * Every caller now mounts this with `key={runId}` (see RunPage.tsx/CommitPage.tsx) so a run switch is a
 * clean remount rather than an in-place model swap -- the old engine's rewind-retract-undraw transition
 * doesn't carry over to an N-lane layout in any way that would still make sense, so this trades that one
 * animation for a plain, correct cross-fade (the lane nodes' own entrance motion) instead of an
 * unfinished attempt at reproducing it.
 */
export function RunView({ gateRun, runId, scenario, summary, backTo, navigate, embedded }: Props) {
  const reduced = !!useReducedMotion();
  const [engine] = useState(() => new SwimlaneEngine(gateRun));
  const swimUi = useSyncExternalStore(engine.subscribe, engine.getUI);
  const forkModel = useState(() => buildModel(gateRun))[0];

  // Hero/RunInspector/DiffPanel were built against the old two-lane engine's UIState -- structurally
  // compatible (same field names), so no changes needed there; this just relabels the swimlane engine's
  // equivalent fields (there is no "rewind" state anymore, and modelIndex was only ever used as a React
  // key by these components, so 0 is fine for a component that now fully remounts on run change anyway).
  const ui: UIState = { modelIndex: 0, step: swimUi.step, diverged: swimUi.diverged, playing: swimUi.playing, dragging: swimUi.dragging, rewinding: false };

  const stageRef = useRef<HTMLDivElement>(null);
  const [hover, setHoverState] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW_BREAKPOINT);
  // Phase 2.2 (docs/DECISIONS.md): set by RunInspector's "Fork from here", cleared once ForkPanel's own
  // engine.setForkValidating() takes over (ui.fork becomes non-null) or the panel is dismissed.
  const [pendingFork, setPendingFork] = useState<PendingFork | null>(null);
  const onForkFromHere = useCallback((step: number, tool: string) => {
    setPendingFork({ originNodeId: `s${step}`, tool });
  }, []);

  const setHover = useCallback(
    (id: string | null) => {
      setHoverState(id);
      engine.setHover(id);
    },
    [engine],
  );

  useEffect(() => {
    engine.reduced = reduced;
  }, [engine, reduced]);

  // Layout vars: --side-w is 0 whenever the Inspector reserves no horizontal space at all (collapsed, or
  // narrow-drawer mode where it overlays instead of pushing) -- .sw-region/.sw-timeline/Hero/RunHeader all
  // key off this single var, so the lane region always owns exactly what's left, never occluded.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    el.style.setProperty("--header-h", `${HEADER_H}px`);
    el.style.setProperty("--hero-h", `${HERO_H}px`);
    el.style.setProperty("--timeline-h", `${TIMELINE_H}px`);
    // Hero.tsx's own CSS defaults --plot-l to 88px, tuned for the old engine's wider canvas margins; the
    // swimlane view's left gutter is narrower, and Hero needs the room more (see the container-query fix
    // above for why hero-left's width is under real pressure at typical widths).
    el.style.setProperty("--plot-l", "28px");
    const apply = () => {
      const isNarrow = window.innerWidth < NARROW_BREAKPOINT;
      setNarrow(isNarrow);
      const reserved = inspectorOpen && !isNarrow ? inspectorWidth(window.innerWidth) : 0;
      el.style.setProperty("--side-w", `${reserved}px`);
      engine.resize();
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [engine, inspectorOpen]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const target = ev.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;
      const keys: Record<string, () => void> = {
        ArrowRight: () => engine.stepBy(1),
        ArrowLeft: () => engine.stepBy(-1),
        " ": () => engine.togglePlay(),
        Home: () => engine.seek(0),
        End: () => engine.seek(engine.model.kEnd),
        "=": () => engine.zoomBy(1),
        "+": () => engine.zoomBy(1),
        "-": () => engine.zoomBy(-1),
        "0": () => engine.fitAll(),
        i: () => setInspectorOpen((o) => !o),
      };
      if (keys[ev.key]) {
        ev.preventDefault();
        keys[ev.key]();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine]);

  return (
    <div className={embedded ? "stage stage-embedded" : "stage"} ref={stageRef}>
      <h1 className="sr-only">
        Agent Replay. {scenario}: {forkModel.run.result.verdict}.
      </h1>

      <Hero model={forkModel} ui={ui} />
      <RunHeader
        runId={runId}
        scenario={scenario}
        agentModule={forkModel.run.args.agent_module}
        verdict={forkModel.run.result.verdict}
        storage={forkModel.run.args.storage}
        backTo={backTo}
        navigate={navigate}
      />

      <div className="sw-region">
        <SwimlaneStage engine={engine} ui={swimUi} hover={hover} setHover={setHover} />
        <SwimlaneNodeCard engine={engine} hover={hover} />
      </div>

      <SwimlaneTimeline engine={engine} ui={swimUi} />

      {narrow && inspectorOpen && <div className="inspector-backdrop" onClick={() => setInspectorOpen(false)} />}
      <RunInspector
        model={forkModel}
        ui={ui}
        runId={runId}
        summary={summary}
        open={inspectorOpen}
        narrow={narrow}
        onClose={() => setInspectorOpen(false)}
        onForkFromHere={onForkFromHere}
      />
      <ForkPanel engine={engine} ui={swimUi} model={forkModel} scenario={scenario} runId={runId} pending={pendingFork} onDismissPending={() => setPendingFork(null)} />
      {!inspectorOpen && (
        <button type="button" className="inspector-tab" onClick={() => setInspectorOpen(true)} aria-label="Open inspector">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M6.5 2 3 5l3.5 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>Inspector</span>
        </button>
      )}

      <DiffPanel model={forkModel} runId={runId} scenario={scenario} />
    </div>
  );
}
