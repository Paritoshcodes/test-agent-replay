import { motion } from "motion/react";

/** Full-viewport loading/error/empty states, styled to match the instrument (dark, hairline, mono type)
 * rather than a generic spinner or a blank white flash -- real network calls mean real latency and real
 * failure, and this project's whole ethos is "never claim more than what's checked" (docs/LIMITATIONS.md),
 * so an error here says exactly what went wrong instead of a vague "something broke". */

export function LoadingScreen({ label }: { label: string }) {
  return (
    <div className="state-screen" role="status" aria-live="polite">
      <div className="state-spinner" aria-hidden>
        <motion.span animate={{ rotate: 360 }} transition={{ duration: 1.1, repeat: Infinity, ease: "linear" }} />
      </div>
      <div className="state-label">{label}</div>
    </div>
  );
}

export function ErrorScreen({ title, detail, retry }: { title: string; detail?: string; retry?: () => void }) {
  return (
    <div className="state-screen state-screen-error" role="alert">
      <div className="state-icon" aria-hidden>
        !
      </div>
      <div className="state-title">{title}</div>
      {detail && <div className="state-detail">{detail}</div>}
      {retry && (
        <button type="button" className="state-retry" onClick={retry}>
          Retry
        </button>
      )}
    </div>
  );
}
