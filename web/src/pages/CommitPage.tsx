import { useEffect, useState } from "react";
import type { GateRun } from "../types/gate";
import { fetchCommit, fetchRun, ApiError, type CommitRunSummary } from "../api";
import { RunView } from "../components/RunView";
import { LoadingScreen, ErrorScreen } from "../components/StateScreen";

/**
 * GET /commit/:sha -- the triage view: every scenario's verdict for one commit in a rail, click one to
 * load its fork. This is what the PR comment's "View the fork" link points at (Phase 2.4): a developer
 * lands seeing every scenario at once, not one they have to already know the run_id for.
 */
export function CommitPage({ sha, navigate }: { sha: string; navigate: (path: string) => void }) {
  const [commitState, setCommitState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; runs: CommitRunSummary[] }>({ status: "loading" });
  const [selected, setSelected] = useState<string | null>(null);
  const [runState, setRunState] = useState<{ status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "ready"; run: GateRun }>({ status: "idle" });

  const loadCommit = () => {
    setCommitState({ status: "loading" });
    fetchCommit(sha)
      .then(({ runs }) => {
        setCommitState({ status: "ready", runs });
        if (runs.length > 0) setSelected(runs[0].run_id);
      })
      .catch((e) => setCommitState({ status: "error", message: e instanceof ApiError ? e.message : "Unknown error" }));
  };

  useEffect(loadCommit, [sha]);

  const loadRun = (runId: string) => {
    setRunState({ status: "loading" });
    fetchRun(runId)
      .then((run) => setRunState({ status: "ready", run }))
      .catch((e) => setRunState({ status: "error", message: e instanceof ApiError ? e.message : "Unknown error" }));
  };

  useEffect(() => {
    if (selected) loadRun(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  if (commitState.status === "loading") return <LoadingScreen label={`Loading commit ${sha.slice(0, 7)}…`} />;
  if (commitState.status === "error") return <ErrorScreen title="Could not load this commit" detail={commitState.message} retry={loadCommit} />;

  const { runs } = commitState;
  const passCount = runs.filter((r) => r.verdict === "PASS").length;

  return (
    <div className="triage">
      <nav className="triage-rail" aria-label="Scenarios for this commit">
        <div className="triage-rail-head">
          <div className="triage-eyebrow">Commit</div>
          <div className="triage-sha">{sha.slice(0, 7)}</div>
          <div className="triage-summary">
            {runs.length === 0 ? "No scenario runs recorded for this commit yet." : `${passCount} of ${runs.length} scenario${runs.length === 1 ? "" : "s"} passing`}
          </div>
        </div>
        {runs.map((r) => (
          <button key={r.run_id} type="button" className="triage-item" aria-current={r.run_id === selected} onClick={() => setSelected(r.run_id)}>
            <span className="triage-item-dot" data-v={r.verdict ?? "ERROR"} />
            <span className="triage-item-name">{r.scenario}</span>
            <span className="triage-item-verdict">{r.verdict ?? "ERROR"}</span>
          </button>
        ))}
      </nav>
      <div className="triage-main">
        {runs.length === 0 && <div className="triage-empty">Nothing to show yet -- no scenario has been tested against this commit with --storage aws.</div>}
        {runState.status === "loading" && <LoadingScreen label="Loading fork…" />}
        {runState.status === "error" && <ErrorScreen title="Could not load this run" detail={runState.message} retry={() => selected && loadRun(selected)} />}
        {runState.status === "ready" && selected && (
          <RunView
            key={selected}
            gateRun={runState.run}
            runId={selected}
            scenario={runs.find((r) => r.run_id === selected)?.scenario ?? selected}
            summary={runs.find((r) => r.run_id === selected)}
            backTo={{ sha, label: `commit ${sha.slice(0, 7)}` }}
            navigate={navigate}
            embedded
          />
        )}
      </div>
    </div>
  );
}
