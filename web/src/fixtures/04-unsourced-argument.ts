import type { GateRun, StepReport } from "../types/gate";

/**
 * FAIL: UNSOURCED_ARGUMENT, the hallucinated-version case.
 *
 * With boto3 unpinned in requirements.txt, the model invented a boto3 version (1.26.145) that appears in
 * no tool output and no prompt. golden made the same mistake with a different number (1.21.33), which is
 * why golden's own boto3 check surfaces as a MISSING_STEP at the end. Nothing was changed for this run.
 *
 * Provenance: RECONSTRUCTED from run 5 of the five unchanged-configuration gate runs against the pre-pin
 * golden (final answer b41bbbfe..., 2026-09-14). Verbatim: the FAIL verdict and the first divergence
 * (step 3, UNSOURCED_ARGUMENT, check_vulnerabilities boto3 1.26.145, golden none). That run's report was
 * only grepped for its first divergence, so the remaining rows are derived by running that golden's tool
 * sequence through gate_compare's rules. Counters, tokens and the candidate answer are illustrative.
 */
const MANIFEST = "file:///D:/Project/agent_replay/requirements.txt";

const steps: StepReport[] = [
  {
    step: 1,
    golden: { tool: "read_manifest", args: { url: MANIFEST } },
    candidate: { tool: "read_manifest", args: { url: MANIFEST } },
    gate_status: "recorded",
    cause: null,
    attribution: "ATTRIBUTABLE",
    mutated: false,
  },
  {
    step: 2,
    golden: { tool: "get_package_info", args: { name: "boto3" } },
    candidate: { tool: "get_package_info", args: { name: "boto3" } },
    gate_status: "recorded",
    cause: null,
    attribution: "ATTRIBUTABLE",
    mutated: false,
  },
  {
    step: 3,
    golden: null,
    candidate: { tool: "check_vulnerabilities", args: { name: "boto3", version: "1.26.145" } },
    gate_status: "unrecorded",
    cause: "UNSOURCED_ARGUMENT",
    attribution: "ATTRIBUTABLE",
    mutated: false,
  },
  {
    step: 4,
    golden: { tool: "get_package_info", args: { name: "strands-agents" } },
    candidate: { tool: "get_package_info", args: { name: "strands-agents" } },
    gate_status: "recorded",
    cause: null,
    attribution: "UNATTRIBUTED",
    mutated: false,
  },
  {
    step: 5,
    golden: { tool: "check_vulnerabilities", args: { name: "strands-agents", version: "1.55.1" } },
    candidate: { tool: "check_vulnerabilities", args: { name: "strands-agents", version: "1.55.1" } },
    gate_status: "recorded",
    cause: null,
    attribution: "UNATTRIBUTED",
    mutated: false,
  },
  {
    step: 6,
    golden: { tool: "get_package_info", args: { name: "strands-agents-tools" } },
    candidate: { tool: "get_package_info", args: { name: "strands-agents-tools" } },
    gate_status: "recorded",
    cause: null,
    attribution: "UNATTRIBUTED",
    mutated: false,
  },
  {
    step: 7,
    golden: { tool: "check_vulnerabilities", args: { name: "strands-agents-tools", version: "0.8.8" } },
    candidate: { tool: "check_vulnerabilities", args: { name: "strands-agents-tools", version: "0.8.8" } },
    gate_status: "recorded",
    cause: null,
    attribution: "UNATTRIBUTED",
    mutated: false,
  },
  {
    step: 8,
    golden: { tool: "check_vulnerabilities", args: { name: "boto3", version: "1.21.33" } },
    candidate: null,
    gate_status: "n/a",
    cause: "MISSING_STEP",
    attribution: "UNATTRIBUTED",
    mutated: false,
  },
];

const fixture: GateRun = {
  args: {
    trace: "traces/audit-001.json",
    run_id: null,
    storage: "local",
    prompt: null,
    model_id: null,
    strict: false,
    fail_on_answer: false,
    mutate: [],
    agent_module: "audit_agent",
  },
  golden: {
    prompt: `Audit the dependencies pinned in ${MANIFEST} and give a deploy verdict.`,
    final_answer:
      "<thinking>All pinned packages have been checked and no vulnerabilities were found for any of them. I can now give the final deploy verdict.</thinking>\n\n<response>SAFE TO DEPLOY</response>\n",
    final_answer_sha256: "b41bbbfed32fb88e49bce5995180c0d9e925aab794f44a153b96894dc07288ee",
  },
  candidate_answer:
    "<thinking>boto3 1.26.145 could not be checked: the lookup returned an error. strands-agents 1.55.1 and strands-agents-tools 0.8.8 have no known vulnerabilities.</thinking>\n\nSAFE TO DEPLOY\n",
  result: {
    steps,
    first_divergence: steps[2],
    attribution_boundary: 3,
    verdict: "FAIL",
    answer_matched: false,
    answer_diff: null,
  },
  counters: { n_model: 5, injected: 6, unrecorded: 1, tool_bodies: 0 },
  tokens: { input_tokens: 6012, output_tokens: 588 },
};

export default fixture;
