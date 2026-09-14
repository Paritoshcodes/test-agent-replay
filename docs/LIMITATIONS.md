# Limitations

Agent Replay detects changes in which tool calls an agent made, with what arguments, and whether the
order respected the data dependencies between them. It does not verify that a decision was correct given
the data the agent read. An agent that reads refund_eligible=false and issues a refund anyway passes,
because that requires semantic judgement and semantic judgement is not deterministic. Determinism is the
property this tool sells, so it is not traded away to widen coverage.

## Attribution boundary

The attribution boundary marks the first tool call gate replay could not match to the golden trace. Every
step at or before it is attributable to the one variable under test (a prompt, a model, a mutation);
everything after it is not, because by then the agent is reacting to a synthetic error result it never
saw in the golden run, and two things differ from golden at once -- the change under test and the
harness's fake response -- so downstream behaviour can no longer be pinned on either one alone. A change
whose real effect only appears after an early unrelated mismatch (see docs/DECISIONS.md's boto3 and
ordering findings) will therefore show as UNATTRIBUTED, not as evidence the change did nothing.

## Live-model variance on an unchanged configuration

Gate replay makes a real model call every run, so even with nothing changed the agent can occasionally
take a genuinely different action -- not a comparator artifact, a real difference in what the model did.
Measured on the audit agent (5 runs, unchanged prompt and model, traces/audit-001.json): 4/5 PASS, 1/5
FAIL, exit 1. The one failure was a live model making an unprompted extra get_package_info call after its
own trajectory had already matched golden step for step, then reporting to itself that the extra call
had "an error" -- a real, if rare, self-correction attempt, correctly flagged as UNRECORDED/attributable
since golden has no matching call for it. A ~20% no-op failure rate on this agent is a real property of
the live model, not of the comparator; treat a single FAIL on an otherwise-unchanged configuration as
inconclusive and re-run before trusting it as a regression signal.

## Scaling boundaries

Agent Replay's AWS storage (spike/storage.py, infra/template.yaml) is built for the workload it actually
has: CI-scale runs, tens of events each, one run inspected or compared at a time by run_id. The following
are measured boundaries of that design, not defects -- each is fine at that scale and each has a known
threshold where it stops being fine. None of these are being fixed here.

- **load() issues one unpaginated DynamoDB query.** A single Query response caps at 1MB; each event item
  is a few hundred bytes, so this holds comfortably into the thousands of events per run before DynamoDB
  would return `LastEvaluatedKey` and truncate silently. Tens of events, the actual workload, is nowhere
  close to that line.
- **No secondary index for most access patterns.** Every `load()` is still a full trace of a known run_id
  via the partition key -- fast and cheap for that, but there is still no way to list runs by agent, date,
  or kind without a full table Scan. Partially addressed for ONE access pattern (Phase 5, docs/DECISIONS.md,
  2026-09-14): `infra/template.yaml` now defines a `CommitIndex` GSI on `commit_sha` so "every run for this
  commit" is a real Query, since that's specifically what a dashboard needs first. This GSI is DESIGNED and
  in the template, not yet deployed to the live agent-replay-dev stack -- see the update command in
  docs/DECISIONS.md's Phase 5 entry. It cannot be verified working (a GSI's actual query behavior) without
  deploying it, which this project has not been asked to do.
- **No optimistic locking.** Two callers writing the same run_id concurrently silently last-write-wins,
  per DynamoDB item. Not a concern for a single CLI invocation per run, which is the only way this tool is
  ever driven today.
- **AwsTraceStorage resolves table/bucket names via `describe_stacks` on every init**, unless
  `AGENT_REPLAY_TABLE`/`AGENT_REPLAY_BUCKET` are set. One extra network round trip per CLI invocation --
  negligible for a human running record/replay/gate by hand, not something to leave unset in an automated
  loop calling this many times a minute.

## Dedup is a measurement, not a shortfall

Recording the same audit-agent run twice (--storage aws, back to back) produced 1 deduplicated payload out
of 24 -- the read_manifest input URL, the only value structurally guaranteed identical across two live
runs. Every model event's text differed and every tool output differed too. This is not underperforming
content-addressed storage: it is exactly the nondeterminism this tool exists to detect, observed from the
storage layer instead of the comparator. A low dedup rate on repeated recordings is expected and correct.

## Order-edge granularity in a contract

A contract's `order` list is `(before_tool, after_tool)` pairs at TOOL-NAME granularity -- "some call to
`get_package_info` happened before this call to `check_vulnerabilities`," not "the `get_package_info` call
for THIS SAME package happened before it." This is deliberately looser than spike/gate_compare.py's own
ORDER_VIOLATION, which compares one candidate run against one golden run at the instance level (this exact
call's argument value traced to that exact earlier call's output). The instance-level version is stricter
and was tried first; it was loosened here on purpose, for the same reason gate_compare.py's own comparator
moved from positional to dependency-aware in the first place (see this file's own history and
docs/DECISIONS.md): two independent calls in the reverse order should never be a violation, and at
tool-name granularity that is automatically true, so a contract permits `get_package_info(strands-agents)`
happening after `check_vulnerabilities(boto3)` without complaint, correctly.

The real trade, stated plainly: **a contract cannot express "this specific package's vulnerability check
must be preceded by this same package's info lookup."** It can only express "a `check_vulnerabilities` call
of any kind must be preceded by a `get_package_info` call of any kind." Concretely, a regression where the
agent starts calling `check_vulnerabilities(name=boto3, version=1.43.93)` WITHOUT ever calling
`get_package_info(name=boto3)` first, but has already called `get_package_info(name=strands-agents)`
earlier in the same run for a completely different package, currently PASSES the `order` check --
`order_seen` (agent_replay/evaluate.py) tracks tool names only, and `get_package_info` is already in that
set by the time the boto3 check happens. Per-instance ordering (spike/gate_compare.py's own
ORDER_VIOLATION, against a single golden trace) would catch exactly this, since the golden trace's own
`get_package_info(boto3) -> check_vulnerabilities(boto3)` edge is a real, specific data-flow dependency.
This gap is not fixed here; it is the accepted cost of a contract that spans N runs instead of one.

## The callsig format's type coercion

Contract `requires`/`permits` entries render as `tool(arg=value, ...)` (agent_replay/callsig.py) for
readability -- a diff of two contracts reads like a diff of two call lists, not a data structure. The
cost: values are parsed back with a plain bool/int/float/string ladder, so a purely-numeric-string argument
(e.g. an id written as `"1001"` with no letters) would silently become the integer `1001` on load, and
would then fail to key-match a live call whose argument is the JSON string `"1001"`. None of this repo's
real tool arguments hit this today (URLs, package names, dotted version strings, `"A-1001"`) -- documented,
not hidden.

A second, related gap surfaced by Phase 2's mixed-manifest experiment (docs/DECISIONS.md, 2026-09-14): key
matching is exact-string, so `check_vulnerabilities(name=pyyaml, ...)` and
`check_vulnerabilities(name=PyYAML, ...)` are two entirely different contract entries, even though they are
obviously the same underlying action with different capitalization of a package name the model itself
supplied (sometimes from the manifest's literal text, sometimes from PyPI's own canonical casing in a
prior `get_package_info` response). A live model was also observed emitting the literal string `"latest"`
as a version value, rather than a resolved version number -- a real value like any other to the exact-match
keying, not a bug, but a symptom of the same underlying issue: nothing here normalizes "the same intent,
phrased differently." Neither is fixed; both fragment `permits` into more entries than the underlying
behavior really has.

## Editable install only

`pip install agent-replay` from PyPI does not work, and is not intended to yet. `agent_replay/paths.py`
locates `spike/` by walking up from its OWN file location (`Path(__file__).resolve().parent.parent /
"spike"`) -- correct only when `agent_replay/`'s parent directory IS a checkout of this repository, which
is exactly what `pip install -e .` (editable install) guarantees and a built wheel installed elsewhere does
not. See README.md's "Package layout" section for why spike/ was kept out of the installable package
entirely rather than absorbed into it. Every command in this README assumes `pip install -e .` from inside
a clone of this repository.

## Byte-identical replay is not claimed portable across machines

Phase 1 (docs/DECISIONS.md, 2026-09-14) made traces, contracts and scenario prompts portable across
checkouts for `record`/`test`/`gate` (agent_replay/portable.py: a `{repo}` placeholder, expanded to a real
path only where one is actually needed). `agent-replay replay`'s byte-identical mode was deliberately left
out of that fix: it works by requiring EXACT equality between a freshly-built model/tool call and whatever
was originally recorded (spike/agent.py's ReplayableBedrockModel.stream and ToolTap._inject, both
unchanged, both zero-tolerance). The original absolute path is embedded inside the recorded model
conversation's own message history, which this project does not rewrite -- doing so safely would mean
parsing and rewriting streamed Bedrock response content, which can split a string like a path across
multiple stream-delta chunks, risking silent corruption for a guarantee (byte-identical replay) that
exists specifically to be trustworthy. Verified working on the SAME machine after the Phase 1 migration
(the loaded trace is expanded back to this machine's own root before replay, reproducing the original
exactly). NOT verified, and not claimed, across machines or checkout paths.

## A fresh CI checkout has no local reference recordings

`traces/` is gitignored (by original spike/ design, predating this task) and `agent-replay/contracts/*`
only stores portable CALL ARGUMENTS, not the actual tool RESULTS a contract's injection needs -- those live
in the reference recordings themselves. A `git clone` in CI gets scenarios.yaml and every contract, but
zero trace files: `agent-replay test --storage local` in a fresh CI checkout will fail to find any
reference recording at all. This is not a bug to fix here; it is why `--storage aws` (the deployed
DynamoDB+S3 stack, infra/template.yaml) exists and why CI (see the GitHub Actions workflow this repo adds)
MUST use it -- stated explicitly so it is not rediscovered the hard way in a PR.

## Finite N does not fully bound an unbounded-variation scenario

`vulnerable-dependency-mixed` (docs/DECISIONS.md, 2026-09-14) deliberately leaves two packages unpinned to
test whether `permits` populates -- it does, but the resulting contract is not fully stable. A fresh
`agent-replay test` run against it can still FAIL with UNSOURCED_ARGUMENT on a `check_vulnerabilities`
call for the unpinned `pyyaml` using a version string none of the 5 reference runs happened to produce (the
model's own final answer named this directly: "Despite multiple attempts, I am unable to successfully
check vulnerabilities for 'pyyaml'"). An unpinned package's version has no natural upper bound on how many
ways a model can phrase checking it; 5 (or any fixed N) reference runs narrow the gap, they do not close
it. A genuinely well-behaved contract needs either a pinned input (removing the ambiguity, as in
`vulnerable-dependency`) or a human-authored `permits`/`forbids` rule loose enough to cover the real range
of acceptable behavior -- `--runs N` alone is not a substitute for either.
