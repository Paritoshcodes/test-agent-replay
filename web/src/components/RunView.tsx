import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from "react";
import { useReducedMotion } from "motion/react";
import { Engine } from "../engine/Engine";
import type { GateRun } from "../types/gate";
import type { CommitRunSummary } from "../api";
import { RunHeader } from "./RunHeader";
import { Hero } from "./Hero";
import { ForkOverlay } from "./ForkOverlay";
import { NodeCard } from "./NodeCard";
import { RunInspector } from "./RunInspector";
import { Timeline } from "./Timeline";
import { DiffPanel } from "./DiffPanel";

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

/**
 * Hosts one Engine for one real run -- the SAME canvas/scrubbing/fork rendering App.tsx's fixture demo
 * uses (Engine, ForkOverlay, NodeCard, Timeline, Hero: all imported unchanged), swapping only the
 * fixture-specific chrome (RunHeader instead of the tape-switcher Header, RunInspector instead of
 * Inspector's fixture-bound Source/Change tabs) plus the accept-flow's DiffPanel on a FAIL. This is the
 * "data-source change, not a redesign" the task asked for: everything visual and interactive below the
 * header/inspector line is identical code to the fixture demo.
 */
export function RunView({ gateRun, runId, scenario, summary, backTo, navigate, embedded }: Props) {
  const reduced = !!useReducedMotion();
  const indexRef = useRef(0);
  const [engine] = useState(() => {
    const e = new Engine(gateRun, 0);
    e.reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    return e;
  });
  const ui = useSyncExternalStore(engine.subscribe, engine.getUI);
  const model = engine.model;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [hover, setHoverState] = useState<string | null>(null);
  const loadedRunId = useRef(runId);

  const setHover = useCallback(
    (id: string | null) => {
      setHoverState(id);
      engine.setHover(id);
    },
    [engine],
  );

  useEffect(() => {
    engine.setReduced(reduced);
  }, [engine, reduced]);

  useEffect(() => {
    engine.attach(canvasRef.current!, stageRef.current!);
    const onResize = () => engine.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      engine.detach();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  useEffect(() => {
    if (loadedRunId.current === runId) return;
    loadedRunId.current = runId;
    indexRef.current += 1;
    setHover(null);
    engine.loadRun(gateRun, indexRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, gateRun, engine]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const keys: Record<string, () => void> = {
        ArrowRight: () => engine.stepBy(1),
        ArrowLeft: () => engine.stepBy(-1),
        " ": () => engine.togglePlay(),
        Home: () => engine.seek(0, "key"),
        End: () => engine.seek(engine.model.kEnd, "key"),
      };
      if (keys[ev.key]) {
        ev.preventDefault();
        keys[ev.key]();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine]);

  const scrubDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    engine.beginDrag(e.clientX);
  };
  const scrubMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) engine.drag(e.clientX);
  };
  const scrubUp = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    engine.endDrag();
  };

  return (
    <div
      className={embedded ? "stage stage-embedded" : "stage"}
      ref={stageRef}
      onPointerMove={(e) => e.pointerType === "mouse" && engine.setCursor(e.clientX, e.clientY)}
      onPointerLeave={() => engine.clearCursor()}
    >
      <h1 className="sr-only">
        Agent Replay. {scenario}: {model.run.result.verdict}.
      </h1>

      <canvas
        className="canvas"
        ref={canvasRef}
        data-dragging={ui.dragging}
        aria-hidden
        onPointerDown={scrubDown}
        onPointerMove={scrubMove}
        onPointerUp={scrubUp}
        onPointerCancel={scrubUp}
        onLostPointerCapture={() => engine.endDrag()}
        onWheel={(e) => {
          const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          if (delta) engine.wheel(delta);
        }}
      />
      <ForkOverlay engine={engine} model={model} ui={ui} hover={hover} setHover={setHover} />

      <Hero model={model} ui={ui} />
      <RunHeader
        runId={runId}
        scenario={scenario}
        agentModule={model.run.args.agent_module}
        verdict={model.run.result.verdict}
        storage={model.run.args.storage}
        backTo={backTo}
        navigate={navigate}
      />
      <RunInspector model={model} ui={ui} runId={runId} summary={summary} />
      <Timeline engine={engine} model={model} ui={ui} />
      <NodeCard engine={engine} model={model} hover={hover} />
      <DiffPanel model={model} runId={runId} scenario={scenario} />
    </div>
  );
}
