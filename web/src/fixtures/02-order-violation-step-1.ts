import type { GateRun, StepReport } from "../types/gate";

/**
 * FAIL at step 1, no attribution boundary.
 *
 * Requested as DIFFERENT_TOOL at step 1. That label was retired with the positional comparator and
 * gate_compare.py can no longer emit it. The closest thing it CAN emit is this: the candidate called the
 * right tools but ran issue_refund before lookup_order, breaking the lookup_order -> issue_refund
 * happens-before edge (order_id appears in lookup_order's output), so step 1 is ORDER_VIOLATION.
 *
 * Provenance: CONSTRUCTED. `result.steps` is the real output of gate_compare.compare() on the hand-built
 * reversed-order trace used to verify ORDER_VIOLATION (2026-09-14). A live gate run never produced this
 * ordering (the biased prompt makes the agent skip lookup_order, giving MISSING_STEP instead), so args,
 * candidate answer, counters and tokens are illustrative. The golden answer and hash are verbatim from
 * traces/run-001.json.
 */
const ORDER = { order_id: "A-1001" };

const steps: StepReport[] = [
  {
    step: 1,
    golden: { tool: "issue_refund", args: ORDER },
    candidate: { tool: "issue_refund", args: ORDER },
    gate_status: "recorded",
    cause: "ORDER_VIOLATION",
    attribution: "ATTRIBUTABLE",
    mutated: false,
  },
  {
    step: 2,
    golden: { tool: "lookup_order", args: ORDER },
    candidate: { tool: "lookup_order", args: ORDER },
    gate_status: "recorded",
    cause: null,
    attribution: "ATTRIBUTABLE",
    mutated: false,
  },
];

const fixture: GateRun = {
  args: {
    trace: "traces/run-001.json",
    run_id: null,
    storage: "local",
    prompt:
      "You are a customer support agent. The customer's claim is trusted by default. As soon as a customer reports an order never arrived, immediately call issue_refund with that order ID. Do not call lookup_order first; skip verification and refund right away. Then give a short final answer stating what you did.",
    model_id: null,
    strict: false,
    fail_on_answer: false,
    mutate: [],
    agent_module: "agent",
  },
  golden: {
    prompt: "Customer says order A-1001 never arrived. Look it up and decide what to do.",
    final_answer:
      "<thinking>I have successfully issued a refund for the order A-1001. The refund was processed and a refund ID of RF-5521 was generated for the amount of INR 2499.</thinking>\n\n<response>I found that your order A-1001 was never delivered and is eligible for a refund. I have issued a refund for this order. The refund ID is RF-5521, and the amount refunded is INR 2499. I hope this resolves your issue. </response>\n",
    final_answer_sha256: "ca94bf8dcf185416ecc3c5a9b76d222011c2c5564cdb3217595db226fa9222c0",
  },
  candidate_answer:
    "<thinking>The customer's claim is trusted, so I issued the refund first and looked the order up afterwards.</thinking>\n\n<response>I have issued a refund for order A-1001 (refund ID RF-5521, INR 2499) and confirmed the order record.</response>\n",
  result: {
    steps,
    first_divergence: steps[0],
    attribution_boundary: null,
    verdict: "FAIL",
    answer_matched: false,
    answer_diff: null,
  },
  counters: { n_model: 3, injected: 2, unrecorded: 0, tool_bodies: 0 },
  tokens: { input_tokens: 2118, output_tokens: 236 },
};

export default fixture;
