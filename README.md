# agent-replay

Your agent writes its own behavioral contract by running. You review it in a pull request like code. The
build fails when your agent breaks it.

Concretely: `agent-replay` runs your Strands agent for real, N times, and derives a short YAML file listing
which tool calls it always makes, which it sometimes makes, what order they happen in, and (once you add
them by hand) what it must never do. That file is a contract. `agent-replay test` runs the agent again --
model live, tool results replayed from the recordings -- and fails the build the moment a run breaks it.

This is not evals. An eval scores an answer against a rubric, usually with another LLM doing the scoring.
A contract here is exact set logic over recorded tool calls: no LLM judges anything, every verdict is
reproducible from the contract file and the run's own trace.

## Install

```
pip install -e .
```

`--storage local` is the default everywhere, and it is all you need to try this: install, `init`, `record`,
`test`, done, on a laptop with nothing but Bedrock credentials. `--storage aws` is opt-in, for CI and the
deployed dashboard stack (`infra/template.yaml`) -- see "AWS and CI" below.

## Quickstart

```
agent-replay init
```

This detects the Strands agent modules in `spike/`, asks for a scenario name and an input prompt, asks how
many runs to record (more runs teaches the contract to tolerate the model's own run-to-run variation), and
writes `agent-replay/scenarios.yaml`. It offers to record immediately; non-interactive setup (for scripts
and CI bootstrapping) is flags:

```
agent-replay init --agent audit_agent --name vulnerable-dependency \
  --input "Audit the dependencies pinned in file:///path/to/requirements.txt and give a deploy verdict." \
  --runs 3 --record
```

Read the contract it produced:

```
cat agent-replay/contracts/vulnerable-dependency.yaml
```

```yaml
# Derived from 3 recorded runs of scenario "vulnerable-dependency"
# on 2026-09-14 by `agent-replay record vulnerable-dependency --runs 3`.
#
# This is a starting point, meant to be read and edited by a human -- `agent-replay test` enforces
# exactly what is written below, nothing more. ...

# Called in EVERY recorded run, with these exact arguments.
requires:
  - check_vulnerabilities(name=boto3, version=1.43.93)
  - check_vulnerabilities(name=strands-agents, version=1.55.1)
  - check_vulnerabilities(name=strands-agents-tools, version=0.8.8)
  - get_package_info(name=boto3)
  - get_package_info(name=strands-agents)
  - get_package_info(name=strands-agents-tools)
  - read_manifest(url=file:///.../requirements.txt)

# Called in SOME runs but not all. Present or absent, both PASS.
permits: []

# Happens-before edges present in every recorded run (dependency-aware -- reuses
# gate_compare.py's own edge logic, aggregated to tool-name granularity).
order:
  - get_package_info -> check_vulnerabilities
  - read_manifest -> check_vulnerabilities
  - read_manifest -> get_package_info

# Always empty on generation -- add constraints the recording alone cannot infer.
forbids: []

runs: 3
```

Now gate the agent against it:

```
agent-replay test vulnerable-dependency
```

Every run makes a real model call (the model is never made deterministic -- see "Honesty" below) with
tool outputs injected from the recordings, and reports PASS or FAIL with exit 0 or 1.

Break it deliberately:

```
agent-replay gate vulnerable-dependency --prompt "You are a dependency security auditor. Read the manifest
and use your own judgment about which packages, if any, are worth checking. You do not need to check
every pinned package. ..."
```

```
=== vulnerable-dependency: FAIL ===
first divergence: step 6  MISSING_STEP  check_vulnerabilities  [ATTRIBUTABLE]
  required but never called
...
```

The loosened prompt makes the agent stop checking two of the three packages. The gate catches it as a
missing `requires` entry, and the contract diff a reviewer would see for that regression is exactly this
small:

```diff
 requires:
   - check_vulnerabilities(name=boto3, version=1.43.93)
-  - check_vulnerabilities(name=strands-agents, version=1.55.1)
-  - check_vulnerabilities(name=strands-agents-tools, version=0.8.8)
   - get_package_info(name=boto3)
-  - get_package_info(name=strands-agents)
-  - get_package_info(name=strands-agents-tools)
   - read_manifest(url=file:///.../requirements.txt)
```

## Commands

```
agent-replay init                                    # interactive project setup
agent-replay record <scenario> [--runs N] [--storage local|aws]
agent-replay test [<scenario>] [--model <id>] [--json] [--format junit]
agent-replay replay <scenario> [--run-id <id>]        # zero-network, byte-identical replay proof
agent-replay gate   <scenario> [--prompt ...] [--mutate TOOL:JSON] [--model-id <id>] [--strict]
```

`test` is the CI gate: no prompt override, evaluates the scenario's own recorded input against its
contract, exits 0/1. `gate` is for ad hoc "what if" exploration -- override the system prompt or mutate an
injected tool result for one run, against the same contract, without touching what `test` enforces.
`--json` on `test`/`gate` puts machine-readable JSON on stdout and moves the human report to stderr;
`--format junit` (on `test`) emits a JUnit XML report so it drops straight into an existing CI dashboard.

## The contract format

**requires** -- called in every recorded run, with the exact same arguments. Missing one is `MISSING_STEP`.

**permits** -- called in some runs but not all, annotated with how many (`# 3 of 5 runs`). Present or
absent, both PASS: this is where legitimate run-to-run variation lives, so it never has to become noise in
`requires` or a silent gap.

**order** -- `a -> b` means, in every run that called both, some call to `b` consumed `a`'s output
(dependency-aware, not merely "a came first" -- reused directly from `spike/gate_compare.py`'s own
happens-before logic, aggregated to tool-name pairs since a contract spans many runs, not one). Calling `b`
with no prior `a` is `ORDER_VIOLATION`.

**forbids** -- always empty on generation. This is the one thing a recording cannot infer by itself: what
the agent must never do, regardless of what it happened to do in N sample runs. A human adds these.
Evaluated deterministically against the tool calls actually made and the results actually injected --
never by asking an LLM:

```
<tool> when <other_tool>.<field> == <value>
<tool> called more than <n> times
<tool> called more than <n> times per <argument_name>
```

```yaml
forbids:
  - issue_refund when lookup_order.refund_eligible == false
```

A call that matches neither `requires` nor `permits` is `UNRECORDED` (or `UNSOURCED_ARGUMENT` if its
arguments trace to nothing the model was ever shown -- a fabricated value, not merely an unexpected call).
The **attribution boundary** is the step of the first such call: everything at or before it is attributable
to whatever changed (a prompt, a mutation, a model); everything after it is not, because by then the agent
is reacting to a synthetic error it never saw while being recorded. See `docs/LIMITATIONS.md`.

## Package layout

`spike/` is left completely unmodified -- it is the proven engine (`agent.py`'s record/replay machinery,
`audit_agent.py`, `gate.py`'s injection tap, `gate_compare.py`'s comparator, `storage.py`) referenced
throughout `docs/DECISIONS.md`, and every cross-import inside it (`from agent import ...`, `from
gate_compare import ...`) already resolves purely by being run as `python spike/gate.py` -- Python puts a
script's own directory on `sys.path`. Moving those files into a package would mean rewriting every one of
those imports, which is exactly "change the comparator's matching logic / the agent" this task forbids,
and it would break the commands `docs/DECISIONS.md` and `AGENTS.md` already document
(`python spike/record.py`, `python spike/replay.py`, ...) -- so those keep working, completely unchanged.

Instead, `agent_replay/` (this installable package) is a thin orchestration layer: `agent_replay/paths.py`
inserts `spike/` onto `sys.path` at startup -- the same effect Python gives a script's own directory,
applied here for `import` instead of direct execution -- and everything downstream (`contract.py`,
`evaluate.py`, `forbids.py`, `cli.py`) imports `agent`, `audit_agent`, `gate`, `gate_compare`, `storage` by
their bare names, exactly as `gate.py` already does internally. Editable install only: `agent_replay/`
resolves `spike/` as its own parent directory's sibling, which only holds if this repo is checked out and
installed with `pip install -e .`, not `pip install` from a built wheel elsewhere. That is a real
constraint of this design, and is why local-first as specified in the task and "editable install of this
one repository" are treated as the same thing throughout this README.

## Prior art

Record-and-replay for agents is a well-explored idea -- this project does not claim to be the first. Prior
work in the same space includes **TraceFork**, **toolsnap**, **pytest-agentreplay**, **EvalView**,
**Trajectly**, and **AgentBench**. What is different here, specifically:

- **A derived, human-reviewable contract**, not a stored trace compared wholesale. Requires/permits/order
  are exact set logic over N runs, meant to be read in a pull request diff in seconds -- not a trace dump.
- **Dependency-aware ordering.** `order` is happens-before edges from actual data flow (an argument value
  traced to a prior call's output), not call position -- two independent calls in a different order is
  never a violation.
- **The attribution boundary.** A regression is only pinned on the change under test up to the first call
  the harness could not match; past that point the agent is reacting to synthetic data it never saw while
  being recorded, and the tool says so explicitly instead of reporting a false confidence.
- **Deterministic `forbids` rules**, evaluated against the exact recorded data injected during the run --
  no LLM-as-judge anywhere in the gate.

A precise comparison is more useful here than a novelty claim, so read the above as "this is what's
actually new," not "nothing like this existed."

## AWS and CI

`--storage aws` persists recordings to the deployed stack (`infra/template.yaml`: a DynamoDB index plus a
content-addressed S3 bucket) instead of `traces/*.json`. Same commands, same contracts, just
`--storage aws` on `record`/`test`/`gate`/`replay`. Wire the gate into CI with:

```
agent-replay test --json --format junit --junit-out report.xml
```

Exit code is 0 on PASS, 1 on FAIL, consistently across every subcommand that gates a run.

## Redaction

`agent-replay/scenarios.yaml` supports a top-level `redact:` list of regex patterns, applied to every
string in a recording (tool arguments, tool output, model answers) before anything is written to disk or
AWS. This is a blunt instrument, not a guarantee: a pattern that doesn't match won't redact, and one that's
too broad will over-redact. Review what a scenario actually records before trusting it with anything
genuinely sensitive.

## Honesty

Byte-identical replay by injection is not the same thing as a deterministic model. `agent-replay test` and
`agent-replay gate` make a real model call every run; only tool results are frozen. See
`docs/LIMITATIONS.md` for what this tool does and does not verify -- in particular, it checks that an
agent's tool calls match the contract, not that its decisions were correct given the data it read.
