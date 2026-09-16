import type { GateRun } from "./types/gate";

/**
 * The dashboard's read/accept API (agent_replay/lambda_handler.py). Base URL comes from
 * VITE_AGENT_REPLAY_API_URL at build time; falls back to the local dev stand-in
 * (agent_replay/dev_api_server.py, real AWS data, no API Gateway) since the real Lambda+API Gateway
 * deploy is currently blocked -- see docs/DECISIONS.md, Phase 2, and the task report.
 */
const BASE_URL = (import.meta.env.VITE_AGENT_REPLAY_API_URL as string | undefined) || "http://127.0.0.1:8787";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, init);
  } catch {
    throw new ApiError(0, "Could not reach the dashboard API. It may not be running or deployed.");
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* body wasn't JSON -- keep the status text */
    }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

export function fetchRun(runId: string): Promise<GateRun> {
  return request<GateRun>(`/runs/${encodeURIComponent(runId)}`);
}

export interface CommitRunSummary {
  run_id: string;
  scenario: string;
  verdict: "PASS" | "FAIL" | "ERROR" | null;
  agent_module: string;
  branch: string | null;
  pr_number: number | null;
  triggered_by: string | null;
  created_at: string | null;
  accepted_by: string | null;
  accepted_at: string | null;
}

export function fetchCommit(sha: string): Promise<{ commit_sha: string; runs: CommitRunSummary[] }> {
  return request(`/commits/${encodeURIComponent(sha)}`);
}

export interface ScenarioSummary {
  scenario: string;
  verdict: "PASS" | "FAIL" | "ERROR" | null;
  run_id: string;
  created_at: string | null;
  agent_module: string;
  commit_sha: string | null;
}

export function fetchScenarios(): Promise<{ scenarios: ScenarioSummary[] }> {
  return request(`/scenarios`);
}

export function acceptChange(runId: string, acceptedBy: string): Promise<{ run_id: string; accepted_by: string; accepted_at: string }> {
  return request(`/runs/${encodeURIComponent(runId)}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accepted_by: acceptedBy }),
  });
}

/**
 * Phase 2.1 (docs/DECISIONS.md): the fork API is a SEPARATE deployment (agent_replay/lambda_fork_api.py +
 * lambda_fork_worker.py, its own HTTP API) from the read/accept API above -- its own base URL, its own
 * small request() helper below rather than reusing the one above, since a fork's error bodies carry extra
 * fields (known_tools/known_fields) the plain ApiError shape above has no room for and callers need to
 * read those fields specifically to render a useful 400, not just a message string.
 */
const FORK_BASE_URL = (import.meta.env.VITE_AGENT_REPLAY_FORK_API_URL as string | undefined) || "http://127.0.0.1:8788";

export class ForkApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.error === "string" ? body.error : `${status}`);
    this.status = status;
    this.body = body;
  }
}

async function forkRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${FORK_BASE_URL}${path}`, init);
  } catch {
    throw new ForkApiError(0, { error: "Could not reach the fork API. It may not be running or deployed." });
  }
  let body: Record<string, unknown> = {};
  try {
    body = await res.json();
  } catch {
    /* a non-JSON body still leaves body={} -- res.ok below decides whether that's fatal */
  }
  if (!res.ok) throw new ForkApiError(res.status, body);
  return body as T;
}

export interface ForkMutation {
  tool: string;
  field: string;
  value: unknown;
}

export interface StartForkResponse {
  fork_id: string;
  poll_url: string;
}

/** POST /forks (2.1.1). Rejects with ForkApiError on a 400 -- .body.known_tools / .body.known_fields carry
 * exactly what the failed request COULD have named, straight from agent_replay/lambda_fork_api.py. */
export function startFork(scenario: string, mutation: ForkMutation, runId?: string): Promise<StartForkResponse> {
  return forkRequest<StartForkResponse>("/forks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ run_id: runId, scenario, mutations: [mutation] }),
  });
}

export type ForkStatus = "running" | "complete" | "failed";

/** One line of the fork event protocol (docs/DECISIONS.md's Phase 2.1.2) -- field names inside a "step"
 * event are exactly ContractStep's own (see agent_replay/fork.py), reused here verbatim rather than a
 * parallel shape. */
export type ForkEvent =
  | { type: "step"; step: number; agent: string | null; tool: string | null; args: Record<string, unknown> | null; cause: string | null; attribution: string; mutated: boolean; membership: string | null }
  | { type: "answer"; text: string; sha256: string }
  | { type: "done"; verdict: "PASS" | "FAIL"; exit_code: number; counters: { model_calls: number; injected: number; unrecorded: number; tool_bodies: number } }
  | { type: "error"; transient: boolean; message: string };

export interface PollForkResponse {
  fork_id: string;
  status: ForkStatus;
  cursor: number;
  events: ForkEvent[];
}

/** GET /forks/{id}?after=<cursor> (2.1.4's poll semantics). */
export function pollFork(forkId: string, after: number): Promise<PollForkResponse> {
  return forkRequest<PollForkResponse>(`/forks/${encodeURIComponent(forkId)}?after=${after}`);
}

/** GET /forks/preview/{scenario}/{tool} (2.2.1): the recorded output VALUES a mutation editor prefills
 * each row with -- not just the field names a 400 from startFork would carry. */
export function previewToolOutput(scenario: string, tool: string): Promise<{ fields: Record<string, unknown> }> {
  return forkRequest(`/forks/preview/${encodeURIComponent(scenario)}/${encodeURIComponent(tool)}`);
}
