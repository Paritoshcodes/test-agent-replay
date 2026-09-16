import type { Attribution, Cause, GateRun, GateStatus, Membership, StepReport } from "../types/gate";

/**
 * Synthetic fixtures for Phase 1's edge cases (docs/DECISIONS.md): a 40-step, 3-level-deep run, a 1-step
 * run, and very long tool names/arguments. Real runs against the sample repo are 7-8 steps and one level
 * of nesting -- they cannot exercise any of this, which is exactly why the task asked for these to be
 * built rather than recorded. The 3-level nesting here is fabricated data, not a real capability this
 * project's adapter has ever produced (it recurses exactly one level -- agents/supervisor.py's own
 * topology, see agent_replay/adapter.py's docstring); engine/swimlane.ts's reconstruction algorithm is
 * generic in nesting depth, so this exercises real, unmodified rendering code, not a special case.
 */

let seq = 0;
function nextId(): number {
  seq += 1;
  return seq;
}

interface StepSpec {
  agent: string;
  tool: string;
  args: Record<string, unknown>;
  gate_status?: GateStatus;
  cause?: Cause | null;
  membership?: Membership;
  attribution?: Attribution;
}

function buildSteps(specs: StepSpec[]): StepReport[] {
  return specs.map((s, i) => {
    const step = i + 1;
    const cause = s.cause ?? null;
    const call = { tool: s.tool, args: s.args };
    const golden = cause === "MISSING_STEP" ? call : cause === null || s.gate_status === "pass_through" || s.gate_status === "recorded" ? call : null;
    const candidate = cause === "MISSING_STEP" ? null : call;
    return {
      step,
      golden,
      candidate,
      gate_status: s.gate_status ?? "recorded",
      cause,
      attribution: s.attribution ?? "ATTRIBUTABLE",
      mutated: false,
      agent: s.agent,
      membership: s.membership ?? (cause === "UNRECORDED" || cause === "UNSOURCED_ARGUMENT" ? null : "requires"),
    };
  });
}

function run(steps: StepReport[], opts: { verdict?: "PASS" | "FAIL"; boundary?: number | null; passThrough?: number | null; agent_module?: string } = {}): GateRun {
  const fd = steps.find((s) => s.cause !== null) ?? null;
  return {
    args: { trace: null, run_id: `synthetic--${nextId()}`, storage: "local", prompt: null, model_id: null, strict: false, fail_on_answer: false, mutate: [], agent_module: opts.agent_module ?? "agents.supervisor:get_supervisor" },
    golden: { prompt: "Book a meter reading for ACC-100456 in LS6 2AB", final_answer: "Booked slot SLOT-MR-20260620-0-34f594 for ACC-100456.", final_answer_sha256: "0".repeat(64) },
    candidate_answer: fd ? "Something went differently than the recording -- see the divergence." : "Booked slot SLOT-MR-20260620-0-34f594 for ACC-100456.",
    result: {
      steps,
      first_divergence: fd,
      attribution_boundary: opts.boundary ?? (fd ? fd.step : null),
      pass_through_boundary: opts.passThrough ?? null,
      verdict: opts.verdict ?? (fd ? "FAIL" : "PASS"),
      answer_matched: !fd,
      answer_diff: null,
    },
    counters: { n_model: steps.length + 2, injected: steps.filter((s) => s.gate_status === "recorded").length, unrecorded: steps.filter((s) => s.gate_status === "unrecorded").length, tool_bodies: 0 },
    tokens: { input_tokens: 14032, output_tokens: 2110 },
  };
}

/** Builds the 40-step, 3-level fixture. `divergeAt` lets the same generator produce both the general
 *  mid-run case and the "divergence near the far right edge" edge case without duplicating 40 rows. */
function build40Step(divergeAt: number): GateRun {
  const specs: StepSpec[] = [];
  specs.push({ agent: "supervisor", tool: "classify_intent", args: { query: "Book a meter reading for ACC-100456 in LS6 2AB and check my last three invoices" } });

  // Level 1: supervisor -> scheduling_specialist (pass-through), with its own nested calls.
  const schedulingCallStep = specs.length + 1;
  specs.push({ agent: "supervisor", tool: "scheduling_specialist", args: { query: "Book a meter reading for ACC-100456 in LS6 2AB" }, gate_status: "pass_through" });
  for (let i = 0; i < 6; i++) {
    specs.push({ agent: "scheduling_specialist", tool: "check_availability", args: { appointment_type: "METER_READING", postcode: "LS6 2AB", window: `2026-06-${20 + i}` }, membership: i < 4 ? "requires" : "permits" });
  }
  specs.push({ agent: "scheduling_specialist", tool: "hold_slot", args: { slot_id: `SLOT-MR-20260620-${0}-34f594` } });

  // Level 2: scheduling_specialist -> a nested verification sub-agent (fabricated -- the real adapter
  // never recurses this deep, see module docstring). Exercises 3-level rendering on purpose.
  specs.push({ agent: "scheduling_specialist", tool: "sub_verifier_agent", args: { slot_id: `SLOT-MR-20260620-0-34f594`, account_number: "ACC-100456" }, gate_status: "pass_through" });
  for (let i = 0; i < 4; i++) {
    specs.push({ agent: "sub_verifier_agent", tool: "verify_slot_capacity", args: { slot_id: `SLOT-MR-20260620-0-34f594`, engineer_id: `ENG-${100 + i}` }, membership: i === 3 ? "permits" : "requires" });
  }
  specs.push({ agent: "sub_verifier_agent", tool: "verify_slot_capacity", args: { slot_id: "SLOT-MR-20260620-0-34f594", engineer_id: "ENG-104" }, cause: "FORBIDDEN", membership: "requires" });

  // Back in scheduling_specialist, more calls to pad toward 40 and a MISSING_STEP or two.
  for (let i = 0; i < 5; i++) {
    specs.push({ agent: "scheduling_specialist", tool: "reschedule_conflict_check", args: { window: `2026-06-${21 + i}`, postcode: "LS6 2AB" }, membership: "permits" });
  }
  specs.push({ agent: "scheduling_specialist", tool: "confirm_slot", args: { slot_id: "SLOT-MR-20260620-0-34f594" } });

  // Back at the top level: billing side-quest (a second, independent level-1 lane) plus a divergence.
  const billingCallStep = specs.length + 1;
  specs.push({ agent: "supervisor", tool: "billing_specialist", args: { query: "Also check my last three invoices while you're at it" }, gate_status: "pass_through" });
  for (let i = 0; i < 3; i++) {
    specs.push({ agent: "billing_specialist", tool: "check_balance", args: { account_number: "ACC-100456", invoice_index: i } });
  }
  specs.push({ agent: "billing_specialist", tool: "list_invoices", args: { account_number: "ACC-100456", months: 3 } });

  for (let i = 0; i < 10; i++) {
    specs.push({
      agent: "supervisor",
      tool: "audit_log_write",
      args: { event: `scheduling_step_${i}`, account_number: "ACC-100456" },
      membership: i % 3 === 0 ? "permits" : "requires",
    });
  }
  specs.push({ agent: "supervisor", tool: "notify_customer", args: { channel: "email", account_number: "ACC-100456" }, cause: "MISSING_STEP" });
  specs.push({ agent: "supervisor", tool: "close_ticket", args: { account_number: "ACC-100456" }, cause: "MISSING_STEP" });

  while (specs.length < 40) {
    specs.push({ agent: "supervisor", tool: "heartbeat_check", args: { seq: specs.length }, membership: "permits" });
  }
  const trimmed = specs.slice(0, 40);
  if (divergeAt >= 1 && divergeAt <= trimmed.length) {
    trimmed[divergeAt - 1] = { ...trimmed[divergeAt - 1], cause: "UNSOURCED_ARGUMENT", attribution: "ATTRIBUTABLE", membership: null, gate_status: "unrecorded" };
  }

  const steps = buildSteps(trimmed).map((s, i) => (i + 1 > divergeAt ? { ...s, attribution: "UNATTRIBUTED" as Attribution } : s));
  return run(steps, { boundary: divergeAt, passThrough: Math.min(schedulingCallStep, billingCallStep) });
}

export const synthetic40Step = build40Step(22);
export const synthetic40StepDivergeNearEnd = build40Step(38);

export const synthetic1Step: GateRun = run(
  buildSteps([{ agent: "agent", tool: "lookup_order", args: { order_id: "A-1001" } }]),
  { agent_module: "agent" },
);

export const syntheticLongNames: GateRun = run(
  buildSteps([
    { agent: "supervisor", tool: "classify_intent", args: { query: "I need to reschedule my meter reading appointment because the engineer who was originally assigned called to say the access road to my property is closed for resurfacing until further notice and I was told to call back" } },
    {
      agent: "supervisor",
      tool: "reschedule_meter_reading_appointment_due_to_temporary_site_access_restriction",
      args: {
        original_slot_id: "SLOT-MR-20260620-0-34f594-ORIGINALLY-BOOKED-BEFORE-ROAD-CLOSURE-NOTICE",
        reason: "Access road closed for resurfacing works until further notice, per customer's account of a phone call from the assigned field engineer",
      },
      gate_status: "pass_through",
    },
    {
      agent: "reschedule_meter_reading_appointment_due_to_temporary_site_access_restriction",
      tool: "check_availability",
      args: { appointment_type: "METER_READING", postcode: "LS6 2AB", exclude_reason: "temporary_site_access_restriction_road_resurfacing" },
    },
  ]),
);

export const SYNTHETIC_FIXTURES = {
  "synthetic-40": synthetic40Step,
  "synthetic-40-near-end": synthetic40StepDivergeNearEnd,
  "synthetic-1": synthetic1Step,
  "synthetic-long-names": syntheticLongNames,
} as const;

export type SyntheticFixtureName = keyof typeof SYNTHETIC_FIXTURES;
