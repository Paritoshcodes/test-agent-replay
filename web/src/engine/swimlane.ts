import type { Call, GateRun, StepReport, ToolCall } from "../types/gate";
import { isTool } from "./model";

/**
 * Reconstructs one lane per agent from a flat, agent-tagged step list (agent_replay/evaluate.py's
 * ContractStep.agent, Phase 1 -- see docs/DECISIONS.md). No backend change beyond adding that one field
 * was needed: nesting itself is inferred here, from two facts every step already carries:
 *
 *   - a "pass-through" step (gate_status === "pass_through") is a call to a tool that is itself a live
 *     sub-agent (agent_replay/adapter.py's find_nested_agents) -- its OWN tool name is that sub-agent's
 *     name.
 *   - every step the sub-agent makes while running is tagged with THAT name as its `agent`.
 *
 * So: the parent of a step whose agent is some specialist name S is the closest EARLIER (by step number)
 * pass-through step whose own tool name is S. This works at any nesting depth the same way -- a
 * level-2 specialist's own pass-through call is just another step whose tool name a level-3 step's agent
 * will match -- even though the real sample agent this project targets only ever nests one level deep
 * (agents/supervisor.py: supervisor -> specialists, specialists do not call further nested agents). The
 * synthetic 40-step fixture (fixtures/synthetic.ts) exercises the deeper case this algorithm already
 * supports but real data has never produced.
 */

export interface LaneNode {
  id: string;
  k: number;
  step: StepReport;
  laneId: string;
  /** A cause is present -- this row is what gate/test would call a divergence. */
  flagged: boolean;
  /** MISSING_STEP: a `requires` call the candidate never made. Rendered dashed/hollow, no real call to show. */
  ghost: boolean;
  /** requires/permits membership, straight off the step -- see types/gate.ts's Membership. */
  membership: StepReport["membership"];
}

export interface OriginNode {
  kind: "origin";
  k: 0;
}

export interface AnswerNode {
  kind: "answer";
  k: number;
}

export interface Lane {
  id: string;
  depth: number;
  parentLaneId: string | null;
  /** The node, in the PARENT lane, whose call spawned this lane -- the tether point. Null for the root lane. */
  spawnedByNodeId: string | null;
  nodes: LaneNode[];
  collapsed: boolean;
  /** requires/permits counts for this lane's own nodes (Phase 1 revision, docs/DECISIONS.md) -- the
   *  header's "N required · M permitted" summary line replaces a per-node badge on every permitted call,
   *  which read as noise once most calls in a lane are permitted (schedule-meter-reading's real shape). */
  requiredCount: number;
  permittedCount: number;
  /** 0 = sparsest lane (fewest nodes), rising with node count -- set once, over the whole lane set, after
   *  every lane is known. Used to decide which lanes' labels appear first as zoom increases ("densest
   *  lanes last"); render-only, never affects matching or layout order. */
  densityRank: number;
  /** Phase 2.2 (docs/DECISIONS.md): a live fork branch (SwimlaneEngine.beginFork/addForkStep), appended
   *  after the model is built rather than present in buildSwimlaneModel's own output -- never true for any
   *  lane a real GateRun produces. Render-only (swimlaneRender.ts's dashed lane track/band): matching still
   *  never looks at this, same as every other display-only field on Lane. */
  isFork?: boolean;
}

export interface SwimlaneModel {
  run: GateRun;
  lanes: Lane[]; // DFS order: a lane always appears immediately after its parent
  laneById: Map<string, Lane>;
  nodeById: Map<string, LaneNode>;
  n: number;
  kEnd: number;
  origin: OriginNode;
  /** Per-lane answer node -- only the root lane's answer is the run's actual final text; a specialist
   *  lane's "answer" position is just where its own last step ended, used to draw its track out to the
   *  same shared right edge as everything else. Only the root one renders as a real answer marker. */
  answerK: number;
  rootLaneId: string;
  divergenceK: number | null;
  boundaryK: number | null;
  passThroughK: number | null;
}

function laneKeyOf(s: StepReport): string {
  return s.agent ?? "agent";
}

/** The tool name a step represents -- from `candidate` normally, falling back to `golden` for a
 *  MISSING_STEP row (candidate is null there; see agent_replay/dashboard.py's _step_report mapping). */
function toolNameOf(s: StepReport): string | null {
  const call = s.candidate ?? s.golden;
  return isTool(call) ? call.tool : null;
}

export function buildSwimlaneModel(run: GateRun, collapsedByDefault: Set<string> = new Set()): SwimlaneModel {
  const steps = [...run.result.steps].sort((a, b) => a.step - b.step);
  const n = steps.length;
  const kEnd = n + 1;

  // laneId -> the most recent (by step number, so far) pass-through step whose OWN tool name equals that
  // laneId -- i.e. "which call, if any that we've seen so far, would open a lane with this name".
  const openers = new Map<string, { step: StepReport; nodeId: string }>();

  const lanes: Lane[] = [];
  const laneById = new Map<string, Lane>();
  const nodeById = new Map<string, LaneNode>();
  let rootLaneId: string | null = null;

  const ensureLane = (id: string): Lane => {
    const existing = laneById.get(id);
    if (existing) return existing;
    const opener = openers.get(id);
    const lane: Lane = {
      id,
      depth: opener ? (laneById.get(opener.step.agent ?? "agent")?.depth ?? 0) + 1 : 0,
      parentLaneId: opener ? (opener.step.agent ?? "agent") : null,
      spawnedByNodeId: opener ? opener.nodeId : null,
      nodes: [],
      collapsed: collapsedByDefault.has(id),
      requiredCount: 0,
      permittedCount: 0,
      densityRank: 0,
    };
    if (!opener && rootLaneId === null) rootLaneId = id;
    laneById.set(id, lane);
    // DFS-ish insertion: place right after the parent lane's own last-known position, so a lane always
    // renders directly under its parent (and under any of the parent's earlier-declared children),
    // matching the visual "tethered" nesting the spec asks for -- not just appended at the end.
    if (lane.parentLaneId) {
      const parentIdx = lanes.findIndex((l) => l.id === lane.parentLaneId);
      let insertAt = parentIdx + 1;
      while (insertAt < lanes.length && isDescendant(lanes[insertAt], lane.parentLaneId, laneById)) insertAt++;
      lanes.splice(insertAt, 0, lane);
    } else {
      lanes.push(lane);
    }
    return lane;
  };

  const isDescendant = (candidate: Lane, ancestorId: string, byId: Map<string, Lane>): boolean => {
    let cur: Lane | undefined = candidate;
    while (cur?.parentLaneId) {
      if (cur.parentLaneId === ancestorId) return true;
      cur = byId.get(cur.parentLaneId);
    }
    return false;
  };

  for (const s of steps) {
    const laneId = laneKeyOf(s);
    const lane = ensureLane(laneId);
    const id = `s${s.step}`;
    const node: LaneNode = {
      id,
      k: s.step,
      step: s,
      laneId,
      flagged: s.cause !== null,
      ghost: s.cause === "MISSING_STEP",
      membership: s.membership ?? null,
    };
    lane.nodes.push(node);
    nodeById.set(id, node);
    const toolName = toolNameOf(s);
    if (s.gate_status === "pass_through" && toolName) openers.set(toolName, { step: s, nodeId: id });
  }

  // A run with zero tool calls (never observed for real, but not impossible) still needs a root lane for
  // the origin/answer markers to live on.
  if (rootLaneId === null) {
    rootLaneId = "agent";
    ensureLane(rootLaneId);
  }

  for (const lane of lanes) {
    for (const node of lane.nodes) {
      if (node.membership === "requires") lane.requiredCount += 1;
      else if (node.membership === "permits") lane.permittedCount += 1;
    }
  }
  // Sparsest lane first (rank 0) -- ties broken by declaration order, which is already DFS/parent-first,
  // so a tie between a parent and its own child keeps the parent revealing no later than its child.
  [...lanes]
    .sort((a, b) => a.nodes.length - b.nodes.length)
    .forEach((lane, i) => {
      lane.densityRank = i;
    });

  const fd = run.result.first_divergence;
  return {
    run,
    lanes,
    laneById,
    nodeById,
    n,
    kEnd,
    origin: { kind: "origin", k: 0 },
    answerK: kEnd,
    rootLaneId,
    divergenceK: fd ? fd.step : null,
    boundaryK: run.result.attribution_boundary,
    passThroughK: run.result.pass_through_boundary ?? null,
  };
}

export const isToolCall = isTool;

export function callOf(node: LaneNode): Call | null {
  return node.step.candidate ?? node.step.golden;
}

function joinArgs(call: ToolCall): string {
  return Object.values(call.args)
    .map((v) => {
      const s = String(v);
      return s.startsWith("file:///") ? s.split("/").slice(-1)[0] : s;
    })
    .join(" ");
}

/** Short, single-line summary for compact, fleeting UI (the transport bar's timecode description) where
 *  truncating is fine BECAUSE the full value is always one hover/click away, never the only place it's
 *  shown. Never used for an on-canvas node label -- see fullArgSummary for that. */
export function shortArgSummary(call: Call | null, max = 42): string {
  if (!isTool(call)) return "";
  const text = joinArgs(call);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The on-canvas node label's argument text -- values only, in declared order, NEVER truncated (Phase 1,
 *  docs/DECISIONS.md: "nothing truncates to an ellipsis where the full value matters"). CSS wraps this
 *  within a bounded column instead (.sw-lbl-arg) -- long, not cut. */
export function fullArgSummary(call: Call | null): string {
  return isTool(call) ? joinArgs(call) : "";
}
