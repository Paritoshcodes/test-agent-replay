# Decisions log

Append one line per decision. Never edit or delete existing lines.
Format: YYYY-MM-DD | initials | decision

2026-09-13 | PS | Spike scope frozen: prove model-response interception and injection only.
2026-09-13 | PS | Bedrock preflight passed. ap-south-1 requires inference profile ID apac.amazon.nova-lite-v1:0; bare model ID rejected with ValidationException.
2026-09-13 | PS | Observed Nova at temperature 0 return "Preflight OK" when asked for exactly "preflight ok". Confirms hosted inference is not reproducible. Injection is the only defensible determinism claim.