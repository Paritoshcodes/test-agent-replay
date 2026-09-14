"""Local stand-in for the dashboard API while infra/dashboard-api.yaml is blocked from deploying (see
docs/DECISIONS.md, Phase 2 -- CLI_Agent_Replay lacks apigateway:* and some iam:*RolePolicy permissions).

Runs agent_replay/lambda_handler.py's EXACT handler() function -- the real business logic, real boto3
calls against the real deployed DynamoDB table and S3 bucket -- behind a plain stdlib HTTP server instead
of API Gateway. This is not a mock: every response is real data from AWS. What it does NOT prove is that
API Gateway's own routing/CORS/Lambda-invoke wiring works, since none of those exist yet. See the task
report for exactly what remains unverified once the real infra is deployable.

    python -m agent_replay.dev_api_server [--port 8787]

Requires AGENT_REPLAY_TABLE and AGENT_REPLAY_BUCKET (or lets lambda_handler fall back -- it doesn't; unlike
spike/storage.py it requires them explicitly, see lambda_handler.py's own module docstring for why).
"""

from __future__ import annotations

import argparse
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from . import lambda_handler

_ROUTE_PATTERNS = [
    (re.compile(r"^/runs/(?P<run_id>[^/]+)$"), "/runs/{run_id}", {"run_id"}),
    (re.compile(r"^/commits/(?P<sha>[^/]+)$"), "/commits/{sha}", {"sha"}),
    (re.compile(r"^/scenarios$"), "/scenarios", set()),
    (re.compile(r"^/runs/(?P<run_id>[^/]+)/accept$"), "/runs/{run_id}/accept", {"run_id"}),
]


def _match(path: str) -> tuple[str, dict] | None:
    for pattern, route_path, _names in _ROUTE_PATTERNS:
        m = pattern.match(path)
        if m:
            return route_path, m.groupdict()
    return None


class Handler(BaseHTTPRequestHandler):
    def _dispatch(self, method: str) -> None:
        parsed = urlparse(self.path)
        matched = _match(parsed.path)
        if matched is None:
            self._send(404, {"statusCode": 404, "headers": {}, "body": json.dumps({"error": "no route"})})
            return
        route_path, params = matched
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode("utf-8") if length else None
        event = {
            "routeKey": f"{method} {route_path}",
            "pathParameters": params,
            "body": body,
            "requestContext": {"http": {"method": method}},
        }
        result = lambda_handler.handler(event, None)
        self._send(result["statusCode"], result)

    def _send(self, status: int, result: dict) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(result.get("body", "{}").encode("utf-8") if isinstance(result.get("body"), str) else json.dumps(result).encode("utf-8"))

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_OPTIONS(self) -> None:
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.end_headers()

    def log_message(self, fmt: str, *args) -> None:
        print(f"[dev-api] {self.address_string()} {fmt % args}")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8787)
    args = p.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"dev API server (real AWS data, local routing) on http://127.0.0.1:{args.port}")
    print("NOT the deployed API -- infra/dashboard-api.yaml is blocked; see docs/DECISIONS.md, Phase 2.")
    server.serve_forever()


if __name__ == "__main__":
    main()
