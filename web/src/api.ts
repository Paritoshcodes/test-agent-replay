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
