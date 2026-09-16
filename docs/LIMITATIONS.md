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

## Specialists are opaque (Phase 2, docs/DECISIONS.md)

Phase 2 instruments the supervisor agent only. A call like `billing_specialist(query="...")` is captured
as a single opaque tool call -- everything the specialist does inside that call (`lookup_account`,
`check_balance`, and for billing/escalation, `retrieve`) is invisible to agent-replay entirely; it is not
even in the candidate trace to be matched or missed. This is a real, current boundary, not a rounding
error: the specialist's own tool calls are exactly the STRUCTURED, stable, consequential ones (see the
free-text section below) -- the ones a contract would most want to pin down -- and none of them are
visible yet. Seeing inside a specialist means instrumenting an agent CREATED INSIDE another agent's own
tool call, mid-run, not at the top level agent-replay already controls -- this needs the SAME scoped
attach/detach shape agent_replay/adapter.py's ScopedInstrumentation already has (built that way now for
exactly this reason), applied to a hook fired when the supervisor's tool call boundary is crossed, plus the
`agent` field every event already carries (Phase 2.3) actually varying by specialist name instead of always
reading "supervisor". Both are groundwork already laid, not yet wired up.

## Free-text tool arguments defeat exact-match keying (Phase 2.4, docs/DECISIONS.md)

Every contract key in this project is (tool_name, exact_canonical_args) -- see agent_replay/callsig.py's
call_key. That holds up when a tool's arguments are structured (an enum, a normalized account number, a
postcode) but not when an argument is free natural-language text the model composes fresh, in its own
words, on every call -- which is exactly what the supervisor passes to `billing_specialist`/
`scheduling_specialist` (a `query: str` parameter, the customer's request restated in the model's own
words) in the sample multi-agent repo (Phase 0, docs/DECISIONS.md).

Measured directly from the Phase 0 runs (already-collected data, no new live calls): across 5 scheduling
runs, `scheduling_specialist` was called 6 times total (one run called it twice) with exactly 2 DISTINCT
query strings -- "Book a meter reading for ACC-100456 in LS6 2AB" (5 of 6 calls) and a supervisor-reworded
"Schedule a meter reading for ACC-100456 in LS6 2AB" (1 of 6, from the run that called it twice) -- despite
every run being fed the IDENTICAL literal customer query. The supervisor itself introduces wording
variance even with zero variation in its input. Across 2 billing runs, `billing_specialist` was called
twice with 1 distinct query string (no variance observed, but N=2 is a small sample; the scheduling data,
with a real reworded duplicate inside a single run, is the more informative signal). `classify_intent` is
NOT free text in practice here -- when the supervisor calls it, it passes the original customer wording
verbatim, never a paraphrase (1 distinct value across all classify_intent calls in both scenarios).

Structured or free text: `check_balance(account_number=...)` and `check_availability(appointment_type=...,
postcode=...)` are BOTH structured -- an enum/normalized string the specialist extracts FROM the free text,
not the free text itself. These are invisible to agent-replay in Phase 2 (see "Specialists are opaque"
above), which means the ONLY calls agent-replay can currently see for billing/scheduling
(`billing_specialist`/`scheduling_specialist` themselves) are exactly the free-text ones, and the
structured, stable ones one level down are exactly the ones it cannot see yet.

Is the contract still useful today, with this exact combination of gaps? Yes, but narrower than it looks:
`classify_intent` keys reliably (1 distinct value observed) and belongs in `permits` at whatever N-of-M
rate it is actually called (Phase 0: 3 of 5 scheduling runs) -- a real, meaningful signal about the
supervisor's own discretion. `billing_specialist`/`scheduling_specialist` calls, keyed on their free-text
query argument, will fragment into mostly-unique `permits` entries (each run's literal argument value is
close to its own contract key) rather than ever accumulating confidence as a single stable
`requires`/`permits` entry -- exactly the failure mode Phase 2.4's seam (agent_replay/callsig.py's
`call_key(tool, args, *, strategy=...)`) exists to eventually fix, e.g. a "key on tool name only, ignore
free-text args" strategy for specifically these two tools. Not fixed here -- the seam exists, nothing is
plugged into it yet, per instruction.

## The confidence bar on `requires` trades detection power for gate trustworthiness

Phase 4 (docs/DECISIONS.md): a call seen in every run of N is no longer promoted to `requires` just because
N happened to be unanimous, once its OWN TOOL shows real variance elsewhere in this SAME recording (proof
that specific tool has genuine discretion) -- promotion then needs N large enough that an accidental
unanimous run is unlikely at THAT TOOL's own observed rate in this recording (Phase 0 fix: originally one
project-wide rate borrowed from schedule-meter-reading's classify_intent regardless of which tool was
being judged -- corrected because a variable call elsewhere in a recording is not evidence about an
unrelated, always-called tool). A tool with NO variance anywhere in this recording still promotes
immediately regardless of N (vulnerable-dependency's own real, historical shape is unaffected either way).

The trade-off, stated plainly and not buried: a higher bar means a genuine regression on a call with real
natural variance sits in `permits` and goes UNFLAGGED if it stops happening, because `permits` allows both
presence and absence as PASS. This is a real cost, not a hypothetical one -- it is the price of not having
a gate that fails on an unchanged configuration, which is the failure mode this whole project exists to
avoid. A call that never gets to prove itself unanimous enough is a call this contract can no longer
protect at all; it can only observe it.

## A contract can only be as strict as the agent is consistent

`schedule-meter-reading`'s fresh 15-run recording (Phase 0, docs/DECISIONS.md) found `check_availability`
called in 14 of 15 runs against the IDENTICAL booking query -- the agent skipped checking the calendar
before scheduling a meter reading once, for no input reason. That is not comparator noise and it is not
something this task engineered around: it is a real inconsistency in the sample agent's own behavior, in a
domain (scheduling) where skipping the availability check is a real bug, not a stylistic variation. Per-key
or per-tool, no derivation rule can promote a call to `requires` that the agent itself does not reliably
make -- the contract is describing the agent honestly, not failing to be strict enough. `permits` is the
correct, if unsatisfying, home for `check_availability` here: present or absent, both PASS, because absent
really does happen. Making this gate stricter would mean either lying about what the agent does (promoting
a call that isn't actually guaranteed) or the agent needs to change, not the contract. This is the tool
surfacing information about the agent -- which is the point of building it.
