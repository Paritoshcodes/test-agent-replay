import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import type { Engine } from "../engine/Engine";
import { CAUSE_TEXT, isTool, syntheticError, type ForkModel, type ForkNode } from "../engine/model";
import { CallCode } from "./code";
import { pad } from "./motion";

interface Props {
  engine: Engine;
  model: ForkModel;
  hover: string | null;
}

/** The payload a node reveals on hover or focus. */
export function NodeCard({ engine, model, hover }: Props) {
  const reduced = !!useReducedMotion();
  const node = model.nodes.find((n) => n.id === hover) ?? null;
  return (
    <div className="card-anchor" ref={engine.ref("card")}>
      <AnimatePresence>{node && <Card key={node.id} engine={engine} model={model} node={node} reduced={reduced} />}</AnimatePresence>
    </div>
  );
}

function Card({ engine, model, node, reduced }: { engine: Engine; model: ForkModel; node: ForkNode; reduced: boolean }) {
  const L = engine.layout;
  const x = engine.xOf(node.k);
  const y = engine.laneY(node.lane, node.k);
  const side = y - L.top > 330 ? "up" : "down";
  const align = x > L.mainW * 0.55 ? "left" : "right";
  const body = content(model, node);
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

function content(model: ForkModel, node: ForkNode) {
  const run = model.run;
  if (node.kind === "origin") {
    return {
      eyebrow: "Origin · T0",
      chip: <span className="chip" data-tone={run.args.prompt ? "blue" : undefined}>{run.args.prompt ? "prompt override" : "unchanged"}</span>,
      title: "Prompt",
      main: <pre className="code prose-code">{run.args.prompt ?? run.golden.prompt}</pre>,
      rows: (
        <>
          <Row k="model">{run.args.model_id ?? "same as recording"}</Row>
          <Row k="strict">{String(run.args.strict)}</Row>
        </>
      ),
    };
  }
  if (node.kind === "answer") {
    const golden = node.lane === "golden";
    return {
      eyebrow: node.lane === "fused" ? "Final answer" : golden ? "Golden answer" : "Candidate answer",
      chip: (
        <span className="chip" data-tone={run.result.answer_matched ? "green" : "amber"}>
          {run.result.answer_matched ? "text matched" : "text differs"}
        </span>
      ),
      title: golden ? model.goldenVerdict : model.candidateVerdict,
      main: <pre className="code prose-code">{(golden ? run.golden.final_answer : run.candidate_answer).trim()}</pre>,
      rows: <Row k="verdict">Informational. Affects the verdict only with --fail-on-answer.</Row>,
    };
  }
  const row = node.row!;
  const call = node.kind === "ghost" ? row.golden : node.call;
  const side = node.lane === "fused" ? "Golden = candidate" : node.kind === "ghost" ? "Candidate" : node.lane === "golden" ? "Golden" : "Candidate";
  let gate = row.gate_status as string;
  if (node.lane === "golden") gate = row.cause === "MISSING_STEP" ? "recorded, never consumed" : "recorded, consumed below";
  if (node.kind === "ghost") gate = "never called";
  return {
    eyebrow: `Step ${pad(row.step)} · ${side}`,
    chip: (
      <span className="chip" data-tone={row.cause ? "red" : undefined}>
        {row.cause ?? "MATCH"}
      </span>
    ),
    title: isTool(call) ? call.tool : "",
    main: <CallCode call={call} />,
    rows: (
      <>
        <Row k="gate">{gate}</Row>
        {node.lane !== "golden" && node.kind !== "ghost" && (
          <Row k="result">
            {row.gate_status === "unrecorded" && isTool(call) ? <code className="c-err">{syntheticError(call)}</code> : "recorded output, injected"}
          </Row>
        )}
        {row.cause && <Row k="cause">{CAUSE_TEXT[row.cause]}</Row>}
        <Row k="attribution">{row.attribution.toLowerCase()}</Row>
      </>
    ),
  };
}
