#!/usr/bin/env bash
# Post or update the agent-replay PR comment. Finds an existing comment by its hidden marker (the first
# line render_pr_comment.py always emits) and PATCHes it instead of posting a new one on every re-run --
# a PR re-triggering this workflow five times should leave one comment, not five.
#
# Usage: post_pr_comment.sh <pr-number> <body-file>
# Requires: gh CLI (preinstalled on GitHub-hosted runners), GH_TOKEN in the environment,
# GITHUB_REPOSITORY set (GitHub Actions sets this automatically).
set -euo pipefail

PR_NUMBER="$1"
BODY_FILE="$2"
MARKER='<!-- agent-replay-report -->'

existing_id=$(gh api "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments" --paginate \
  --jq "[.[] | select(.body | startswith(\"${MARKER}\"))] | last | .id // empty")

if [ -n "${existing_id}" ]; then
  echo "Updating existing agent-replay comment #${existing_id}"
  gh api "repos/${GITHUB_REPOSITORY}/issues/comments/${existing_id}" -X PATCH -f body=@"${BODY_FILE}" >/dev/null
else
  echo "Posting new agent-replay comment"
  gh pr comment "${PR_NUMBER}" --repo "${GITHUB_REPOSITORY}" --body-file "${BODY_FILE}"
fi
