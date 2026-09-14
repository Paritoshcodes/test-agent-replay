import type { Call, GateRun, StepReport, ToolCall } from "../types/gate";

/**
 * Turns one gate.py result into the geometry-free shape the instrument draws.
 *
 * Time axis: k = 0 is the origin (the prompt, where any change under test enters), k = 1..n are the
 * comparator's rows in its own order (candidate execution order, then golden calls never consumed), and
 * k = n + 1 is the final answer. Rows before the first divergence are one fused strand; from the first
 * divergence on, golden and candidate each keep their own lane.
 */

export type Lane = "fused" | "golden" | "candidate";
export type NodeKind = "origin" | "step" | "ghost" | "answer";

export interface ForkNode {
  id: string;
  k: number;
  lane: Lane;
  kind: NodeKind;
  row: StepReport | null;
  /** The call this node stands for on its lane: golden's on the golden lane, candidate's otherwise. */
  call: Call | null;
  /** True when this node is where the row's cause shows (the side that is wrong or missing). */
  flagged: boolean;
  unattributed: boolean;
}

export interface ForkModel {
  run: GateRun;
  n: number;
  kEnd: number;
  /** k of the first divergence, or null on PASS. */
  d: number | null;
  boundary: number | null;
  nodes: ForkNode[];
  goldenVerdict: string;
  candidateVerdict: string;
}

export const isTool = (c: Call | null): c is ToolCall => !!c && "tool" in c;

/** gate.py prints the whole answer; the deploy verdict is its last non-empty line, tags stripped. */
export function verdictLine(answer: string): string {
  const lines = answer.split("\n").map((l) => l.replace(/<\/?[a-z]+>/g, "").trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  return last.length > 64 ? `${last.slice(0, 61)}...` : last;
}

export function buildModel(run: GateRun): ForkModel {
  const { steps, first_divergence, attribution_boundary } = run.result;
  const n = steps.length;
  const d = first_divergence ? first_divergence.step : null;
  const nodes: ForkNode[] = [
    { id: "origin", k: 0, lane: "fused", kind: "origin", row: null, call: null, flagged: false, unattributed: false },
  ];

  for (const row of steps) {
    const k = row.step;
    const unattributed = row.attribution === "UNATTRIBUTED";
    if (d === null || k < d) {
      nodes.push({ id: `s${k}`, k, lane: "fused", kind: "step", row, call: row.candidate ?? row.golden, flagged: false, unattributed });
      continue;
    }
    if (row.golden) {
      const flagged = row.cause === "MISSING_STEP";
      nodes.push({ id: `g${k}`, k, lane: "golden", kind: "step", row, call: row.golden, flagged, unattributed });
    }
    if (row.candidate) {
      const flagged = row.cause !== null && row.cause !== "MISSING_STEP";
      nodes.push({ id: `c${k}`, k, lane: "candidate", kind: "step", row, call: row.candidate, flagged, unattributed });
    } else {
      nodes.push({ id: `x${k}`, k, lane: "candidate", kind: "ghost", row, call: null, flagged: false, unattributed });
    }
  }

  const kEnd = n + 1;
  if (d === null) {
    nodes.push({ id: "answer", k: kEnd, lane: "fused", kind: "answer", row: null, call: null, flagged: false, unattributed: false });
  } else {
    const ua = attribution_boundary !== null;
    nodes.push({ id: "g-answer", k: kEnd, lane: "golden", kind: "answer", row: null, call: null, flagged: false, unattributed: ua });
    nodes.push({ id: "c-answer", k: kEnd, lane: "candidate", kind: "answer", row: null, call: null, flagged: false, unattributed: ua });
  }

  return {
    run,
    n,
    kEnd,
    d,
    boundary: attribution_boundary,
    nodes,
    goldenVerdict: verdictLine(run.golden.final_answer),
    candidateVerdict: verdictLine(run.candidate_answer),
  };
}

/** Short argument summary for a label: values only, in declared order ("boto3 1.43.93"). */
export function argSummary(call: Call | null): string {
  if (!isTool(call)) return "";
  return Object.values(call.args)
    .map((v) => {
      const s = String(v);
      if (s.startsWith("file:///")) return s.split("/").slice(-1)[0];
      return s;
    })
    .join(" ");
}

export const CAUSE_TEXT: Record<string, string> = {
  MISSING_STEP: "A golden call the candidate never made.",
  UNRECORDED: "A candidate call with no golden counterpart. Its arguments trace to an earlier output or the prompt.",
  UNSOURCED_ARGUMENT: "A candidate call with no golden counterpart, carrying an argument found in no earlier output and no prompt.",
  ORDER_VIOLATION: "The same calls, but a happens-before edge from data flow in the golden run was broken.",
  DIFFERENT_ANSWER: "Trajectories match but the final text differs, and --fail-on-answer was set.",
  FORBIDDEN: "A human-authored forbids rule matched this call -- not inferred from any recording.",
};

export const GATE_TEXT: Record<string, string> = {
  recorded: "Matched a golden call by (tool, args). Its recorded result was injected; the tool body did not run.",
  unrecorded: "No golden call matched. The gate injected a synthetic error result and the run continued.",
  "n/a": "Never called by the candidate.",
};

/** The exact synthetic result spike/gate.py injects for an unrecorded call. */
export function syntheticError(call: ToolCall): string {
  return JSON.stringify({ error: "unrecorded_tool_call", tool: call.tool, args: call.args });
}
