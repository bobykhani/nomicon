# Runbook

How the enforcement agent is run, kept alive, backed up and handed over. This file is for whoever operates the agent; the Constitution's continuity article assumes it exists and is accurate.

## What runs where

One small server runs two processes: the agent (Node, `node dist/cli.js run`) and Caddy, which terminates TLS at the public address and forwards to the agent. Everything the agent needs on disk lives under `/srv/nomicon`:

| path | holds | backed up |
|---|---|---|
| `/srv/nomicon/repo` | a clone of the repository; the agent writes `ledger/events.jsonl` here and publishes it to GitHub every tick | yes |
| `/srv/nomicon/private` | `doorbells.json`, the registered doorbell addresses and the delivery cursor | yes |
| `/srv/nomicon/secrets` | `ledger.pem` (ledger signing key), `github-app.pem` (App key), `agent.env` (all other secrets), mode 600, owner root | yes, encrypted, off the box |

The public GitHub copy of `ledger/` is the source of truth for the ledger. The server copy is a working copy. Doorbell addresses and the two keys exist nowhere else, which is why they are backed up.

## First install

1. **Server.** A 2 vCPU, 4 GB Linux VPS with a static address is enough for years. Prefer a Canadian region (for example OVH Beauharnois) so the privacy notice can say the data stays in Canada. Ubuntu LTS, unattended security updates on, SSH keys only, firewall allowing 22, 80, 443.
2. **Clock.** Ledger timestamps come from this machine. Keep `systemd-timesyncd` or `chrony` active.
3. **DNS.** An A record for the agent's name (for example `agent.<domain>`) to the server. Caddy obtains the certificate itself once the record resolves.
4. **Docker.** Install Docker Engine with the compose plugin.
5. **Layout.** `mkdir -p /srv/nomicon/{repo,private,secrets}`; `chmod 700 /srv/nomicon/secrets`.
6. **Code.** `git clone https://github.com/nomicon-world/nomicon /srv/nomicon/repo`. The compose file builds the agent image from `/srv/nomicon/repo/agent`.
7. **Keys.** `cd /srv/nomicon/repo/agent && docker compose -f deploy/docker-compose.yml run --rm --no-deps agent node dist/cli.js keygen` prints a private and a public key. Save the private key as `/srv/nomicon/secrets/ledger.pem`; the public key goes into `CONSTITUTION.md` Article 11 and `ledger/public-key.pem`. Put the GitHub App key at `/srv/nomicon/secrets/github-app.pem` (see `GITHUB-APP.md`).
8. **Environment.** Copy `deploy/agent.env.example` to `/srv/nomicon/secrets/agent.env` and fill it. `NOMICON_DOMAIN=<the DNS name>` goes in `/srv/nomicon/repo/agent/deploy/.env` for Caddy.
9. **Genesis.** With the Constitution placeholders filled and committed: `docker compose -f deploy/docker-compose.yml run --rm --no-deps agent node dist/cli.js genesis <head commit sha>`. This writes the first two ledger events. There is no second genesis.
10. **Start.** `docker compose -f deploy/docker-compose.yml up -d --build`. Within a minute `https://<name>/` answers with the endpoint list and the log shows `github identity: nomicon-agent[bot] (...)` and `laws ... in force`.

## Day to day

- **Logs:** `docker compose -f deploy/docker-compose.yml logs -f agent`. Every tick that fails logs `tick failed:` with the reason; one failure is noise, a run of them is an outage.
- **Health:** `GET /` on the public address returns JSON. The digest appears every seven days; its absence means the agent has been down or the App lost the Discussions permission.
- **Owner commands** (`confirm`, `reject`, `release`, `hold-reject`, `takedown`, `rotate-destination`, `maintenance`, `end-bootstrap`, `amend-laws`) run on the server with the same environment: `docker compose -f deploy/docker-compose.yml exec agent node dist/cli.js confirm 12 "reason"`. They append to the ledger under a lock; the running agent picks the event up on its next tick.
- **Verifying:** `docker compose ... exec agent node dist/cli.js replay` recomputes everything from the ledger and checks every signature. Run it after any manual intervention.

## Outages

The agent is designed to be stopped. Quotes carry their expiry, votes carry their close time, and the agent catches up on everything when it returns; Law 5 extends quote validity by recorded outages. A payment made while the agent is down is matched when it comes back. Nothing needs to happen quickly except two things: the facilitator settling a payment (the payer retries) and a hold the owner must resolve within 14 days.

If the facilitator is down, payments fail on the payer's side and nothing is recorded; the quote stays valid until its expiry. If GitHub is down, ticks fail and resume. If the Base RPC is down, closes that need a tie-break block wait; everything else proceeds.

## Upgrading the agent

Code under `agent/` is Laws-layer. A change reaches the server only after it merged by the Laws procedure (or, during bootstrap, an owner amendment) and the fourteen days Constitution Article 8 requires have passed, with replay clean on the new commit, then: `git -C /srv/nomicon/repo pull`, `docker compose ... up -d --build`, and `node dist/cli.js deploy <commit> "<reason>"` to record the deployment in the ledger. An owner `patch` under Article 8, which may only make the code match the written rules, follows the same steps and records a `patch` event instead. Before either, run the simulation on the new commit: `npm run sim`.

## Backups

Nightly, to a different machine or an encrypted bucket: `/srv/nomicon/private`, `/srv/nomicon/secrets` (encrypted with a key held by the owner), and `/srv/nomicon/repo/ledger`. Test a restore once: a fresh server, restore the three paths, `git pull`, `replay`, start.

The Constitution names one ledger signing key and provides no way to replace it, so losing `ledger.pem` means the ledger cannot be continued under the rules as written. Keep two encrypted copies in two places. Loss of `github-app.pem` means generating a new key on the App's page; loss of `doorbells.json` means every doorbell goes silent until accounts re-register, which the next digest should tell them.

## Handing over

Continuity under Constitution Article 14 means a successor operator can run the agent from this file, the repository, and the backups, with nothing that lived only in the previous operator's head. Keep this file true.

## Going to mainnet

Everything above is network-neutral; these are the differences between the test network and Base mainnet, and `nomicon check` verifies each of them against the live services without moving money.

1. **Facilitator.** The public `x402.org` facilitator settles test networks only. Base mainnet settles through Coinbase's facilitator: create a CDP account and an API key at the Coinbase Developer Platform portal, put the id and secret in `agent.env` as `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET`, and remove `X402_FACILITATOR_URL`. The first 1,000 settlements a month are free, then $0.001 each. Verification is free. The agent refuses to start on mainnet with a testnet-only facilitator.
2. **RPC.** `https://mainnet.base.org` works but is rate-limited and shared. A free-tier endpoint from a provider is steadier.
3. **Destination.** `NOMICON_FEE_DESTINATION` is the wallet in Constitution Article 7, custodied by the corporation. Any address that can receive a plain USDC transfer works; a hardware wallet is fine, since the agent never spends from it. Enter it in `CONSTITUTION.md` before genesis; after genesis it changes only through `rotate-destination`.
4. **Anchoring.** Article 11 anchors the ledger head on Base at every fee adjustment, four times a day. `ANCHOR_PRIVATE_KEY` is a separate, low-value wallet holding a little ETH on Base for gas, roughly a cent a day. It is required on mainnet; `check` fails without it or with an empty balance.
5. **Exchange rate.** Law 5 records the Canadian-dollar value of each payment. Unset `NOMICON_USDC_CAD` and the agent uses the Bank of Canada's daily USD/CAD average, cached twelve hours, falling back to a fixed rate if the feed is down. The rate used is written into each payment event.
6. **Addresses and switches.** The public URL must be `https`, and `NOMICON_DOORBELL_ALLOW_PRIVATE` must be unset; `check` fails on either.
7. **Run `nomicon check`** before genesis and after every configuration change. It prints one line per check and exits non-zero on any failure.
