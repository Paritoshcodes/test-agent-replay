import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import type { ForkModel } from "../engine/model";
import { buildContractDiff, buildPatch, type ContractDiffEntry } from "../engine/contractDiff";
import { acceptChange, ApiError } from "../api";
import { EASE } from "./motion";

interface Props {
  model: ForkModel;
  runId: string;
  scenario: string;
}

/**
 * The point of the dashboard, not a bonus feature (Phase 3, docs/DECISIONS.md). A FAIL means the recorded
 * behaviour diverged from the contract; this panel shows exactly what that means as a line-level diff and
 * lets a reviewer accept ONE change at a time -- never all of them at once. There is deliberately no
 * "accept all" anywhere in this file. That omission is the design, not an oversight: bulk-accepting is
 * exactly the blind-baseline-update failure mode snapshot testing is famous for (Chromatic/Percy exist to
 * force review per-change instead of from the CLI) -- see README.md.
 */
export function DiffPanel({ model, runId, scenario }: Props) {
  const reduced = !!useReducedMotion();
  const [open, setOpen] = useState(false);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [name, setName] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  if (model.run.result.verdict !== "FAIL") return null;

  const entries = buildContractDiff(model);
  const acceptable = entries.filter((e) => e.kind !== "info");
  const info = entries.filter((e) => e.kind === "info");
  const acceptedEntries = acceptable.filter((e) => accepted.has(e.id));

  const toggle = (e: ContractDiffEntry) => {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(e.id)) next.delete(e.id);
      else next.add(e.id);
      return next;
    });
    setStatus("idle");
  };

  const download = async () => {
    if (!name.trim() || acceptedEntries.length === 0) return;
    setStatus("saving");
    setErrorMsg("");
    try {
      // Records WHO and WHEN in the run's own metadata (Phase 3.4) -- never the contract itself. The
      // patch text below is the only thing that ever touches contract content, and it's downloaded, not
      // written anywhere by this dashboard -- see README.md "How an accepted change reaches the repo".
      await acceptChange(runId, name.trim());
      const patch = buildPatch(scenario, acceptedEntries, name.trim(), runId);
      const blob = new Blob([patch], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${scenario}.patch.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus("saved");
    } catch (e) {
      setStatus("error");
      setErrorMsg(e instanceof ApiError ? e.message : "Could not reach the dashboard API.");
    }
  };

  return (
    <>
      {!open && (
        <button type="button" className="diff-toggle-btn" onClick={() => setOpen(true)}>
          View contract diff ({acceptable.length + info.length})
        </button>
      )}
      <AnimatePresence>
        {open && (
          <motion.div
            className="diff-overlay"
            initial={reduced ? false : { opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, x: 24, transition: { duration: 0.15 } }}
            transition={{ duration: 0.32, ease: EASE }}
          >
            <div className="diff-head">
              <span className="diff-title">Contract diff</span>
              <button type="button" className="diff-close" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
            <p className="diff-sub">
              What would change in <code>{scenario}.yaml</code> if this run's behaviour were accepted as the new baseline. Accept
              each change on its own -- there is no accept-all.
            </p>

            {acceptable.length > 0 && (
              <>
                <div className="diff-section-label">Requires / permits</div>
                {acceptable.map((e) => (
                  <div key={e.id} className="diff-line" data-kind={e.kind}>
                    <span className="diff-line-marker">{e.kind === "enter" ? "+" : "−"}</span>
                    <span className="diff-line-code">
                      {e.line}
                      <span className="diff-line-note">{e.note}</span>
                    </span>
                    <button type="button" className="diff-accept-btn" data-accepted={accepted.has(e.id)} onClick={() => toggle(e)}>
                      {accepted.has(e.id) ? "Accepted ✓" : "Accept"}
                    </button>
                  </div>
                ))}
              </>
            )}

            {info.length > 0 && (
              <>
                <div className="diff-section-label">Not acceptable here</div>
                {info.map((e) => (
                  <div key={e.id} className="diff-line" data-kind="leave" style={{ opacity: 0.7 }}>
                    <span className="diff-line-marker">·</span>
                    <span className="diff-line-code">
                      {e.line}
                      <span className="diff-line-note">{e.note}</span>
                    </span>
                  </div>
                ))}
              </>
            )}

            <div className="diff-footer">
              {acceptedEntries.length === 0 ? (
                <div className="diff-footer-empty">Accept at least one change to generate a patch.</div>
              ) : (
                <>
                  <div className="diff-name-row">
                    <input
                      className="diff-name-input"
                      placeholder="Your name (recorded as who accepted this)"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </div>
                  <button type="button" className="diff-download-btn" disabled={!name.trim() || status === "saving"} onClick={download}>
                    {status === "saving" ? "Saving…" : `Download patch (${acceptedEntries.length} change${acceptedEntries.length === 1 ? "" : "s"})`}
                  </button>
                  {status === "saved" && (
                    <div className="diff-accepted-note">
                      Recorded {name.trim()} as accepting {acceptedEntries.length} change{acceptedEntries.length === 1 ? "" : "s"} on this run. Apply
                      the downloaded patch to <code>agent-replay/contracts/{scenario}.yaml</code> by hand and commit it -- this dashboard never
                      writes to git directly.
                    </div>
                  )}
                  {status === "error" && <div className="diff-accepted-note" style={{ color: "var(--red)" }}>{errorMsg}</div>}
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
