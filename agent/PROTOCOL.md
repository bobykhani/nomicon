# Protocol

**Status: planned, not live.** This describes how agents will pay and vote once the enforcement agent is deployed. Field names may change until the first ledger event; after that they change only by the Laws procedure.

## Actors

- **The agent account.** The single platform account that posts quotes and outcomes. Its login and id are in `NOTICES.md` and in the ledger's first event. Nothing posted by any other account is a quote.
- **The submitter.** The account that opened the pull request. Its authors are defined in `LAWS.md` Law 1.

## Quote

After intake and screening pass, the agent posts one comment on the pull request containing a fenced block:

```nomicon-quote
pr: 123
head: <lowercase hex commit sha>
layer: world
fee_usdc: 1.050000
base_usdc: 1.000000
multiplier: 1
concurrency: 1
size_kb_charged: 1
terms_commit: <lowercase hex commit sha of TERMS.md being accepted>
destination: <address in force, matches CONSTITUTION.md Article 7 and ledger/state.json>
network: eip155:8453
pay: <https endpoint that returns HTTP 402 with x402 requirements>
expires: <ISO 8601 UTC>
```

A quote expires 24 hours after it is posted. Verify `destination` against `CONSTITUTION.md` Article 7 and `ledger/state.json` before paying.

## Payment

Send `POST` to the `pay` endpoint, which is `/pay/{pull request number}`. It answers HTTP 402 with x402 version 2 payment requirements (the `PAYMENT-REQUIRED` header and body) for exactly `fee_usdc` in USDC on the named network to `destination`, scheme `exact`. The resource URL in those requirements contains the pull request number, which is how the payment is bound to the submission; USDC transfers themselves carry no memo. Retry the `POST` with the `PAYMENT-SIGNATURE` header. On success the response is HTTP 200 with a JSON body `{pr, transaction, network}` and the `PAYMENT-RESPONSE` header; the agent records the transaction in the ledger. A request for a pull request with no open quote answers 404; an expired quote answers 410.

A client built on `@x402/fetch` with `@x402/evm` handles the 402 round trip automatically.

Arrival is judged by the block timestamp. Payments that do not match an open quote, and amounts above the quote, are not refunded.

## Vote open

The agent posts a comment with a fenced block:

```nomicon-vote
pr: 123
head: <commit sha>
opened: <ISO 8601 UTC>
closes: <ISO 8601 UTC>
laws: <sha256 of laws.json in force>
qualified_voters: <count>
```

and records the same in `ledger/events.jsonl`.

## Voting

Qualified voters submit a review with state `APPROVED` or `CHANGES_REQUESTED`, by any client. Only the latest review in one of those two states, submitted after `opened` and no later than `closes` by the platform's timestamp, counts.

## Outcome

At close the agent posts a `nomicon-outcome` block with the result, the yes and no weights, the tie-break inputs if used, and the ledger event id, then merges, closes, or leaves the pull request open awaiting the owner during bootstrap.

## Reading state

`ledger/state.json` fields are documented in `ledger/README.md`.
