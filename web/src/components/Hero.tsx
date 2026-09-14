import { motion, useReducedMotion } from "motion/react";
import type { UIState } from "../engine/Engine";
import type { ForkModel } from "../engine/model";
import { Odometer, RollText, pad, rise } from "./motion";

interface Props {
  model: ForkModel;
  ui: UIState;
}

type State = "ready" | "replaying" | "diverged" | "complete" | "rewinding";

export function Hero({ model, ui }: Props) {
  const reduced = !!useReducedMotion();
  const r = model.run.result;
  const n = model.n;
  const k = ui.step;
  const fd = r.first_divergence;
  const matchedSoFar = r.steps.filter((s) => s.step <= Math.min(k, n) && s.cause === null).length;
  const matched = r.steps.filter((s) => s.cause === null).length;

  let state: State = "replaying";
  if (ui.rewinding) state = "rewinding";
  else if (ui.diverged) state = "diverged";
  else if (k >= model.kEnd && model.d === null) state = "complete";
  else if (k === 0 && !ui.playing) state = "ready";

  const copy: Record<State, [string, string, string]> = {
    ready: ["Idle", "Ready to replay", `${pad(n)} recorded calls  ·  press space to play`],
    replaying: ["Replaying", "In step with golden", `${pad(matchedSoFar)} of ${pad(n)} calls matched so far`],
    diverged: [
      "Diverged",
      `Forked at step ${pad(model.d ?? 0)}`,
      fd
        ? `${fd.cause}  ·  ${fd.attribution.toLowerCase()}  ·  ${r.attribution_boundary === null ? "no attribution boundary" : `boundary at step ${pad(r.attribution_boundary)}`}`
        : "",
    ],
    complete: ["Complete", "Trajectory matched", `${matched} of ${n} calls matched golden  ·  final text ${r.answer_matched ? "matched" : "differs, informational"}`],
    rewinding: ["Rewind", "Rewinding tape", "retracting the replay into the recording"],
  };
  const [eyebrow, title, sub] = copy[state];
  const c = model.run.counters;
  const t = model.run.tokens;

  return (
    <section className="hero" aria-live="polite">
      <div className="hero-left">
        <motion.div className="hero-eyebrow" {...rise(reduced, 0.3, 6)}>
          <i className="state-dot" data-state={state} />
          <RollText text={eyebrow} />
        </motion.div>
        <motion.h2 className="hero-title" {...rise(reduced, 0.38, 12)}>
          <RollText text={title} />
        </motion.h2>
        <motion.p className="hero-sub" {...rise(reduced, 0.46, 8)}>
          <RollText text={sub} />
        </motion.p>
      </div>

      <dl className="metrics" key={ui.modelIndex}>
        <Metric i={0} label="Calls matched" value={String(matched)} den={`/${n}`} sub="rows with no cause" reduced={reduced} />
        <Metric i={1} label="Results injected" value={String(c.injected)} sub="served from recording" reduced={reduced} />
        <Metric i={2} label="Unrecorded" value={String(c.unrecorded)} sub="synthetic errors returned" reduced={reduced} alert={c.unrecorded > 0} />
        <Metric i={3} label="Tool bodies run" value={String(c.tool_bodies)} sub="real executions" reduced={reduced} />
        <Metric i={4} label="Model calls" value={String(c.n_model)} sub={`${t.input_tokens.toLocaleString("en-US")} in · ${t.output_tokens.toLocaleString("en-US")} out`} reduced={reduced} />
      </dl>
    </section>
  );
}

function Metric({ i, label, value, den, sub, reduced, alert = false }: { i: number; label: string; value: string; den?: string; sub: string; reduced: boolean; alert?: boolean }) {
  return (
    <motion.div className="metric" {...rise(reduced, 0.5 + i * 0.07, 10)}>
      <dt className="metric-label">
        {alert && <i className="alert-dot" />}
        {label}
      </dt>
      <dd className="metric-value">
        <Odometer value={value} delay={0.6 + i * 0.07} />
        {den && <span className="metric-den">{den}</span>}
      </dd>
      <dd className="metric-sub">{sub}</dd>
    </motion.div>
  );
}
