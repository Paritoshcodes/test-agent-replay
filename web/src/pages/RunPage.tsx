import { useEffect, useState } from "react";
import type { GateRun } from "../types/gate";
import { fetchRun, ApiError } from "../api";
import { RunView } from "../components/RunView";
import { LoadingScreen, ErrorScreen } from "../components/StateScreen";

/** GET /run/:runId -- a single run's fork, loaded directly, with no triage rail (reached from a direct
 * link, e.g. the PR comment's "View the fork" pointed here before Phase 2.4 changed it to /commit/:sha,
 * or bookmarked/shared directly). */
export function RunPage({ runId, navigate }: { runId: string; navigate: (path: string) => void }) {
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; run: GateRun }>({ status: "loading" });

  const load = () => {
    setState({ status: "loading" });
    fetchRun(runId)
      .then((run) => setState({ status: "ready", run }))
      .catch((e) => setState({ status: "error", message: e instanceof ApiError ? e.message : "Unknown error" }));
  };

  useEffect(load, [runId]);

  if (state.status === "loading") return <LoadingScreen label={`Loading ${runId}…`} />;
  if (state.status === "error") return <ErrorScreen title="Could not load this run" detail={state.message} retry={load} />;

  // GateRun (reused unchanged, see docs/DECISIONS.md Phase 2) has no scenario field of its own -- the
  // run_id itself encodes it (agent_replay/cli.py: `{scenario}--candidate--{run_uid}`), so derive it from
  // there rather than inventing a field on the response shape.
  const scenario = runId.split("--candidate--")[0] || runId;
  return <RunView gateRun={state.run} runId={runId} scenario={scenario} navigate={navigate} />;
}
