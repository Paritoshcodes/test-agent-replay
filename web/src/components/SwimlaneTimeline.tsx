import { motion, useReducedMotion } from "motion/react";
import type { SwimlaneEngine, SwimlaneUIState } from "../engine/SwimlaneEngine";
import { ZOOM_LEVELS } from "../engine/SwimlaneEngine";
import { callOf, isToolCall, shortArgSummary } from "../engine/swimlane";
import { Minimap } from "./Minimap";
import { Odometer, RollText, pad, rise } from "./motion";

interface Props {
  engine: SwimlaneEngine;
  ui: SwimlaneUIState;
}

function describeStep(engine: SwimlaneEngine, k: number): string {
  const m = engine.model;
  if (k <= 0) return "origin · prompt enters";
  if (k >= m.kEnd) return "final answer";
  const node = [...m.lanes.flatMap((l) => l.nodes)].find((n) => n.k === k);
  if (!node) return "";
  const call = callOf(node);
  const tool = isToolCall(call) ? `${call.tool} ${shortArgSummary(call, 28)}` : node.ghost ? "never called" : "";
  return `${node.laneId} · ${tool} · ${node.step.cause ?? "match"}`;
}

/** Transport bar for the swimlane view: play/step/seek, zoom presets, and the minimap. Distinct from the
 *  old Timeline.tsx (still used unchanged by the fixture demo's two-lane view) because a DAW-style
 *  timeline needs zoom controls and a minimap that a single 7-step fixture never did. */
export function SwimlaneTimeline({ engine, ui }: Props) {
  const reduced = !!useReducedMotion();
  const k = Math.max(0, ui.step);

  return (
    <footer className="sw-timeline">
      <Minimap engine={engine} />

      <motion.div className="sw-controls" {...rise(reduced, 0.3, 6)}>
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
          <button type="button" className="tbtn" aria-label="Jump to final answer (End)" onClick={() => engine.seek(engine.model.kEnd)}>
            <Icon d="M15.5 4v12M4.5 4 12 10l-7.5 6z" />
          </button>
        </div>

        <div className="timecode">
          <span className="tc-label">
            {k >= engine.model.kEnd ? "ANS" : (
              <>
                T+
                <Odometer value={pad(k)} />
              </>
            )}
          </span>
          <span className="tc-den">/ {pad(engine.model.n)}</span>
          <RollText className="tc-desc" text={describeStep(engine, k)} />
        </div>

        <div className="zoom-group" role="group" aria-label="Zoom">
          <button type="button" className="tbtn zbtn" aria-label="Zoom out" onClick={() => engine.zoomBy(-1)}>
            <Icon d="M5 10h10" stroke />
          </button>
          <button type="button" className="tbtn zbtn" data-active={engine.fitToWidth} aria-label="Fit to width" onClick={() => engine.fitAll()}>
            fit
          </button>
          {ZOOM_LEVELS.slice(1).map((z, i) => (
            <button
              key={z}
              type="button"
              className="tbtn zbtn"
              data-active={!engine.fitToWidth && engine.zoomIndex === i + 1}
              aria-label={`Zoom to ${z}x`}
              onClick={() => engine.setZoom(i + 1)}
            >
              {z}×
            </button>
          ))}
          <button type="button" className="tbtn zbtn" aria-label="Zoom in" onClick={() => engine.zoomBy(1)}>
            <Icon d="M5 10h10M10 5v10" stroke />
          </button>
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
            drag lane background to pan · wheel to zoom · shift+wheel to pan
          </span>
        </div>
      </motion.div>
    </footer>
  );
}

function Icon({ d, stroke = false }: { d: string; stroke?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden>
      <path d={d} fill={stroke ? "none" : "currentColor"} stroke="currentColor" strokeWidth={stroke ? 1.8 : 0.6} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
