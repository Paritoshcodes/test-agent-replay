import { useEffect, useRef, type PointerEvent, type WheelEvent } from "react";
import type { SwimlaneEngine, SwimlaneUIState } from "../engine/SwimlaneEngine";
import { callOf, fullArgSummary, type Lane, type LaneNode } from "../engine/swimlane";
import { isToolCall } from "../engine/swimlane";

interface Props {
  engine: SwimlaneEngine;
  ui: SwimlaneUIState;
  hover: string | null;
  setHover: (id: string | null) => void;
}

/**
 * Canvas (drawn by engine/swimlaneRender.ts) plus its DOM twin: a fixed-width left gutter of lane headers
 * (name, collapse toggle, requires/permits summary) and, over the plot area, one focusable hit target +
 * label per node, positioned every frame by the engine exactly like engine/render.ts's ForkOverlay did for
 * the old two-lane view. Labels never truncate with an ellipsis where the value matters (Phase 1, docs/
 * DECISIONS.md): at low zoom, where a label would collide, it is hidden rather than cut -- the value is
 * always still reachable via hover (SwimlaneNodeCard) or the Inspector.
 */
export function SwimlaneStage({ engine, ui, hover, setHover }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    engine.attach(canvasRef.current!, containerRef.current!);
    const ro = new ResizeObserver(() => engine.resize());
    ro.observe(containerRef.current!);
    return () => {
      ro.disconnect();
      engine.detach();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = containerRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (e.shiftKey) engine.wheelPan(Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY);
    else engine.wheelZoom(e.deltaY, x);
  };

  // Background drag (not on a node, not on the ruler, not on a lane header) pans horizontally AND
  // scrolls the lane stack vertically at once (VISUAL 1, docs/DECISIONS.md) -- the ruler strip drags the
  // playhead instead (its own handler below).
  //
  // Root cause of the still-broken lane collapse click (docs/DECISIONS.md): this handler is on `.sw-stage`,
  // an ANCESTOR of the lane-header button and every node's hit target. A real pointerdown on that button
  // still bubbles up here, and this code called setPointerCapture on `.sw-stage` unconditionally -- which
  // hijacks that pointerId's eventual pointerup away from the button, so the browser never completes a
  // "click" on it. The comment already said "not on a lane header"; the code never actually checked that.
  // Found by testing with a REAL coordinate click (not a synthetic .click(), which bypasses capture/bubbling
  // entirely and would never have caught this) -- aria-expanded stayed "true" after a real click, which is
  // what exposed this.
  const bgDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    engine.beginPan(e.clientX, e.clientY);
  };
  const bgMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) engine.pan(e.clientX, e.clientY);
  };
  const bgUp = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    engine.endPan();
  };

  const rulerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    engine.beginScrub(e.clientX);
  };
  const rulerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) engine.scrub(e.clientX);
  };
  const rulerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    engine.endScrub();
  };

  return (
    <div
      className="sw-stage"
      ref={containerRef}
      onWheel={onWheel}
      onPointerDown={bgDown}
      onPointerMove={bgMove}
      onPointerUp={bgUp}
      onPointerCancel={bgUp}
      onLostPointerCapture={() => engine.endPan()}
      data-panning={ui.panning}
    >
      <canvas className="sw-canvas" ref={canvasRef} aria-hidden />

      <div
        className="sw-ruler-hit"
        style={{ left: engine.layout.plotL, right: engine.layout.W - engine.layout.plotR }}
        role="slider"
        tabIndex={0}
        aria-label="Playhead. Drag to scrub. Left/Right arrow keys step, space plays."
        aria-valuemin={0}
        aria-valuemax={engine.model.kEnd}
        aria-valuenow={ui.step}
        onPointerDown={rulerDown}
        onPointerMove={rulerMove}
        onPointerUp={rulerUp}
        onPointerCancel={rulerUp}
        onLostPointerCapture={() => engine.endScrub()}
      />

      <div className="sw-gutter" style={{ width: engine.layout.leftGutter }}>
        {engine.model.lanes.map((lane) => (
          <LaneHead key={lane.id} engine={engine} lane={lane} />
        ))}
      </div>

      <div className="sw-overlay">
        {engine.model.lanes.map((lane) =>
          lane.nodes.map((node, i) => <NodeDom key={node.id} engine={engine} node={node} i={i} hover={hover} setHover={setHover} />),
        )}
      </div>
    </div>
  );
}

function LaneHead({ engine, lane }: { engine: SwimlaneEngine; lane: Lane }) {
  // BUG 1 fix (docs/DECISIONS.md): the ENTIRE row is now one <button>, not just the chevron glyph --
  // clicking the name, the summary text, or the empty padding around them all toggle the lane, plus
  // native keyboard activation (Enter/Space) for free, since it's a real <button> element.
  const summary = `${lane.requiredCount} required · ${lane.permittedCount} permitted`;
  // Phase 2.2 (docs/DECISIONS.md): a fork lane's own id is "fork:<agent>" (SwimlaneEngine.addForkStep) --
  // display just the agent name plus a small "FORK" tag, rather than the raw id, which is otherwise only
  // ever a real agent name and never needed this kind of split.
  const displayName = lane.isFork ? lane.id.slice("fork:".length) : lane.id;
  return (
    <div className="sw-lanehead" ref={engine.ref(`lanehead:${lane.id}`)} data-depth={lane.depth} data-fork={lane.isFork || undefined}>
      <button
        type="button"
        className="sw-lane-row"
        style={{ paddingLeft: 8 + lane.depth * 14 }}
        aria-expanded={!lane.collapsed}
        aria-label={`${lane.collapsed ? "Expand" : "Collapse"} ${lane.isFork ? "forked " : ""}${displayName} lane, ${summary}`}
        onClick={() => engine.toggleLane(lane.id)}
      >
        <svg className="sw-lane-chevron" width="9" height="9" viewBox="0 0 10 10" aria-hidden style={{ transform: lane.collapsed ? "rotate(-90deg)" : "none" }}>
          <path d="M2 3.5 5 7l3-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="sw-lane-text">
          {/* VISUAL 3 fix: the gutter is wider now AND wraps instead of ellipsizing when a name still
              doesn't fit -- "sub_verifier_agent" no longer truncates the way it did. */}
          <span className="sw-lane-name">
            {displayName}
            {lane.isFork && <span className="sw-lane-fork-tag">FORK</span>}
          </span>
          {/* VISUAL 2 fix: this replaces a badge on every permitted node (noise once most calls in a lane
              are permitted, which is schedule-meter-reading's own real shape) with one summary line that
              IS the story at a glance, still readable at 50% scale. */}
          <span className="sw-lane-summary">{summary}</span>
        </span>
      </button>
    </div>
  );
}

function NodeDom({
  engine,
  node,
  i,
  hover,
  setHover,
}: {
  engine: SwimlaneEngine;
  node: LaneNode;
  i: number;
  hover: string | null;
  setHover: (id: string | null) => void;
}) {
  const call = callOf(node);
  const tool = isToolCall(call) ? call.tool : node.ghost ? "never called" : "";
  const arg = fullArgSummary(call);
  const pos = i % 2 === 0 ? "up" : "down";

  // Label level-of-detail (full / tool-only / hidden), whether this is the badge-eligible node, and
  // whether it's under the playhead all depend on the CURRENT zoom/hover/playhead state, which can change
  // every frame during a zoom/pan animation without any of this component's own props changing -- so none
  // of it is decided here. The engine writes data-labelmode/data-current/data-badge onto this same element
  // every frame (SwimlaneEngine.writeAnchors), and CSS does the actual showing/hiding. The label markup
  // itself is always present in the DOM; nothing here ever truncates it with an ellipsis -- "hidden"
  // removes the whole label, it does not cut the text (Phase 1, docs/DECISIONS.md).
  return (
    <div className="sw-node" ref={engine.ref(`node:${node.id}`)} data-flag={node.flagged} data-ghost={node.ghost} data-hover={hover === node.id} style={{ visibility: "hidden" }}>
      <button
        type="button"
        className="sw-node-hit"
        aria-label={ariaFor(node, tool)}
        onPointerEnter={() => setHover(node.id)}
        onPointerLeave={() => setHover(null)}
        onFocus={() => setHover(node.id)}
        onBlur={() => setHover(null)}
        onClick={() => engine.seek(node.k)}
      />
      {tool && (
        <span className="sw-lbl" data-pos={pos}>
          <span className="sw-lbl-tool">{tool}</span>
          {arg && <span className="sw-lbl-arg">{arg}</span>}
          {node.membership === "permits" && <span className="sw-lbl-permit">permitted</span>}
        </span>
      )}
    </div>
  );
}

function ariaFor(node: LaneNode, tool: string): string {
  const s = node.step;
  const membership = s.membership ? `, ${s.membership}` : "";
  return `Step ${s.step}, ${node.laneId}: ${tool}${membership}. ${s.cause ?? "match"}, ${s.attribution.toLowerCase()}.`;
}
