import { motion, useReducedMotion } from "motion/react";
import { Logo } from "./Header";
import { Hairline, Reveal, RollText, rise } from "./motion";
import { Link } from "../router";

interface Props {
  runId: string;
  scenario: string;
  agentModule: string;
  verdict: string;
  storage: string;
  backTo?: { sha: string; label: string };
  navigate: (path: string) => void;
}

/** Same visual language as Header.tsx (logo, crumbs, hairline, badge) but for a single real run: no tape
 * switcher -- there is nothing to switch between for one live result -- replaced by a link back to the
 * commit triage view when this run was reached from one. */
export function RunHeader({ runId, scenario, agentModule, verdict, storage, backTo, navigate }: Props) {
  const reduced = !!useReducedMotion();
  return (
    <header className="header">
      <Hairline axis="x" className="header-rule" delay={0.05} />
      <div className="crumbs">
        <Logo reduced={reduced} />
        <Reveal delay={0.1} className="brand">
          Agent Replay
        </Reveal>
        <span className="slash" aria-hidden>
          /
        </span>
        <Reveal delay={0.16}>
          <RollText text={agentModule} />
        </Reveal>
        <span className="slash" aria-hidden>
          /
        </span>
        <Reveal delay={0.22}>
          <RollText className="mono" text={scenario} />
        </Reveal>
        <motion.span className="badge" data-v={verdict} {...rise(reduced, 0.32, 4)}>
          <i />
          <RollText text={`${verdict} · exit ${verdict === "FAIL" ? 1 : 0} · ${storage}`} />
        </motion.span>
      </div>
      <div className="header-right">
        {backTo && (
          <motion.span {...rise(reduced, 0.36, 4)}>
            <Link to={`/commit/${backTo.sha}`} className="header-note" onNavigate={navigate}>
              ← {backTo.label}
            </Link>
          </motion.span>
        )}
        <motion.span className="header-note" {...rise(reduced, 0.4, 4)} title={runId}>
          <i className="pulse" />
          real run · model live · tool results injected from recording
        </motion.span>
      </div>
    </header>
  );
}
