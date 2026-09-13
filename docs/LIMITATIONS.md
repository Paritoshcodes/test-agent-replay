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
