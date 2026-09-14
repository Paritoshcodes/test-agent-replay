import { motion, useReducedMotion } from "motion/react";
import type { PointerEvent } from "react";
import type { Engine, UIState } from "../engine/Engine";
import { isTool, type ForkModel } from "../engine/model";
import { Hairline, Odometer, RollText, pad, rise } from "./motion";

interface Props {
  engine: Engine;
  model: ForkModel;
  ui: UIState;
}

export function describeStep(model: ForkModel, k: number): string {
  if (k <= 0) return "origin · prompt enters";
  if (k >= model.kEnd) return `final answer · ${model.candidateVerdict}`;
  const row = model.run.result.steps[k - 1];
  const call = row.candidate ?? row.golden;
  return `${isTool(call) ? call.tool : ""} · ${row.cause ?? "match"} · ${row.attribution.toLowerCase()}`;
}

export function Timeline({ engine, model, ui }: Props) {
  const reduced = !!useReducedMotion();
  const k = Math.max(0, ui.step);

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    engine.beginDrag(e.clientX);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) engine.drag(e.clientX);
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    engine.endDrag();
  };

  const kind = (i: number): string => {
    if (i === 0 || i === model.kEnd) return "edge";
    if (model.d !== null && i === model.d) return "div";
    const cause = model.run.result.steps[i - 1].cause;
    if (cause === "MISSING_STEP") return "missing";
    return cause ? "flag" : "step";
  };

  return (
    <footer className="timeline">
      <Hairline axis="x" className="timeline-rule" delay={0.3} />

      <div
        className="track-zone"
        role="slider"
        tabIndex={0}
        aria-label="Playhead. Drag to move through the run. Arrow keys step, space plays."
        aria-valuemin={0}
        aria-valuemax={model.kEnd}
        aria-valuenow={k}
        aria-valuetext={`Step ${k} of ${model.kEnd}: ${describeStep(model, k)}`}
        data-dragging={ui.dragging}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onLostPointerCapture={() => engine.endDrag()}
      >
        <div className="track-base" ref={engine.ref("track")} />
        {model.boundary !== null && <div key={`h${ui.modelIndex}`} className="track-hatch" ref={engine.ref("track-hatch")} />}
        <div className="track-fill" ref={engine.ref("fill")} />
        {Array.from({ length: model.kEnd + 1 }, (_, i) => (
          <div key={`${ui.modelIndex}-${i}`} className="tick" ref={engine.ref(`tick:${i}`)} data-kind={kind(i)} data-past={k >= i} data-current={k === i} style={{ visibility: "hidden" }}>
            <i className="tick-mark" />
            <span className="tick-label">{i === 0 ? "T0" : i === model.kEnd ? "ANS" : pad(i)}</span>
          </div>
        ))}
        <div className="handle" ref={engine.ref("handle")}>
          <span className="handle-knob" />
        </div>
      </div>

      <motion.div className="controls" {...rise(reduced, 0.9, 6)}>
        <div className="tbtns">
          <button type="button" className="tbtn" aria-label="Jump to origin (Home)" onClick={() => engine.seek(0)}>
            <Icon d="M4.5 4v12M15.5 4 8 10l7.5 6z" />
          </button>
          <button type="button" className="tbtn" aria-label="Step back (Left arrow)" onClick={() => engine.stepBy(-1)}>
            <Icon d="M12.5 5 7.5 10l5 5" stroke />
          </button>
          <button type="button" className="tbtn tbtn-primary" data-playing={ui.playing} aria-label={ui.playing ? "Pause (Space)" : "Play (Space)"} onClick={() => engine.togglePlay()}>
            {ui.playing ? <Icon d="M7 5h2.2v10H7zM10.8 5H13v10h-2.2z" /> : <Icon d="M7.5 5.2v9.6L15 10z" />}
          </button>
          <button type="button" className="tbtn" aria-label="Step forward (Right arrow)" onClick={() => engine.stepBy(1)}>
            <Icon d="m7.5 5 5 5-5 5" stroke />
          </button>
          <button type="button" className="tbtn" aria-label="Jump to final answer (End)" onClick={() => engine.seek(model.kEnd)}>
            <Icon d="M15.5 4v12M4.5 4 12 10l-7.5 6z" />
          </button>
        </div>

        <div className="timecode">
          <span className="tc-label">
            {k >= model.kEnd ? (
              "ANS"
            ) : (
              <>
                T+
                <Odometer value={pad(k)} />
              </>
            )}
          </span>
          <span className="tc-den">/ {pad(model.n)}</span>
          <RollText className="tc-desc" text={describeStep(model, k)} />
        </div>

        <div className="hints" aria-hidden>
          <span>
            <kbd>←</kbd>
            <kbd>→</kbd>step
          </span>
          <span>
            <kbd>space</kbd>play
          </span>
          <span className="hint-extra">
            <kbd>1</kbd>
            <kbd>4</kbd>tapes
          </span>
        </div>
      </motion.div>
    </footer>
  );
}

function Icon({ d, stroke = false }: { d: string; stroke?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden>
      <path d={d} fill={stroke ? "none" : "currentColor"} stroke="currentColor" strokeWidth={stroke ? 1.8 : 0.6} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
