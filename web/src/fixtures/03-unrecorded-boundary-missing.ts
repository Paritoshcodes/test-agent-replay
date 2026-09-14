import type { GateRun, StepReport } from "../types/gate";

/**
 * FAIL with an attribution boundary partway through, and MISSING_STEP rows past it.
 *
 * Requested as MISSING_STEP mid-run with a boundary. gate_compare.py cannot produce that. MISSING_STEP
 * rows are always appended after the candidate's own calls, and a boundary only exists when an unrecorded
 * call exists, which always carries its own cause earlier in the list. So first_divergence is always that
 * UNRECORDED / UNSOURCED_ARGUMENT row, never MISSING_STEP. This is the real shape: UNRECORDED sets the
 * boundary at step 4, and golden's unconsumed calls land as UNATTRIBUTED MISSING_STEP rows at the end.
 *
 * Provenance: RECONSTRUCTED from the loosened-prompt gate run against the pre-pin golden (final answer
 * b41bbbfe..., 2026-09-14). Verbatim: verdict, per-row labels and attribution, the tool name on every
 * row, step 4's full call, counters and tokens. The terminal table truncated the other rows' args; they
 * are filled from that golden's own tool sequence, the only calls that could have matched or gone
 * missing. Step 6 is a retry of step 4 after its synthetic error. The candidate answer is illustrative.
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
    golden: { tool: "get_package_info", args: { name: "strands-agents" } },
    candidate: { tool: "get_package_info", args: { name: "strands-agents" } },
    gate_status: "recorded",
    cause: null,
    attribution: "ATTRIBUTABLE",
    mutated: false,
  },
  {
    step: 4,
    golden: null,
    candidate: { tool: "check_vulnerabilities", args: { name: "boto3", version: "1.43.93" } },
    gate_status: "unrecorded",
    cause: "UNRECORDED",
    attribution: "ATTRIBUTABLE",
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
    golden: null,
    candidate: { tool: "check_vulnerabilities", args: { name: "boto3", version: "1.43.93" } },
    gate_status: "unrecorded",
    cause: "UNRECORDED",
    attribution: "UNATTRIBUTED",
    mutated: false,
  },
  {
    step: 7,
    golden: { tool: "check_vulnerabilities", args: { name: "boto3", version: "1.21.33" } },
    candidate: null,
    gate_status: "n/a",
    cause: "MISSING_STEP",
    attribution: "UNATTRIBUTED",
    mutated: false,
  },
  {
    step: 8,
    golden: { tool: "get_package_info", args: { name: "strands-agents-tools" } },
    candidate: null,
    gate_status: "n/a",
    cause: "MISSING_STEP",
    attribution: "UNATTRIBUTED",
    mutated: false,
  },
  {
    step: 9,
    golden: { tool: "check_vulnerabilities", args: { name: "strands-agents-tools", version: "0.8.8" } },
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
    prompt:
      "You are a dependency security auditor. Read the manifest and use your own judgment about which packages, if any, are worth checking for vulnerabilities. You do not need to check every pinned package. Process packages in alphabetical order by name. End your response on its own final line with a clear verdict: either 'SAFE TO DEPLOY' or 'BLOCKED: <reason>'.",
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
    "<thinking>The boto3 vulnerability check returned an error twice. strands-agents has no known vulnerabilities, and strands-agents-tools comes from the same project, so I did not check it separately.</thinking>\n\nSAFE TO DEPLOY\n",
  result: {
    steps,
    first_divergence: steps[3],
    attribution_boundary: 4,
    verdict: "FAIL",
    answer_matched: false,
    answer_diff: null,
  },
  counters: { n_model: 5, injected: 4, unrecorded: 2, tool_bodies: 0 },
  tokens: { input_tokens: 5437, output_tokens: 533 },
};

export default fixture;
