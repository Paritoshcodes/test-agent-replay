# Agent Replay

## What this repo is

A record-and-replay engine for AI agents built on the Strands Agents SDK.
Record every model call and tool call from an agent run. Replay the run by
injecting the stored responses instead of calling the model again.

## Current phase: SPIKE

We are answering exactly one question:

Can we intercept a model response inside a Strands agent run and substitute
a stored response, so the agent loop continues as if the model had produced
it, with zero real model calls?

Nothing else is in scope. Not DynamoDB, not S3, not Lambda, not an API, not
a UI, not a diff engine, not tests beyond the spike itself.

If the whole spike exceeds roughly 250 lines of Python, it has gone out of
scope. Stop and say so.

## Environment

Windows, MINGW64 shell. Paths use backslashes on disk but forward slashes in
bash.

Activate the venv with:
    source .venv/Scripts/activate

Installed packages live in:
    .venv/Lib/site-packages/

Note: Lib not lib, Scripts not bin. This is Windows.

## Bedrock config (verified working 2026-09-13)

Region:   ap-south-1
Model ID: apac.amazon.nova-lite-v1:0

This is a cross-region inference profile ID, not a bare model ID. The bare
ID amazon.nova-lite-v1:0 returns ValidationException in ap-south-1. Use the
apac. prefixed ID verbatim in the Strands BedrockModel config.

Do not "correct" this string. It looks like a typo. It is not.

AWS credentials are already configured in the default profile. boto3 will
pick them up with no extra configuration.

## Project honesty rule

Replay works by injecting stored bytes. It does NOT make the model
deterministic.

Never write a comment, docstring, README line, print statement or log
message claiming that replay reproduces the model's output, or that the
model is deterministic, or that temperature 0 guarantees identical results.

The only correct phrasing is: byte-identical replay by injection.

Amazon Nova text models do not accept a seed parameter. Hosted inference is
not bit-for-bit reproducible even at temperature 0. Verified in practice:
asking Nova at temperature 0 to reply with exactly "preflight ok" returned
"Preflight OK". Do not build anything that assumes otherwise.

## Hard rules

- Do not add dependencies beyond requirements.txt without asking.
- Do not run `git add -A`. Stage files explicitly if asked to stage at all.
- Do not commit. The human commits.
- Do not create files outside the paths you were told to create.
- Do not refactor, reformat or "clean up" code you were not asked to change.
- Do not write to docs/DECISIONS.md except by appending one line.
- Do not silently substitute a mock model for a real one. If the real model
  is unavailable, say so.

## Commands

    source .venv/Scripts/activate
    python spike/record.py     # record a run to traces/
    python spike/replay.py     # replay it with zero real calls