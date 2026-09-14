import type { Engine, UIState } from "../engine/Engine";
import { argSummary, isTool, type ForkModel, type ForkNode } from "../engine/model";
import { pad } from "./motion";

interface Props {
  engine: Engine;
  model: ForkModel;
  ui: UIState;
  hover: string | null;
  setHover: (id: string | null) => void;
}

/**
 * The DOM half of the fork: a focusable target and a label per node, plus the playhead chip and markers.
 * The engine positions every anchor each frame; React only decides what the labels say.
 */
export function ForkOverlay({ engine, model, ui, hover, setHover }: Props) {
  const fd = model.run.result.first_divergence;
  const tearFlip = model.d !== null && engine.xOf(model.d - 0.5) < 300;

  return (
    <div className="overlay">
      {model.nodes.map((n) => (
        <div
          key={`${ui.modelIndex}-${n.id}`}
          className="node"
          ref={engine.ref(`node:${n.id}`)}
          data-lane={n.lane}
          data-kind={n.kind}
          data-past={ui.step >= n.k}
          data-flag={n.flagged}
          data-ua={n.unattributed}
          data-hover={hover === n.id}
          style={{ visibility: "hidden" }}
        >
          <button
            type="button"
            className="node-hit"
            aria-label={aria(model, n)}
            onPointerEnter={() => setHover(n.id)}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(n.id)}
            onBlur={() => setHover(null)}
            onClick={() => engine.seek(n.k, "click")}
          />
          <Label model={model} node={n} />
        </div>
      ))}

      <div className="phead" ref={engine.ref("phead")}>
        <span className="phead-chip">
          T+<span ref={engine.ref("phead-text")}>00.00</span>
        </span>
      </div>

      {model.boundary !== null && (
        <div key={`b${ui.modelIndex}`} className="marker" ref={engine.ref("boundary")} style={{ visibility: "hidden" }}>
          <span className="marker-chip">
            <i className="sw-hatch" />
            Attribution boundary
            <span className="dim">after step {pad(model.boundary)}, unattributed</span>
          </span>
        </div>
      )}

      {model.d !== null && fd && (
        <div key={`t${ui.modelIndex}`} className="marker marker-tear" data-flip={tearFlip} ref={engine.ref("tear")} style={{ visibility: "hidden" }}>
          <span className="marker-chip">
            <i className="dot-red" />
            First divergence
            <b>{fd.cause}</b>
          </span>
        </div>
      )}

      <div className="legend" aria-hidden>
        <span>
          <i className="sw" data-k="g" />
          Golden · recorded
        </span>
        <span>
          <i className="sw" data-k="c" />
          Candidate · replayed, model live
        </span>
        {model.boundary !== null && (
          <span>
            <i className="sw-hatch" />
            Unattributed
          </span>
        )}
        <span className="dim">drag the field to scrub</span>
      </div>
    </div>
  );
}

function Label({ model, node }: { model: ForkModel; node: ForkNode }) {
  const level = node.k % 2;
  if (node.kind === "origin") {
    return (
      <span className="lbl" data-pos="down" data-level="0" data-align="start">
        <span className="lbl-tool">Prompt</span>
        <span className="lbl-arg">{model.run.args.prompt ? "override" : "unchanged"}</span>
      </span>
    );
  }
  if (node.kind === "answer") {
    const golden = node.lane !== "candidate";
    const line = golden ? model.goldenVerdict : model.candidateVerdict;
    return (
      <span className="lbl" data-pos={node.lane === "candidate" ? "down" : "up"} data-level="0" data-align="end">
        <span className="lbl-tool">{node.lane === "fused" ? "Final answer" : golden ? "Golden answer" : "Candidate answer"}</span>
        <span className="lbl-arg">{line.length > 26 ? `${line.slice(0, 24)}...` : line}</span>
      </span>
    );
  }
  const call = node.kind === "ghost" ? (node.row?.golden ?? null) : node.call;
  const pos = node.lane === "candidate" ? "down" : "up";
  const cause = node.row?.cause;
  return (
    <>
      <span className="lbl" data-pos={pos} data-level={level}>
        <span className="lbl-tool">{node.kind === "ghost" ? "never called" : isTool(call) ? call.tool : ""}</span>
        <span className="lbl-arg">{node.kind === "ghost" && isTool(call) ? `${call.tool} ${argSummary(call)}` : argSummary(call)}</span>
      </span>
      {node.flagged && cause && (
        <span className="tag" data-pos={pos === "up" ? "down" : "up"}>
          {cause}
        </span>
      )}
    </>
  );
}

function aria(model: ForkModel, n: ForkNode): string {
  if (n.kind === "origin") return "Origin: the prompt and any change under test.";
  if (n.kind === "answer") return `${n.lane === "candidate" ? "Candidate" : n.lane === "golden" ? "Golden" : "Final"} answer: ${n.lane === "golden" ? model.goldenVerdict : model.candidateVerdict}`;
  const row = n.row!;
  const call = n.kind === "ghost" ? row.golden : n.call;
  const what = isTool(call) ? `${call.tool} ${argSummary(call)}` : "";
  return `Step ${row.step}, ${n.lane === "fused" ? "matched" : n.lane}${n.kind === "ghost" ? ", never called" : ""}: ${what}. ${row.cause ?? "match"}, ${row.attribution.toLowerCase()}.`;
}
