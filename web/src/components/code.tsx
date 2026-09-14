import type { Call } from "../types/gate";
import { isTool } from "../engine/model";

/** A tool call rendered as a function call, one argument per line. `other` marks values that differ. */
export function CallCode({ call, other }: { call: Call | null; other?: Call | null }) {
  if (!isTool(call)) return null;
  const entries = Object.entries(call.args);
  const otherArgs = isTool(other ?? null) ? (other as { args: Record<string, unknown> }).args : null;
  return (
    <pre className="code">
      <span className="c-fn">{call.tool}</span>
      <span className="c-p">({"{"}</span>
      {"\n"}
      {entries.map(([k, v], i) => {
        const differs = otherArgs !== null && JSON.stringify(otherArgs[k]) !== JSON.stringify(v);
        return (
          <span key={k}>
            {"  "}
            <span className="c-k">{k}</span>
            <span className="c-p">: </span>
            <span className={differs ? "c-s c-diff" : "c-s"}>{JSON.stringify(v)}</span>
            {i < entries.length - 1 ? <span className="c-p">,</span> : null}
            {"\n"}
          </span>
        );
      })}
      <span className="c-p">{"})"}</span>
    </pre>
  );
}
