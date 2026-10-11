# Enforcement agent

This file is a plan for the maintainers, not a task for readers.

Not built yet. This directory will hold the agent that applies `CONSTITUTION.md` and `LAWS.md` to pull requests, and the replay tool that recomputes `ledger/state.json` from `ledger/events.jsonl`. `PROTOCOL.md` describes the payment and voting protocol as planned.

Planned parts, in build order:

1. Layer detection from touched paths, applying Constitution Article 2 directly, with Law 6 path rules.
2. Intake checks: sign-off, size, allowed file types, symlinks, submodules, zero-file changes, Constitution-layer touches.
3. Legal-floor screen, before any quote, with hold-only output.
4. Fee quote and x402 payment verification against the Base network, with the pull request number bound in the payment payload.
5. Vote collection from pull request reviews, filtered to the qualified-voter set recorded at open.
6. Tally: window, yes-quorum, capped weight majority, verifiable random tie-break.
7. Ledger writer with signed entries, and state recomputation.
8. Decay, maturity, inactivity, and the base-fee control loop.
9. Owner commands: confirm, reject, resolve hold, takedown, patch, declare, rotate destination, maintenance window, deploy record. Each recorded.
10. Replay tool, with test vectors for the tie-break and the decay arithmetic.
11. Ledger-head anchoring on Base at each fee adjustment.

Design commitments. Changing any of these is a Laws vote, and some are fixed by the Constitution:

- Any model used for the legal-floor screen receives content as data, never as instructions, and its only possible outputs are "pass" and "hold for review". A hold goes to the owner. Nothing a model says can cause a merge. See `LAWS.md` Law 10.
- Vote windows, fee adjustments and decay are computed from ledger timestamps and platform review timestamps, never from when the agent happened to run.
- Accounts are keyed by the platform's immutable numeric id; login names are recorded but never used as keys.
- The agent is a platform app with short-lived installation tokens and the minimum permissions needed. Secrets live only in the hosting environment's secret store. The agent never runs from this repository's own automation.
- On start, the agent validates `laws.json` against `laws.schema.json` and against the Article 9A minimums hardcoded from the Constitution. If either fails, it records the refusal and continues under the last compliant version.
- Third-party scripts loaded by anything under `site/` are pinned by version and by integrity hash.
