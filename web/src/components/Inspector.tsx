import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useMemo, useState, type ReactNode } from "react";
import type { UIState } from "../engine/Engine";
import { CAUSE_TEXT, GATE_TEXT, isTool, syntheticError, type ForkModel } from "../engine/model";
import { wordDiff } from "../engine/diff";
import type { Fixture } from "../fixtures";
import type { ToolCall } from "../types/gate";
import { CallCode } from "./code";
import { EASE, Hairline, Odometer, pad, rise } from "./motion";

function ForkFromHereButton({ step, call, onForkFromHere }: { step: number; call: ToolCall; onForkFromHere: (step: number, tool: string, args: Record<string, unknown>) => void }) {
  return (
    <button type="button" className="fork-from-here-btn" onClick={() => onForkFromHere(step, call.tool, call.args)}>
      Fork from here
    </button>
  );
}

interface Props {
  model: ForkModel;
  fixture: Fixture;
  ui: UIState;
}

type Tab = "answer" | "change" | "source";
const TABS: { id: Tab; label: string }[] = [
  { id: "answer", label: "Answer diff" },
  { id: "change", label: "Change" },
  { id: "source", label: "Source" },
];

export function Inspector({ model, fixture, ui }: Props) {
  const reduced = !!useReducedMotion();
  const [tab, setTab] = useState<Tab>("answer");
  const k = Math.max(0, ui.step);

  return (
    <aside className="inspector" aria-label="Inspector">
      <Hairline axis="y" className="inspector-rule" delay={0.2} />

      <motion.div className="ins-head" {...rise(reduced, 0.5, 6)}>
        <span className="ins-label">Inspector</span>
        <span className="ins-step">
          {k >= model.kEnd ? (
            "answer"
          ) : (
            <>
              step <Odometer value={pad(k)} className="ins-odo" /> <span className="dim">/ {pad(model.n)}</span>
            </>
          )}
        </span>
      </motion.div>

      <motion.div className="ins-body" {...rise(reduced, 0.6, 10)}>
        <motion.div key={`${ui.modelIndex}-${k}`} initial={reduced ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, ease: EASE }}>
          <StepView model={model} provenance={fixture.provenance} k={k} />
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
            key={`${tab}-${ui.modelIndex}`}
            initial={reduced ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -4, transition: { duration: 0.12 } }}
            transition={{ duration: 0.3, ease: EASE }}
          >
            {tab === "answer" && <AnswerTab model={model} />}
            {tab === "change" && <ChangeTab fixture={fixture} />}
            {tab === "source" && <SourceTab fixture={fixture} />}
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </aside>
  );
}

export function Block({ tone, label, children }: { tone: "g" | "c" | "r"; label: string; children: ReactNode }) {
  return (
    <div className="block">
      <div className="block-head">
        <i className="swatch" data-tone={tone} />
        {label}
      </div>
      {children}
    </div>
  );
}

export function StepView({
  model,
  provenance,
  k,
  onForkFromHere,
}: {
  model: ForkModel;
  provenance: string;
  k: number;
  /** Phase 2.2 (docs/DECISIONS.md): omitted by every caller except RunInspector.tsx -- the old fixture
   *  demo (Inspector.tsx's own default export, above) never passes this, so it renders nothing new at all. */
  onForkFromHere?: (step: number, tool: string, args: Record<string, unknown>) => void;
}) {
  const run = model.run;
  if (k === 0) {
    const a = run.args;
    return (
      <>
        <div className="ins-title">Origin</div>
        <div className="chips">
          <span className="chip" data-tone={a.prompt ? "blue" : undefined}>
            {a.prompt ? "prompt override" : "nothing changed"}
          </span>
          <span className="chip">{provenance.toLowerCase()}</span>
        </div>
        <Block tone="c" label="Candidate prompt">
          <pre className="code prose-code clamp">{a.prompt ?? run.golden.prompt}</pre>
        </Block>
        <p className="prose">Tool results will be served from the golden recording. The model itself runs live, so its choices can drift.</p>
      </>
    );
  }
  if (k >= model.kEnd) {
    return (
      <>
        <div className="ins-title">Final answer</div>
        <div className="chips">
          <span className="chip" data-tone={run.result.answer_matched ? "green" : "amber"}>
            {run.result.answer_matched ? "text matched" : "text differs"}
          </span>
          <span className="chip">informational</span>
        </div>
        <div className="verdicts">
          <div className="verdict-row">
            <span className="block-head">
              <i className="swatch" data-tone="g" />
              Golden
            </span>
            <b>{model.goldenVerdict}</b>
          </div>
          <div className="verdict-row">
            <span className="block-head">
              <i className="swatch" data-tone="c" />
              Candidate
            </span>
            <b>{model.candidateVerdict}</b>
          </div>
        </div>
        <p className="prose">The verdict is decided by the trajectory. Answer text counts only when --fail-on-answer is set.</p>
      </>
    );
  }

  // Phase 2.2 bug find (docs/DECISIONS.md): this used to be a bare `run.result.steps[k - 1]` -- correct
  // ONLY when step numbers are gapless and already in array order, true for the old two-lane engine's own
  // model.ts (buildModel's own docstring: k IS array position, by construction) but NOT true once the
  // swimlane engine's REAL step numbers (SwimlaneEngine's playhead, threaded into `ui.step` by RunView.tsx
  // for a real run) can arrive out of numeric order -- a pass-through call's OWN event finishes appending
  // to candidate_trace AFTER its nested child's (agent_replay/evaluate.py's own documented ordering), so
  // e.g. billing-balance's real array order is [step 1, step 3, step 2]. Playhead k=3 (check_balance) was
  // silently showing steps[2] (billing_specialist, step 2) instead -- found while wiring "Fork from here"
  // to the currently-inspected step, which made the wrong tool name/args show up for forking. Matching by
  // the row's OWN `.step` field is correct in both cases (array-order-equals-step-number, and not).
  const row = run.result.steps.find((s) => s.step === k) ?? run.result.steps[k - 1];
  const call = row.candidate ?? row.golden;
  return (
    <>
      <div className="ins-title">{isTool(call) ? call.tool : ""}</div>
      <div className="chips">
        <span className="chip" data-tone={row.cause ? "red" : "green"}>
          {row.cause ?? "MATCH"}
        </span>
        <span className="chip" data-tone={row.attribution === "UNATTRIBUTED" ? "hatch" : undefined}>
          {row.attribution.toLowerCase()}
        </span>
        <span className="chip">{row.gate_status}</span>
      </div>
      <Block tone="g" label="Golden · recorded call">
        {row.golden ? <CallCode call={row.golden} other={row.candidate} /> : <div className="code empty">No recorded counterpart</div>}
      </Block>
      <Block tone="c" label="Candidate · replayed call">
        {row.candidate ? <CallCode call={row.candidate} other={row.golden} /> : <div className="code empty">Never called</div>}
      </Block>
      {row.gate_status === "unrecorded" && isTool(row.candidate) && (
        <Block tone="r" label="Injected result">
          <pre className="code c-err">{syntheticError(row.candidate)}</pre>
        </Block>
      )}
      {/* Phase 2.2 (docs/DECISIONS.md): "Fork from here" -- only on a step with an actual RECORDED tool
          result (gate_status "recorded"), since forking mutates that recording's own injected output; a
          MISSING_STEP or unrecorded/synthetic-error row has no real recorded result to mutate at all. */}
      {onForkFromHere && row.gate_status === "recorded" && isTool(row.candidate) && (
        <ForkFromHereButton step={row.step} call={row.candidate} onForkFromHere={onForkFromHere} />
      )}
      <p className="prose">{row.cause ? CAUSE_TEXT[row.cause] : GATE_TEXT[row.gate_status]}</p>
    </>
  );
}

export function AnswerTab({ model }: { model: ForkModel }) {
  const run = model.run;
  const parts = useMemo(() => wordDiff(run.golden.final_answer.trim(), run.candidate_answer.trim()), [run]);
  const del = parts.filter((p) => p.kind === "del").reduce((s, p) => s + p.text.trim().split(/\s+/).length, 0);
  const add = parts.filter((p) => p.kind === "add").reduce((s, p) => s + p.text.trim().split(/\s+/).length, 0);
  return (
    <>
      <div className="diff-head">
        <span>
          <b className="d-count-del">−{del}</b> golden only
        </span>
        <span>
          <b className="d-count-add">+{add}</b> candidate only
        </span>
        <span className="dim">words</span>
      </div>
      <div className="diff">
        {parts.map((p, i) => (
          <span key={i} className={`d-${p.kind}`}>
            {p.text}
          </span>
        ))}
      </div>
      <dl className="kv">
        <dt>golden sha256</dt>
        <dd className="mono">{run.golden.final_answer_sha256.slice(0, 16)}...</dd>
      </dl>
    </>
  );
}

function ChangeTab({ fixture }: { fixture: Fixture }) {
  const a = fixture.run.args;
  const kind = a.prompt ? "Prompt override" : a.mutate.length ? "Tool result mutation" : a.model_id ? "Model swap" : "Nothing changed";
  return (
    <>
      <div className="tab-title">{kind}</div>
      {a.prompt ? (
        <pre className="code prose-code">{a.prompt}</pre>
      ) : (
        <p className="prose" style={{ marginTop: 0 }}>
          Replayed against its own configuration. A fork here is the live model's own run to run variance.
        </p>
      )}
      <Block tone="g" label="Golden prompt">
        <pre className="code prose-code">{fixture.run.golden.prompt}</pre>
      </Block>
      <dl className="kv">
        <dt>model</dt>
        <dd className="mono">{a.model_id ?? "same as recording"}</dd>
        <dt>--strict</dt>
        <dd className="mono">{String(a.strict)}</dd>
        <dt>--fail-on-answer</dt>
        <dd className="mono">{String(a.fail_on_answer)}</dd>
        <dt>--mutate</dt>
        <dd className="mono">{a.mutate.length ? a.mutate.join(", ") : "none"}</dd>
      </dl>
    </>
  );
}

function SourceTab({ fixture }: { fixture: Fixture }) {
  const a = fixture.run.args;
  return (
    <>
      <div className="tab-title">
        <span className="prov">{fixture.provenance}</span> fixture
      </div>
      <p className="prose" style={{ marginTop: 8 }}>
        {fixture.note}
      </p>
      <dl className="kv">
        <dt>{a.run_id ? "run id" : "trace"}</dt>
        <dd className="mono">{a.run_id ?? a.trace}</dd>
        <dt>storage</dt>
        <dd className="mono">{a.storage}</dd>
        <dt>agent module</dt>
        <dd className="mono">{a.agent_module}</dd>
        <dt>shape</dt>
        <dd>gate_compare.py ComparisonResult plus the values gate.py prints. Nothing is fetched.</dd>
      </dl>
    </>
  );
}
