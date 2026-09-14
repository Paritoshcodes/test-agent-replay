import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { FIXTURES, type Fixture } from "../fixtures";
import { EASE, Hairline, Reveal, RollText, rise } from "./motion";

interface Props {
  fixture: Fixture;
  selected: number;
  onSelect: (i: number) => void;
}

const SEG_W = 116;

export function Header({ fixture, selected, onSelect }: Props) {
  const reduced = !!useReducedMotion();
  const [tip, setTip] = useState<number | null>(null);
  const a = fixture.run.args;
  const verdict = fixture.run.result.verdict;
  const tipFixture = tip === null ? null : FIXTURES[tip];

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
          <RollText text={a.agent_module} />
        </Reveal>
        <span className="slash" aria-hidden>
          /
        </span>
        <Reveal delay={0.22}>
          <RollText className="mono" text={a.run_id ?? a.trace ?? ""} />
        </Reveal>
        <motion.span className="badge" data-v={verdict} {...rise(reduced, 0.32, 4)}>
          <i />
          <RollText text={`${verdict} · exit ${verdict === "FAIL" ? 1 : 0}`} />
        </motion.span>
      </div>

      <div className="header-right">
        <motion.span className="header-note" {...rise(reduced, 0.36, 4)}>
          <i className="pulse" />
          model live · tool results injected from recording
        </motion.span>

        <motion.div className="seg" role="group" aria-label="Recorded gate runs" style={{ ["--seg-w" as string]: `${SEG_W}px` }} {...rise(reduced, 0.42, 4)}>
          {FIXTURES.map((f, i) => (
            <button
              key={f.id}
              type="button"
              className="seg-btn"
              aria-pressed={i === selected}
              aria-keyshortcuts={f.key}
              aria-label={`Tape ${f.id}, ${f.cause}: ${f.title}`}
              onClick={() => onSelect(i)}
              onPointerEnter={() => setTip(i)}
              onPointerLeave={() => setTip(null)}
              onFocus={() => setTip(i)}
              onBlur={() => setTip(null)}
            >
              {i === selected && <motion.span layoutId="seg-pill" className="seg-pill" transition={{ type: "spring", stiffness: 520, damping: 40 }} />}
              <span className="seg-id">{f.id}</span>
              <i className="dot" data-v={f.run.result.verdict} />
              <span className="seg-name">{f.short}</span>
            </button>
          ))}

          <AnimatePresence>
            {tipFixture && (
              <motion.div
                className="seg-tip"
                role="tooltip"
                initial={reduced ? false : { opacity: 0, y: -4, x: -(3 - tip!) * SEG_W }}
                animate={{ opacity: 1, y: 0, x: -(3 - tip!) * SEG_W }}
                exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -4, transition: { duration: 0.12 } }}
                transition={{ x: { type: "spring", stiffness: 520, damping: 42 }, default: { duration: 0.22, ease: EASE } }}
              >
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.div
                    key={tipFixture.id}
                    initial={reduced ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, transition: { duration: reduced ? 0 : 0.08 } }}
                    transition={{ duration: 0.18 }}
                  >
                    <div className="tip-head">
                      <span className="tip-cause" data-v={tipFixture.run.result.verdict}>
                        {tipFixture.cause}
                      </span>
                      <span className="prov">{tipFixture.provenance}</span>
                    </div>
                    <div className="tip-title">{tipFixture.title}</div>
                    <div className="tip-note">{tipFixture.note}</div>
                    <div className="tip-key">
                      press <kbd>{tipFixture.key}</kbd>
                    </div>
                  </motion.div>
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>
    </header>
  );
}

export function Logo({ reduced }: { reduced: boolean }) {
  const draw = (delay: number) =>
    reduced ? { initial: false as const } : { initial: { pathLength: 0 }, animate: { pathLength: 1 }, transition: { delay, duration: 0.9, ease: EASE } };
  return (
    <svg className="logo" width="22" height="22" viewBox="0 0 22 22" aria-hidden>
      <motion.path d="M2 8h18" stroke="#ededed" strokeWidth="1.6" strokeLinecap="round" fill="none" {...draw(0.05)} />
      <motion.path d="M6 8c5 0 5 7 10 7h4" stroke="#47a8ff" strokeWidth="1.6" strokeLinecap="round" fill="none" {...draw(0.45)} />
      <circle cx="8.5" cy="8" r="1.9" fill="#0a0a0a" stroke="#ff6166" strokeWidth="1.3" />
    </svg>
  );
}
