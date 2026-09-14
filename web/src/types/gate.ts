/**
 * The shape of one gate-replay comparison, as computed by spike/gate.py and spike/gate_compare.py.
 *
 * gate.py has no JSON output mode today: it prints a text report. These types are the in-memory values
 * that report is printed from, keyed by their names in the Python source, so a future `gate.py --json`
 * can serialise them without renaming anything. Every field below cites where it comes from; nothing is
 * invented for the UI's convenience.
 */

/** spike/gate_compare.py CAUSES. DIFFERENT_TOOL, DIFFERENT_ARGS and EXTRA_STEP were retired with the
 *  positional comparator (docs/DECISIONS.md, 2026-09-14) and can no longer be produced. */
export type Cause =
  | "MISSING_STEP"
  | "UNRECORDED"
  | "UNSOURCED_ARGUMENT"
  | "ORDER_VIOLATION"
  | "DIFFERENT_ANSWER";

/** StepReport.attribution */
export type Attribution = "ATTRIBUTABLE" | "UNATTRIBUTED";

/** StepReport.gate_status */
export type GateStatus = "recorded" | "unrecorded" | "n/a";

/** StepReport.golden / .candidate: {"tool", "args"} for a tool call, {"answer"} for a DIFFERENT_ANSWER row. */
export type ToolCall = { tool: string; args: Record<string, unknown> };
export type AnswerCall = { answer: string };
export type Call = ToolCall | AnswerCall;

/** spike/gate_compare.py StepReport */
export interface StepReport {
  step: number;
  golden: Call | null;
  candidate: Call | null;
  gate_status: GateStatus;
  cause: Cause | null;
  attribution: Attribution;
  mutated: boolean;
}

/** spike/gate_compare.py ComparisonResult. Python tuples in answer_diff serialise as 2-element arrays. */
export interface ComparisonResult {
  steps: StepReport[];
  first_divergence: StepReport | null;
  attribution_boundary: number | null;
  verdict: "PASS" | "FAIL";
  answer_matched: boolean;
  answer_diff: Record<string, [unknown, unknown]> | null;
}

/** spike/gate.py argparse namespace: the flags behind "1. What changed". */
export interface GateArgs {
  trace: string | null;
  run_id: string | null;
  storage: "local" | "aws";
  prompt: string | null;
  model_id: string | null;
  strict: boolean;
  fail_on_answer: boolean;
  mutate: string[];
  agent_module: string;
}

/** spike/gate.py main() for one completed gate replay (not a --strict halt). */
export interface GateRun {
  args: GateArgs;
  /** The golden trace dict from storage (prompt, final_answer, final_answer_sha256). `events` is
   *  omitted: the screen renders result.steps, which gate_compare derives from those events. */
  golden: { prompt: string; final_answer: string; final_answer_sha256: string };
  /** str(agent(agent_mod.PROMPT)) */
  candidate_answer: string;
  result: ComparisonResult;
  /** "6. Counters": n_model, tap.injected, tap.unrecorded, COUNTS["tool_bodies"] */
  counters: { n_model: number; injected: number; unrecorded: number; tool_bodies: number };
  /** "7. Cost": _token_totals(candidate_trace) -> (input_tokens, output_tokens) */
  tokens: { input_tokens: number; output_tokens: number };
}
