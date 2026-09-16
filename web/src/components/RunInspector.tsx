import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import type { UIState } from "../engine/Engine";
import type { ForkModel } from "../engine/model";
import type { CommitRunSummary } from "../api";
import { AnswerTab, Block, StepView } from "./Inspector";
import { EASE, Hairline, Odometer, pad, rise } from "./motion";

interface Props {
  model: ForkModel;
  ui: UIState;
  runId: string;
  summary?: CommitRunSummary;
  /** Phase 1 (docs/DECISIONS.md): collapsible panels. Both default true/false as if this prop never
   *  existed, for any other caller. `open=false` slides this panel out of view (its own CSS handles the
   *  transform/opacity); `narrow=true` switches it from reserving layout width to an overlay drawer. */
  open?: boolean;
  narrow?: boolean;
  onClose?: () => void;
  /** Phase 2.2 (docs/DECISIONS.md): "Fork from here" -- threaded straight through to StepView, which
   *  renders the button only on a step with an actual recorded tool result. */
  onForkFromHere?: (step: number, tool: string, args: Record<string, unknown>) => void;
}

type Tab = "answer" | "run";
const TABS: { id: Tab; label: string }[] = [
  { id: "answer", label: "Answer diff" },
  { id: "run", label: "Run" },
];

/** Same shell as Inspector.tsx (.inspector, tabs, step view) for a single REAL run instead of a static
 * fixture -- "Change"/"Source" (fixture-provenance concepts) are replaced by a "Run" tab showing what
 * this dashboard actually knows about the run: who triggered it, when, and its acceptance state. */
export function RunInspector({ model, ui, runId, summary, open = true, narrow = false, onClose, onForkFromHere }: Props) {
  const reduced = !!useReducedMotion();
  const [tab, setTab] = useState<Tab>("answer");
  const k = Math.max(0, ui.step);

  return (
    <aside className="inspector" aria-label="Inspector" data-open={open} data-narrow={narrow} aria-hidden={!open}>
      <Hairline axis="y" className="inspector-rule" delay={0.2} />

      <motion.div className="ins-head" {...rise(reduced, 0.5, 6)}>
        <span className="ins-label">Inspector</span>
        <span className="ins-step">
          {k >= model.kEnd ? "answer" : (
            <>
              step <Odometer value={pad(k)} className="ins-odo" /> <span className="dim">/ {pad(model.n)}</span>
            </>
          )}
        </span>
        {onClose && (
          <button type="button" className="inspector-close" aria-label="Close inspector" onClick={onClose}>
            ×
          </button>
        )}
      </motion.div>

      <motion.div className="ins-body" {...rise(reduced, 0.6, 10)}>
        <motion.div key={k} initial={reduced ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, ease: EASE }}>
          <StepView model={model} provenance="live" k={k} onForkFromHere={onForkFromHere} />
        </motion.div>
      </motion.div>

      <motion.div className="tabs" role="tablist" {...rise(reduced, 0.7, 6)}>
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
            {tab === t.id && <motion.i layoutId="tab-underline" className="tab-underline" transition={{ type: "spring", stiffness: 520, damping: 40 }} />}
          </button>
        ))}
      </motion.div>

      <motion.div className="tab-body" role="tabpanel" {...rise(reduced, 0.78, 8)}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            initial={reduced ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -4, transition: { duration: 0.12 } }}
            transition={{ duration: 0.3, ease: EASE }}
          >
            {tab === "answer" && <AnswerTab model={model} />}
            {tab === "run" && <RunTab runId={runId} summary={summary} model={model} />}
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </aside>
  );
}

function RunTab({ runId, summary, model }: { runId: string; summary?: CommitRunSummary; model: ForkModel }) {
  return (
    <>
      <div className="tab-title">
        <span className="prov">LIVE</span> dashboard run
      </div>
      <p className="prose" style={{ marginTop: 8 }}>
        Read from agent_replay's dashboard API -- the exact comparison result `agent-replay test`/`gate` computed when this run
        actually happened, persisted to S3 at that time. Nothing here is recomputed or re-run.
      </p>
      <Block tone="c" label="Prompt">
        <pre className="code prose-code clamp">{model.run.args.prompt ?? model.run.golden.prompt}</pre>
      </Block>
      <dl className="kv">
        <dt>run id</dt>
        <dd className="mono">{runId}</dd>
        <dt>storage</dt>
        <dd className="mono">{model.run.args.storage}</dd>
        <dt>agent module</dt>
        <dd className="mono">{model.run.args.agent_module}</dd>
        {summary && (
          <>
            <dt>branch</dt>
            <dd className="mono">{summary.branch ?? "—"}</dd>
            <dt>pr</dt>
            <dd className="mono">{summary.pr_number ? `#${summary.pr_number}` : "—"}</dd>
            <dt>triggered by</dt>
            <dd className="mono">{summary.triggered_by ?? "local"}</dd>
            <dt>accepted by</dt>
            <dd className="mono">{summary.accepted_by ?? "not accepted"}</dd>
          </>
        )}
      </dl>
    </>
  );
}
