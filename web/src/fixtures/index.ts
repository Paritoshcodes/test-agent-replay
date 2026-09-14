import type { GateRun } from "../types/gate";
import passTextDiffers from "./01-pass-text-differs";
import orderViolationStep1 from "./02-order-violation-step-1";
import unrecordedBoundaryMissing from "./03-unrecorded-boundary-missing";
import unsourcedArgument from "./04-unsourced-argument";

export type Provenance = "VERBATIM" | "CONSTRUCTED" | "RECONSTRUCTED";

export interface Fixture {
  id: string;
  key: string;
  short: string;
  title: string;
  cause: string;
  provenance: Provenance;
  note: string;
  run: GateRun;
}

export const FIXTURES: Fixture[] = [
  {
    id: "01",
    key: "1",
    short: "Pass",
    title: "Unchanged audit, final text differs",
    cause: "PASS",
    provenance: "VERBATIM",
    note: "From a real gate run against audit-golden-1. The candidate answer is completed past gate.py's 200-character cut.",
    run: passTextDiffers,
  },
  {
    id: "02",
    key: "2",
    short: "Order",
    title: "Refund issued before lookup",
    cause: "ORDER_VIOLATION",
    provenance: "CONSTRUCTED",
    note: "Real compare() output on a hand-built reversed trace. Counters, tokens and the candidate answer are illustrative.",
    run: orderViolationStep1,
  },
  {
    id: "03",
    key: "3",
    short: "Unrecorded",
    title: "Loosened auditor prompt",
    cause: "UNRECORDED",
    provenance: "RECONSTRUCTED",
    note: "Labels, step 4, counters and tokens are verbatim from a real run. Truncated args are filled from golden. The candidate answer is illustrative.",
    run: unrecordedBoundaryMissing,
  },
  {
    id: "04",
    key: "4",
    short: "Unsourced",
    title: "Invented package version",
    cause: "UNSOURCED_ARGUMENT",
    provenance: "RECONSTRUCTED",
    note: "Verdict and first divergence are verbatim from a real run. Other rows are derived with gate_compare's rules. Counters, tokens and answer are illustrative.",
    run: unsourcedArgument,
  },
];
