/**
 * The shape of one gate-replay comparison, as computed by spike/gate.py and spike/gate_compare.py.
 *
 * gate.py has no JSON output mode today: it prints a text report. These types are the in-memory values
 * that report is printed from, keyed by their names in the Python source, so a future `gate.py --json`
 * can serialise them without renaming anything. Every field below cites where it comes from; nothing is
 * invented for the UI's convenience.
 */

/** spike/gate_compare.py CAUSES, plus FORBIDDEN. DIFFERENT_TOOL, DIFFERENT_ARGS and EXTRA_STEP were
 *  retired with the positional comparator (docs/DECISIONS.md, 2026-09-14) and can no longer be produced.
 *  FORBIDDEN is agent_replay/evaluate.py's own addition (the contract layer built on top of gate_compare,
 *  Phase 1 of the CLI packaging task): a human-authored `forbids` rule fired. Real dashboard data (Phase
 *  2) can carry it even though no fixture here happens to; gate_compare.py itself never produces it. */
export type Cause =
  | "MISSING_STEP"
  | "UNRECORDED"
  | "UNSOURCED_ARGUMENT"
  | "ORDER_VIOLATION"
  | "DIFFERENT_ANSWER"
  | "FORBIDDEN";

/** StepReport.attribution. WEAKLY_ATTRIBUTABLE (Phase 3 decision 1, docs/DECISIONS.md) is a step at or
 *  after a pass-through call -- a live sub-agent ran, so its own model is a second variable, even though
 *  every leaf tool result underneath it was still frozen like everywhere else. Distinct from UNATTRIBUTED
 *  (the harness's own synthetic error has already contaminated everything downstream): nothing has
 *  diverged here, the one-variable-changed guarantee just no longer holds. */
export type Attribution = "ATTRIBUTABLE" | "WEAKLY_ATTRIBUTABLE" | "UNATTRIBUTED";

/** StepReport.membership (Phase 1, UI): which part of the contract this call matched, or null when it
 *  matched neither (UNRECORDED/UNSOURCED_ARGUMENT). Lets the swimlane view show at a glance whether a
 *  call was mandatory or merely allowed -- see docs/LIMITATIONS.md, "A contract can only be as strict as
 *  the agent is consistent". */
export type Membership = "requires" | "permits" | null;

/** StepReport.gate_status. "pass_through" (Phase 3 decision 1, docs/DECISIONS.md) is a call to a tool
 *  that is itself a live sub-agent -- the real tool ran instead of being frozen; its own tool name is the
 *  sub-agent's name, which is how the swimlane view (engine/swimlane.ts) infers nesting. */
export type GateStatus = "recorded" | "unrecorded" | "pass_through" | "n/a";

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
  /** Phase 1 (UI): which agent made this call -- null for a fixture/older payload that predates this
   *  field. "supervisor" (or the bare-module agent name) for a top-level call, a specialist's own name
   *  for a nested pass-through call. */
  agent?: string | null;
  membership?: Membership;
}

/** spike/gate_compare.py ComparisonResult. Python tuples in answer_diff serialise as 2-element arrays. */
export interface ComparisonResult {
  steps: StepReport[];
  first_divergence: StepReport | null;
  attribution_boundary: number | null;
  /** Phase 3 decision 1 (docs/DECISIONS.md): gate_step of the earliest pass-through call, or null. */
  pass_through_boundary?: number | null;
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
