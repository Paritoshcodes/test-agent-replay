import { lerp } from "./math";

/**
 * The node-label visibility policy (BUG 2 fix, docs/DECISIONS.md) -- pulled into its own pure, DOM-free
 * module so it has exactly ONE implementation, shared by SwimlaneEngine.ts (which calls it every frame)
 * and scripts/verify-labels.ts (which calls the SAME function to measure real overlap counts against the
 * real fixtures, headless, instead of a hand-duplicated copy of the formula that could silently drift from
 * what actually renders).
 */

export type LabelMode = "full" | "tool" | "hidden";

export interface LabelPolicyInput {
  /** Pixels available per integer step at the current viewport (SwimlaneEngine.pxPerStep()). */
  density: number;
  /** This node's lane's densityRank (0 = sparsest lane). */
  laneDensityRank: number;
  /** Total number of lanes in the model. */
  numLanes: number;
  /** True for the playhead's current node, the divergence node, or the hovered node -- always "full". */
  isException: boolean;
}

export interface LabelPolicyResult {
  labelMode: LabelMode;
  /** Whether the requires/permits pill renders on this node's label (VISUAL 2: far stricter than the
   *  label itself -- only the three exceptions, or the highest zoom tier). */
  badge: boolean;
}

/** A lane's own (tool-only, full-detail) reveal thresholds, in px/step -- sparsest lane (rank 0) reveals
 *  first, densest lane (rank numLanes-1) reveals last ("densest lanes last", per the task). Exported
 *  separately so a caller can reason about WHERE a given lane sits without recomputing labelPolicyFor. */
export function laneLabelThresholds(laneDensityRank: number, numLanes: number): { toolThreshold: number; fullThreshold: number } {
  const t = numLanes > 1 ? laneDensityRank / (numLanes - 1) : 0;
  const toolThreshold = lerp(55, 320, t);
  return { toolThreshold, fullThreshold: toolThreshold + 100 };
}

export function labelPolicyFor(input: LabelPolicyInput): LabelPolicyResult {
  const { density, laneDensityRank, numLanes, isException } = input;
  const { toolThreshold, fullThreshold } = laneLabelThresholds(laneDensityRank, numLanes);
  const labelMode: LabelMode = isException || density >= fullThreshold ? "full" : density >= toolThreshold ? "tool" : "hidden";
  const badge = isException || density >= 420;
  return { labelMode, badge };
}
