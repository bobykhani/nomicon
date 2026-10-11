# Enforcement agent

This file is a plan and a manual for the maintainers, not a task for readers.

The agent applies `CONSTITUTION.md` and `LAWS.md` to pull requests and writes `ledger/`. It runs on the owner's infrastructure and never from this repository's own automation. Source is TypeScript under `src/`; tests under `test/`.

## Status

Built and tested against in-memory adapters: layer detection and path rules, intake, quotes and the fee control loop, weight arithmetic with decay, maturity, inactivity and the per-account cap, vote tally with the verifiable tie-break, the signed ledger, state folding, replay, the runtime state machine (including bootstrap, withdrawal, expiry, held fees, holds, quote lapse), the x402 payment endpoint, and the owner commands.

Not yet exercised against real services: the GitHub adapter, the Base adapter, the x402 facilitator, and the Claude screen. Those are the first things the internal simulation runs against a throwaway repository and the Base Sepolia test network.

## Layout

| Path | What |
|---|---|
| `src/constitution.ts` | Values the Constitution fixes: layer lists, Article 9A minimums. Hardcoded on purpose. |
| `src/laws.ts` | Loads `laws.json`, validates it against the schema and Article 9A, refuses otherwise. |
| `src/paths.ts`, `src/intake.ts` | Law 6 and Law 8: layer of a change, path rules, intake checks. |
| `src/fee.ts` | Law 5: quotes and the base-fee loop. |
| `src/weight.ts` | Law 4 and Law 11: decay, maturity, inactivity, cap, in integer micro-USDC. |
| `src/tally.ts` | Laws 2, 3 and 11: counting a vote, the tie-break bit. |
| `src/ledger.ts`, `src/state.ts`, `src/replay.ts` | Article 11 and Article 8: signed append-only events, state folding, replay. |
| `src/screen.ts` | Law 10: deterministic checks, then a model that can only pass or hold. |
| `src/pay.ts` | The x402 payment endpoint, `POST /pay/{pr}`. |
| `src/phases.ts`, `src/runtime.ts` | Where each pull request stands, and one `tick()` that applies the rules. |
| `src/adapters/` | GitHub (Octokit), Base (viem), and in-memory mocks for tests and simulation. |
| `src/cli.ts` | `nomicon` commands, including every owner command. |

## Running

```bash
cd agent && npm install && npm run build && npm test
```

Create the ledger signing key once and keep the private half only in the hosting environment's secret store:

```bash
node dist/cli.js keygen
```

Environment variables, all required unless noted:

| Variable | Meaning |
|---|---|
| `NOMICON_REPO_ROOT` | Local checkout of the repository (ledger is written here, then published). |
| `NOMICON_LEDGER_KEY` | PKCS8 PEM of the ed25519 ledger key, or a path to it. |
| `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO` | The agent's platform credentials and the repository. |
| `NOMICON_NETWORK` | `eip155:8453` (Base) or `eip155:84532` (Base Sepolia). |
| `BASE_RPC_URL` | RPC endpoint for that network. |
| `ANCHOR_PRIVATE_KEY` | Optional. Key of a wallet that anchors the ledger head on the chain at each fee adjustment. |
| `X402_FACILITATOR_URL` | Optional. Defaults to `https://x402.org/facilitator`. |
| `NOMICON_PUBLIC_URL`, `NOMICON_PORT` | Where the payment endpoint is reachable, and the port it listens on. |
| `ANTHROPIC_API_KEY` | For the screening model. |
| `NOMICON_OWNER_ACCOUNTS`, `NOMICON_AGENT_ACCOUNT` | Numeric platform ids. |
| `NOMICON_FEE_DESTINATION`, `NOMICON_HEAD_COMMIT` | For `genesis`. |
| `NOMICON_TICK_SECONDS` | Optional. Poll interval, default 60. |

First public commit, once and only once:

```bash
node dist/cli.js genesis <head commit sha>
```

Then:

```bash
node dist/cli.js run
```

Owner commands write to the local ledger; the running agent publishes them on its next tick. `node dist/cli.js` with no arguments lists them. `node dist/cli.js replay` recomputes every tally and reports any difference.

## Design commitments

Changing any of these is a Laws vote, and some are fixed by the Constitution:

- Any model used for the legal-floor screen receives content as data inside document blocks, never as instructions, and its only possible outputs are "pass" and "hold for review". A hold goes to the owner. A refusal by the model is a hold. Nothing a model says can cause a merge. See `LAWS.md` Law 10.
- Vote windows, fee adjustments and decay are computed from ledger timestamps and platform review timestamps, never from when the agent happened to run.
- Accounts are keyed by the platform's immutable numeric id; login names are recorded but never used as keys.
- The agent is a platform app with short-lived installation tokens and the minimum permissions needed. Secrets live only in the hosting environment's secret store. The agent never runs from this repository's own automation.
- On start and on every tick, the agent validates `laws.json` against `laws.schema.json` and against the Article 9A minimums hardcoded from the Constitution. If either fails, it records the refusal and continues under the last compliant version.
- Third-party scripts loaded by anything under `site/` are pinned by version and by integrity hash.
- During bootstrap every closed vote waits for the owner, whatever the tally says, and the owner's confirmation alone merges and mints weight (Article 3).
