import { pollFork, startFork, type ForkEvent, type ForkMutation, type ForkStatus } from "../api";

/**
 * Phase 2.2 (docs/DECISIONS.md): the browser-side half of JOB + POLL (Phase 2.0's approved mechanism --
 * no streaming connection anywhere, just a plain fetch loop). Polls GET /forks/{id}?after=<cursor> every
 * ~800ms, advancing the cursor with each response, calling `onEvent` once per NEW event in arrival order,
 * and stopping on a terminal status. This is the ONLY thing that makes "steps appear one at a time" true on
 * the frontend -- SwimlaneEngine's own fork methods (beginFork/addForkStep/...) are dumb appenders, called
 * from here exactly as often as a real event actually arrives, never faster.
 */

const POLL_INTERVAL_MS = 800;
// 2.1.5's own orphan ceiling is enforced server-side (lambda_fork_api.py, 180s) on every response this
// loop would see anyway -- this is the client's OWN backstop for the one case the server-side ceiling
// cannot cover: the network itself going away entirely (a torn connection, the API becoming unreachable),
// where no response -- successful OR a reported "failed" -- ever arrives to stop this loop. Set a little
// above the server's own ceiling so the normal case is always the server's own answer, never a race.
const CLIENT_ORPHAN_CEILING_MS = 210_000;

export interface ForkRunHandle {
  cancel: () => void;
}

export interface ForkRunHandlers {
  onStarted: (forkId: string) => void;
  onEvent: (e: ForkEvent) => void;
  onStatus: (status: ForkStatus | "orphaned") => void;
  /** A startFork()/pollFork() call itself failed (network, 5xx, or a validation 400 from startFork) --
   * distinct from a "type":"error" fork EVENT, which is the fork's own reported outcome. */
  onRequestError: (message: string, body?: Record<string, unknown>) => void;
}

export function runFork(scenario: string, mutation: ForkMutation, runId: string | undefined, handlers: ForkRunHandlers): ForkRunHandle {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stop = () => {
    cancelled = true;
    if (timer !== null) clearTimeout(timer);
  };

  (async () => {
    let forkId: string;
    try {
      const started = await startFork(scenario, mutation, runId);
      forkId = started.fork_id;
    } catch (e) {
      const err = e as { message?: string; body?: Record<string, unknown> };
      handlers.onRequestError(err.message ?? "could not start fork", err.body);
      return;
    }
    if (cancelled) return;
    handlers.onStarted(forkId);

    let cursor = 0;
    const startedAt = Date.now();

    const tick = async () => {
      if (cancelled) return;
      if (Date.now() - startedAt > CLIENT_ORPHAN_CEILING_MS) {
        handlers.onStatus("orphaned");
        return;
      }
      try {
        const res = await pollFork(forkId, cursor);
        if (cancelled) return;
        cursor = res.cursor;
        for (const e of res.events) handlers.onEvent(e);
        if (res.status === "running") {
          timer = setTimeout(tick, POLL_INTERVAL_MS);
        } else {
          handlers.onStatus(res.status);
        }
      } catch (e) {
        if (cancelled) return;
        const err = e as { message?: string };
        // A single failed poll (a transient network hiccup on the BROWSER's side, not the fork's own
        // execution) is not the fork failing -- keep polling on the same schedule rather than giving up
        // after one bad request; the client-side orphan ceiling above still bounds this.
        handlers.onRequestError(err.message ?? "poll failed, retrying");
        timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    };

    timer = setTimeout(tick, POLL_INTERVAL_MS);
  })();

  return { cancel: stop };
}
