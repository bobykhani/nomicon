# Ledger

The public record. Only the enforcement agent writes here. No pull request may touch this directory. Entries are signed with the key named in `CONSTITUTION.md` Article 11, and the ledger head hash is anchored on the fee network at each fee adjustment.

## events.jsonl

One JSON object per line, append-only, in order. Every object has `id` (sequential integer), `at` (UTC seconds), `type`, `sig` (signature over the canonical JSON of the object without `sig`), and type-specific fields. Formal schema in `events.schema.json`. Types:

| type | when | key fields |
|---|---|---|
| `genesis` | first event; bootstrap begins | `head`, `owner_accounts`, `owner_keys`, `agent_account`, `fee_destination`, `laws_hash` |
| `intake_reject` | failed Law 6 or Law 8 at intake, no fee | `pr`, `account`, `reasons` |
| `screen_hold` | screen held a submission | `pr`, `head`, `account`, `reason_class` |
| `quote_lapsed` | quote expired unpaid | `pr` |
| `hold_resolved` | owner released or rejected a hold | `pr`, `decision`, `reason` |
| `quote` | fee quoted | `pr`, `head`, `layer`, `fee_micro`, `base_micro`, `multiplier`, `concurrency`, `size_kb`, `terms_commit`, `destination`, `expires` |
| `payment` | payment verified | `pr`, `tx`, `block`, `block_time`, `amount_micro`, `from`, `cad_value`, `cad_rate` (USD/CAD used), `matched` |
| `vote_open` | window opened | `pr`, `head`, `opened`, `closes`, `laws_hash`, `qualified` (list of account ids) |
| `review` | a counted or superseded review | `pr`, `account`, `login`, `review_id`, `state`, `submitted` |
| `vote_close` | tally | `pr`, `yes_voters`, `yes_micro`, `no_micro`, `tie` (equal weight, no decision), `tally_result`, `result` (`merge`, `reject`, `expire`, `await_owner`) |
| `merge` | merged | `pr`, `head`, `merge_commit`, `weight_micro`, `account`, `paths`, `headers` (per path: question, answers, cites) |
| `withdrawal` | author pushed, closed or drafted after open | `pr`, `fee_disposition` |
| `expiry` | expired | `pr`, `held_until` |
| `owner_confirm` / `owner_reject` | bootstrap decision | `pr`, `reason` |
| `fee_adjust` | base fee changed | `base_micro`, `submissions_24h`, `target`, `anchor_tx` |
| `takedown` | Article 5 | `paths`, `notice_hash`, `weight_revoked` |
| `redaction` | content removed from ledger | `event_id`, `hash` |
| `patch` / `deploy` | agent code | `commit`, `reason` |
| `destination_change` | Article 7 | `destination`, `by` |
| `declare` | bootstrap end, maintenance window | `what`, `constitution_hashes` |
| `correction` | replay found an error | `event_id`, `evidence` |
| `refusal` | agent refused a non-compliant laws.json | `laws_hash`, `reason` |
| `laws_snapshot` | a laws.json version and when it takes effect | `laws_hash`, `laws_raw`, `schema_raw`, `effective_at`, `merge_commit` |
| `owner_action_applied` | agent carried out an owner decision | `pr`, `event` |
| `channel` | an account chose how to be reached | `account`, `login`, `channel` (`doorbell`, `watch`), `status` (`active`, `retired`, `off`, `refused`), `url_hash`, `reason` |
| `notice` | the agent told someone something | `kind` (`mention`, `doorbell`), `target`, `pr`, `about` (event id), `ok` |
| `digest` | weekly digest posted | `url`, `merges`, `open_votes`, `open_questions`, `active_accounts` |

## questions.json

Derived from merge events by the agent: every question asked in a merged file, who asked, when, and which merged files answered it. `open` and `answered` lists, oldest first. See `LAWS.md` Law 12.

## state.json

Recomputed from `events.jsonl` by the replay tool.

| field | meaning |
|---|---|
| `computed_at` | UTC seconds |
| `head_event` | id of the last event folded in |
| `bootstrap` | `active`, `began`, `ends_by` |
| `fee` | `base_micro`, `destination`, `last_adjusted_at` |
| `weights` | map of account id to `{login, mature_micro, immature_micro, last_vote_at}` |
| `weighted_accounts` | count of accounts with mature weight above zero |
| `open_votes` | list of `{pr, closes, laws_hash}` |
| `held_fees` | list of `{account, layer, micro, until}` |
| `deployed_agent` | commit hash |

Anyone can recompute `state.json` from `events.jsonl` and the rules with the replay tool in `agent/`. If the recomputation differs from the published state, the published state is wrong.
