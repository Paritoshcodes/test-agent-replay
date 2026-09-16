import { useEffect, useMemo, useState } from "react";
import type { SwimlaneEngine, SwimlaneUIState } from "../engine/SwimlaneEngine";
import type { ForkModel } from "../engine/model";
import { wordDiff } from "../engine/diff";
import { runFork, type ForkRunHandle } from "../engine/forkRun";
import { downloadForkScenarioFile } from "../engine/forkScenario";
import { previewToolOutput, type ForkMutation } from "../api";

/**
 * Phase 2.2 + 2.3 (docs/DECISIONS.md): the mutation editor, live progress, answer diff, and "Save as
 * scenario" flow -- everything downstream of RunInspector's "Fork from here" button. Owns the poll loop
 * (engine/forkRun.ts) itself and feeds each event straight into the SAME SwimlaneEngine methods that draw
 * the fork's own lane group, so this component's only real job is the FORM/PANEL chrome around that.
 */

export interface PendingFork {
  originNodeId: string;
  tool: string;
}

interface Props {
  engine: SwimlaneEngine;
  ui: SwimlaneUIState;
  model: ForkModel;
  scenario: string;
  runId: string;
  pending: PendingFork | null;
  onDismissPending: () => void;
}

export function ForkPanel({ engine, ui, model, scenario, runId, pending, onDismissPending }: Props) {
  const fork = ui.fork;
  const [fields, setFields] = useState<Record<string, unknown> | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [editedField, setEditedField] = useState<string | null>(null);
  const [editedValue, setEditedValue] = useState<string>("");
  const [handle, setHandle] = useState<ForkRunHandle | null>(null);
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [savedName, setSavedName] = useState("");

  useEffect(() => {
    if (!pending) {
      setFields(null);
      setEditedField(null);
      setPreviewError(null);
      return;
    }
    let cancelled = false;
    setFields(null);
    setEditedField(null);
    setPreviewError(null);
    previewToolOutput(scenario, pending.tool)
      .then((res) => {
        if (!cancelled) setFields(res.fields);
      })
      .catch((e: { message?: string }) => {
        if (!cancelled) setPreviewError(e.message ?? "could not load recorded output");
      });
    return () => {
      cancelled = true;
    };
  }, [pending, scenario]);

  // The poll loop (engine/forkRun.ts) keeps running until it reaches a terminal status on its own; this
  // only guards against the component unmounting (navigating away) mid-fork, so a dead component never
  // keeps polling in the background.
  useEffect(() => () => handle?.cancel(), [handle]);

  if (!pending && !fork) return null;

  const dismiss = () => {
    handle?.cancel();
    setHandle(null);
    setShowSaveForm(false);
    setSavedName("");
    engine.resetFork();
    onDismissPending();
  };

  if (pending && !fork) {
    const startFork = () => {
      if (!fields || editedField === null) return;
      const original = fields[editedField];
      let value: unknown = editedValue;
      if (typeof original === "number") {
        const n = Number(editedValue);
        if (!Number.isNaN(n)) value = n;
      } else if (typeof original === "boolean") {
        value = editedValue.trim().toLowerCase() === "true";
      }
      const mutation: ForkMutation = { tool: pending.tool, field: editedField, value };
      engine.setForkValidating(pending.originNodeId, mutation);
      const h = runFork(scenario, mutation, runId, {
        onStarted: () => {
          engine.beginFork(pending.originNodeId, mutation);
        },
        onEvent: (e) => {
          if (e.type === "step") engine.addForkStep(e);
          else if (e.type === "answer") engine.setForkAnswer(e.text);
          else if (e.type === "done") engine.finishFork(e.verdict);
          else if (e.type === "error") engine.failFork(e.message, e.transient);
        },
        onStatus: (status) => {
          if (status === "orphaned") {
            engine.failFork("No response from the fork within the expected time -- it likely crashed or timed out without ever reporting a result.", false);
          }
        },
        onRequestError: (message) => engine.failFork(message, false),
      });
      setHandle(h);
    };

    return (
      <div className="fork-panel" role="dialog" aria-label="Fork from here">
        <div className="fork-panel-head">
          <span>
            Fork from here · <span className="mono">{pending.tool}</span>
          </span>
          <button type="button" className="fork-panel-close" aria-label="Cancel" onClick={dismiss}>
            ×
          </button>
        </div>
        {previewError && <p className="fork-panel-error">{previewError}</p>}
        {!fields && !previewError && <p className="fork-panel-hint">Loading recorded output…</p>}
        {fields && Object.keys(fields).length === 0 && <p className="fork-panel-hint">This tool's recorded output has no fields to edit.</p>}
        {fields && Object.keys(fields).length > 0 && (
          <>
            <p className="fork-panel-hint">
              Edit ONE field below, then run. Only one field may be mutated at a time in v1 -- editing a different field discards the previous edit.
            </p>
            <div className="fork-fields">
              {Object.entries(fields).map(([k, v]) => (
                <label key={k} className="fork-field-row">
                  <span className="fork-field-name">{k}</span>
                  <input
                    className="fork-field-input"
                    defaultValue={String(v)}
                    data-edited={editedField === k || undefined}
                    onFocus={(ev) => {
                      setEditedField(k);
                      setEditedValue(ev.currentTarget.value);
                    }}
                    onChange={(ev) => {
                      setEditedField(k);
                      setEditedValue(ev.currentTarget.value);
                    }}
                  />
                </label>
              ))}
            </div>
            {editedField && (
              <p className="fork-panel-note">
                Only <b>{editedField}</b> will be forked; every other field runs with its recorded value.
              </p>
            )}
            <button type="button" className="fork-run-btn" disabled={editedField === null} onClick={startFork}>
              Run fork
            </button>
          </>
        )}
      </div>
    );
  }

  if (!fork) return null;

  return (
    <div className="fork-panel" role="status">
      <div className="fork-panel-head">
        <span>
          Fork · <span className="mono">{fork.mutation ? `${fork.mutation.tool}.${fork.mutation.field}` : ""}</span>
        </span>
        <button type="button" className="fork-panel-close" aria-label="Close" onClick={dismiss}>
          ×
        </button>
      </div>

      {fork.status === "validating" && <p className="fork-panel-hint">Validating…</p>}
      {fork.status === "running" && (
        <p className="fork-panel-hint">
          Running (<b>{fork.stepsReceived}</b> of ? steps)…
        </p>
      )}
      {fork.status === "failed" && fork.error && (
        <div className="fork-panel-fail" data-transient={fork.error.transient || undefined}>
          <span className="fork-panel-fail-tag">{fork.error.transient ? "TRANSIENT" : "ERROR"}</span>
          <p>{fork.error.message}</p>
          {fork.error.transient && (
            <p className="fork-panel-hint">A live-model hiccup, not necessarily a real regression -- the partial branch on the timeline shows exactly where it stopped.</p>
          )}
        </div>
      )}
      {fork.status === "complete" && fork.answer && <ForkAnswerDiff original={model.run.candidate_answer} forked={fork.answer} verdict={fork.verdict} />}
      {fork.status === "complete" && !showSaveForm && (
        <button type="button" className="fork-save-btn" onClick={() => setShowSaveForm(true)}>
          Save as scenario
        </button>
      )}
      {showSaveForm && fork.mutation && (
        <div className="fork-save-form">
          <label className="fork-save-label">
            Scenario name
            <input className="fork-field-input" value={savedName} onChange={(e) => setSavedName(e.target.value)} placeholder={`${scenario}-fork`} />
          </label>
          <p className="fork-panel-hint">
            Downloads a file to paste into <span className="mono">scenarios.yaml</span>. A fork is a single live run, not a golden recording -- it needs{" "}
            <span className="mono">agent-replay record</span> before it can be tested.
          </p>
          <button type="button" className="fork-run-btn" onClick={() => downloadForkScenarioFile(savedName.trim() || `${scenario}-fork`, model, fork.mutation!)}>
            Download
          </button>
        </div>
      )}
    </div>
  );
}

function ForkAnswerDiff({ original, forked, verdict }: { original: string; forked: string; verdict: "PASS" | "FAIL" | null }) {
  const parts = useMemo(() => wordDiff(original.trim(), forked.trim()), [original, forked]);
  return (
    <div className="fork-answer-diff">
      <div className="diff-head">
        <span className="chip" data-tone={verdict === "FAIL" ? "red" : "green"}>
          {verdict ?? "?"}
        </span>
        <span className="dim">original vs forked final answer</span>
      </div>
      <div className="diff">
        {parts.map((p, i) => (
          <span key={i} className={`d-${p.kind}`}>
            {p.text}
          </span>
        ))}
      </div>
    </div>
  );
}
