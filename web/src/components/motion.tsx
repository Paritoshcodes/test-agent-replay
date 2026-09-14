import { AnimatePresence, motion, useReducedMotion, type TargetAndTransition, type Transition } from "motion/react";
import type { ReactNode } from "react";

export const EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];

export const pad = (n: number): string => String(Math.max(0, n)).padStart(2, "0");

/** Fade-and-rise entrance beat. Reduced motion lands on the resting state with no transition. */
export function rise(reduced: boolean, delay: number, y = 8): { initial: false | TargetAndTransition; animate: TargetAndTransition; transition: Transition } {
  return {
    initial: reduced ? false : { opacity: 0, y },
    animate: { opacity: 1, y: 0 },
    transition: reduced ? { duration: 0 } : { delay, duration: 0.8, ease: EASE },
  };
}

/** Text that rises out of a mask on first paint. */
export function Reveal({ children, delay = 0, className = "" }: { children: ReactNode; delay?: number; className?: string }) {
  const reduced = !!useReducedMotion();
  return (
    <span className={`reveal ${className}`}>
      <motion.span className="reveal-in" initial={reduced ? false : { y: "110%" }} animate={{ y: "0%" }} transition={{ delay, duration: 0.9, ease: EASE }}>
        {children}
      </motion.span>
    </span>
  );
}

/** Text that rolls vertically whenever its value changes: old line exits up, new line enters from below. */
export function RollText({ text, className = "" }: { text: string; className?: string }) {
  const reduced = !!useReducedMotion();
  return (
    <span className={`roll ${className}`}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={text}
          className="roll-in"
          initial={reduced ? false : { y: "100%", opacity: 0 }}
          animate={{ y: "0%", opacity: 1 }}
          exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { y: "-100%", opacity: 0 }}
          transition={{ duration: 0.42, ease: EASE }}
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

/** Mechanical odometer. Each digit is a strip of 0-9 sprung to its value; columns align from the right. */
export function Odometer({ value, className = "", delay = 0 }: { value: string; className?: string; delay?: number }) {
  const reduced = !!useReducedMotion();
  const chars = value.split("");
  return (
    <span className={`odo ${className}`} role="text" aria-label={value}>
      {chars.map((ch, i) => {
        const slot = chars.length - i;
        if (!/\d/.test(ch)) {
          return (
            <span key={`s${slot}`} className="odo-sep" aria-hidden>
              {ch}
            </span>
          );
        }
        return (
          <span key={`d${slot}`} className="odo-col" aria-hidden>
            <motion.span
              className="odo-strip"
              initial={reduced ? false : { y: "0%" }}
              animate={{ y: `${-Number(ch) * 10}%` }}
              transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 120, damping: 19, mass: 0.9, delay: delay + slot * 0.04 }}
            >
              {DIGITS.map((d) => (
                <span key={d}>{d}</span>
              ))}
            </motion.span>
          </span>
        );
      })}
    </span>
  );
}

/** A hairline that draws itself in from its origin edge. */
export function Hairline({ axis, className = "", delay = 0 }: { axis: "x" | "y"; className?: string; delay?: number }) {
  const reduced = !!useReducedMotion();
  const from = axis === "x" ? { scaleX: 0 } : { scaleY: 0 };
  const to = axis === "x" ? { scaleX: 1 } : { scaleY: 1 };
  return <motion.i className={`hairline ${className}`} aria-hidden initial={reduced ? false : from} animate={to} transition={{ delay, duration: 1.2, ease: EASE }} />;
}
