import { RunView } from "../components/RunView";
import { SYNTHETIC_FIXTURES, type SyntheticFixtureName } from "../fixtures/synthetic";

/** GET /dev/:name -- renders a synthetic fixture (fixtures/synthetic.ts) through the real RunView/
 *  SwimlaneEngine with no API call. Exists to screenshot and verify edge cases (a 40-step, 3-level-deep
 *  run; a 1-step run; very long tool names/arguments) that no real recording in this project is anywhere
 *  near large enough to exercise (Phase 1, docs/DECISIONS.md). Not linked from anywhere in the app chrome. */
export function DevFixturePage({ name, navigate }: { name: string; navigate: (path: string) => void }) {
  const run = SYNTHETIC_FIXTURES[name as SyntheticFixtureName];
  if (!run) {
    return (
      <div className="state-screen state-screen-error" role="alert">
        <div className="state-icon" aria-hidden>
          !
        </div>
        <div className="state-title">Unknown dev fixture "{name}"</div>
        <div className="state-detail">Available: {Object.keys(SYNTHETIC_FIXTURES).join(", ")}</div>
      </div>
    );
  }
  return <RunView key={name} gateRun={run} runId={`dev--${name}`} scenario={name} navigate={navigate} />;
}
