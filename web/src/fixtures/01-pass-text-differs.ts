import type { GateRun, StepReport } from "../types/gate";

/**
 * PASS: trajectories identical, final text differs.
 *
 * Provenance: VERBATIM from `gate.py --storage aws --run-id audit-golden-1 --agent-module audit_agent`
 * (2026-09-14). Verdict, counters, tokens, golden answer and the tool sequence are from that run's
 * report. The report truncates the candidate answer at 200 chars; only its last word ("SAFE TO DEPLOY")
 * is completed here. Step args were truncated in the terminal table and are filled from the pinned
 * manifest, which is the only way the calls could have matched golden.
 */
const MANIFEST = "file:///D:/Project/agent_replay/requirements.txt";

const match = (step: number, tool: string, args: Record<string, unknown>): StepReport => ({
  step,
  golden: { tool, args },
  candidate: { tool, args },
  gate_status: "recorded",
  cause: null,
  attribution: "ATTRIBUTABLE",
  mutated: false,
});

const steps: StepReport[] = [
  match(1, "read_manifest", { url: MANIFEST }),
  match(2, "get_package_info", { name: "boto3" }),
  match(3, "check_vulnerabilities", { name: "boto3", version: "1.43.93" }),
  match(4, "get_package_info", { name: "strands-agents" }),
  match(5, "check_vulnerabilities", { name: "strands-agents", version: "1.55.1" }),
  match(6, "get_package_info", { name: "strands-agents-tools" }),
  match(7, "check_vulnerabilities", { name: "strands-agents-tools", version: "0.8.8" }),
];

const fixture: GateRun = {
  args: {
    trace: null,
    run_id: "audit-golden-1",
    storage: "aws",
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
      "<thinking>All pinned packages ('boto3', 'strands-agents', and 'strands-agents-tools') have been checked for vulnerabilities, and none have been found. Therefore, the dependencies are safe to deploy.</thinking>\n\nSAFE TO DEPLOY\n",
    final_answer_sha256: "e2d6c629420aebbd74340e17bbea3716a3e43561b7662f9b34d1ddd9ddd1632a",
  },
  candidate_answer:
    "<thinking>All the packages ('boto3', 'strands-agents', and 'strands-agents-tools') have been checked for vulnerabilities and none were found. I can now give a final verdict.</thinking>\n\n\n\nSAFE TO DEPLOY\n",
  result: {
    steps,
    first_divergence: null,
    attribution_boundary: null,
    verdict: "PASS",
    answer_matched: false,
    answer_diff: null,
  },
  counters: { n_model: 4, injected: 7, unrecorded: 0, tool_bodies: 0 },
  tokens: { input_tokens: 4029, output_tokens: 391 },
};

export default fixture;
