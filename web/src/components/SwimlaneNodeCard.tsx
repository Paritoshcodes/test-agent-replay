import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import type { SwimlaneEngine } from "../engine/SwimlaneEngine";
import { callOf, isToolCall, type LaneNode } from "../engine/swimlane";
import { CAUSE_TEXT, syntheticError } from "../engine/model";
import { CallCode } from "./code";
import { pad } from "./motion";

interface Props {
  engine: SwimlaneEngine;
  hover: string | null;
}

/** The payload a node reveals on hover or focus -- same card shell/positioning idea as the old NodeCard,
 *  adapted to a node identified by (agent lane, step) instead of (golden|candidate lane, step). */
export function SwimlaneNodeCard({ engine, hover }: Props) {
  const reduced = !!useReducedMotion();
  const node = hover ? engine.model.nodeById.get(hover) ?? null : null;
  return (
    <div className="card-anchor" ref={engine.ref("card")}>
      <AnimatePresence>{node && <Card key={node.id} engine={engine} node={node} reduced={reduced} />}</AnimatePresence>
    </div>
  );
}

function Card({ engine, node, reduced }: { engine: SwimlaneEngine; node: LaneNode; reduced: boolean }) {
  const L = engine.layout;
  const x = engine.xOf(node.k);
  const y = engine.laneY(node.laneId);
  const side = y - L.rulerH > L.H * 0.55 ? "up" : "down";
  const align = x > (L.plotL + L.plotR) / 2 ? "left" : "right";
  const body = content(node);
  return (
    <motion.div
      className="card"
      data-side={side}
      data-align={align}
      style={{ transformOrigin: `${align === "right" ? "24px" : "calc(100% - 24px)"} ${side === "up" ? "100%" : "0"}` }}
      initial={reduced ? false : { opacity: 0, scale: 0.96, y: side === "up" ? 6 : -6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
      transition={{ type: "spring", stiffness: 600, damping: 38, mass: 0.6 }}
    >
      <div className="card-head">
        <span className="card-eyebrow">{body.eyebrow}</span>
        {body.chip}
      </div>
      <div className="card-title">{body.title}</div>
      {body.main}
      <dl className="kv card-kv">{body.rows}</dl>
    </motion.div>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{children}</dd>
    </>
  );
}

function content(node: LaneNode) {
  const s = node.step;
  const call = callOf(node);

  if (node.ghost) {
    return {
      eyebrow: `Step ${pad(s.step)} · ${node.laneId}`,
      chip: <span className="chip" data-tone="red">MISSING_STEP</span>,
      title: isToolCall(s.golden) ? s.golden.tool : "",
      main: <CallCode call={s.golden} />,
      rows: (
        <>
          <Row k="membership">requires</Row>
          <Row k="cause">{CAUSE_TEXT.MISSING_STEP}</Row>
        </>
      ),
    };
  }

  return {
    eyebrow: `Step ${pad(s.step)} · ${node.laneId}`,
    chip: (
      <span className="chip" data-tone={s.cause ? "red" : s.membership === "permits" ? undefined : "green"}>
        {s.cause ?? (s.membership === "permits" ? "permitted" : "MATCH")}
      </span>
    ),
    title: isToolCall(call) ? call.tool : "",
    main: <CallCode call={call} />,
    rows: (
      <>
        <Row k="membership">{s.membership ?? "not in contract"}</Row>
        <Row k="gate">{s.gate_status}</Row>
        {s.gate_status === "unrecorded" && isToolCall(call) && (
          <Row k="result">
            <code className="c-err">{syntheticError(call)}</code>
          </Row>
        )}
        {s.cause && <Row k="cause">{CAUSE_TEXT[s.cause]}</Row>}
        <Row k="attribution">{s.attribution.toLowerCase()}</Row>
      </>
    ),
  };
}
