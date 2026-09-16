import { MotionConfig, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from "react";
import { Engine } from "./engine/Engine";
import { FIXTURES } from "./fixtures";
import { Header } from "./components/Header";
import { Hero } from "./components/Hero";
import { ForkOverlay } from "./components/ForkOverlay";
import { NodeCard } from "./components/NodeCard";
import { Inspector } from "./components/Inspector";
import { Timeline } from "./components/Timeline";
import { useRoute } from "./router";
import { CommitPage } from "./pages/CommitPage";
import { RunPage } from "./pages/RunPage";
import { DevFixturePage } from "./pages/DevFixturePage";

declare global {
  interface Window {
    __agentReplay?: Engine;
  }
}

export default function App() {
  const [route, navigate] = useRoute();

  return (
    <MotionConfig reducedMotion="user">
      {route.name === "commit" ? (
        <CommitPage sha={route.sha} navigate={navigate} />
      ) : route.name === "run" ? (
        <RunPage runId={route.runId} navigate={navigate} />
      ) : route.name === "dev" ? (
        <DevFixturePage name={route.fixture} navigate={navigate} />
      ) : (
        <FixtureDemo />
      )}
    </MotionConfig>
  );
}

/** The original fixture-driven demo (four static tapes) -- kept as the / landing page, completely
 * unchanged, per the task's "data-source change, not a redesign": real dashboard data lives at
 * /commit/:sha and /run/:runId instead of replacing this. */
function FixtureDemo() {
  const reduced = !!useReducedMotion();
  const [engine] = useState(() => {
    const e = new Engine(FIXTURES[0].run, 0);
    e.reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    return e;
  });
  const ui = useSyncExternalStore(engine.subscribe, engine.getUI);
  const model = engine.model;
  const fixture = FIXTURES[ui.modelIndex];

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(0);
  const [hover, setHoverState] = useState<string | null>(null);
  const [, setViewport] = useState(0);

  const setHover = useCallback(
    (id: string | null) => {
      setHoverState(id);
      engine.setHover(id);
    },
    [engine],
  );

  const selectTape = useCallback(
    (i: number) => {
      setSelected(i);
      setHover(null);
      engine.loadRun(FIXTURES[i].run, i);
    },
    [engine, setHover],
  );

  useEffect(() => {
    engine.setReduced(reduced);
  }, [engine, reduced]);

  useEffect(() => {
    engine.attach(canvasRef.current!, stageRef.current!);
    const onResize = () => {
      engine.resize();
      setViewport((v) => v + 1);
    };
    window.addEventListener("resize", onResize);
    if (import.meta.env.DEV) window.__agentReplay = engine;
    return () => {
      window.removeEventListener("resize", onResize);
      engine.detach();
    };
  }, [engine]);

  useEffect(() => {
    setHover(null);
  }, [ui.modelIndex, setHover]);

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
      } else if (/^[1-4]$/.test(ev.key)) {
        selectTape(Number(ev.key) - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine, selectTape]);

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
      className="stage"
      ref={stageRef}
      onPointerMove={(e) => e.pointerType === "mouse" && engine.setCursor(e.clientX, e.clientY)}
      onPointerLeave={() => engine.clearCursor()}
    >
      <h1 className="sr-only">
        Agent Replay. Tape {fixture.id}: {fixture.cause}, {fixture.title}.
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
      <Header fixture={fixture} selected={selected} onSelect={selectTape} />
      <Inspector model={model} fixture={fixture} ui={ui} />
      <Timeline engine={engine} model={model} ui={ui} />
      <NodeCard engine={engine} model={model} hover={hover} />
    </div>
  );
}
