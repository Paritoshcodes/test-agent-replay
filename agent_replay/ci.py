"""CI provenance for a recording, read once from the environment GitHub Actions sets. Every field is None
when run locally, or on a CI system that doesn't set these -- see spike/storage.py's AwsTraceStorage.save,
which stores None as an explicit DynamoDB NULL (not by omitting the field) so a human reading an item later
can tell "ran locally" apart from "a bug read nothing", with one deliberate exception documented there.
"""

from __future__ import annotations

import json
import os


def ci_metadata() -> dict:
    pr_number = None
    event_name = os.environ.get("GITHUB_EVENT_NAME")
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    if event_name == "pull_request" and event_path:
        try:
            event = json.loads(open(event_path, encoding="utf-8").read())
            pr_number = event.get("pull_request", {}).get("number")
        except (OSError, ValueError, AttributeError):
            pr_number = None

    return {
        "commit_sha": os.environ.get("GITHUB_SHA"),
        # GITHUB_HEAD_REF is the PR's own source branch, set only for pull_request events; GITHUB_REF_NAME
        # is set for every trigger but is not a real branch name for a pull_request event (it's shaped
        # like "<pr_number>/merge") -- prefer the former when it exists.
        "branch": os.environ.get("GITHUB_HEAD_REF") or os.environ.get("GITHUB_REF_NAME"),
        "pr_number": pr_number,
        "triggered_by": os.environ.get("GITHUB_ACTOR"),
    }
