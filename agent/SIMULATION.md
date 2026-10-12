# Simulation report

Generated 2026-10-12 by `npm run sim`. 24 scenarios, 130 claims, 0 failed. Each scenario runs the real agent runtime against in-memory GitHub and chain adapters on a fake clock, and ends by replaying its own signed ledger.

## honest-flow

Five founders are seeded during bootstrap. After bootstrap ends and their weight matures, a newcomer passes with three yes votes and is merged.

157 ledger events, 15274 ms.

- pass: with nobody qualified to vote, the first founder's vote closed the moment it opened (Law 9)
- pass: five founders hold mature weight after 31 days
- pass: newcomer merged
- pass: tally recorded merge with three yes voters
- pass: newcomer's weight is immature right after merge
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## sybil-bloc

Three attacker accounts get merged by honest votes, then approve each other. Immature weight does not qualify; after maturity two yes votes still miss the quorum of three. A fourth attacker reaches quorum but honest voters outweigh it.

300 ledger events, 36085 ms.

- pass: x1 merged by honest votes
- pass: x2 merged by honest votes
- pass: x3 merged by honest votes
- pass: x4 merged by honest votes
- pass: bloc accounts are not qualified voters while their weight is immature
- pass: bloc self-approval expires for lack of quorum
- pass: after maturity, two bloc yes votes still fail the quorum of three
- pass: three bloc yes votes meet quorum but four honest no votes outweigh them
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies
- note: three bloc yes (2531339) against four honest no (2832792): reject

## whale-cap

One account with ten merges against four accounts with one each. Its weight is capped to 20 percent of the total mature weight, so it cannot veto.

334 ledger events, 57880 ms.

- pass: whale's no vote counts for at most a fifth of all mature weight
- pass: four honest yes votes beat the capped whale
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies
- note: whale holds 8393410 of 11371066 micro-USDC mature weight (73.8 percent)

## size-and-overpayment-mint-no-weight

A 200 kB file is quoted base plus size charge, and the submitter pays ten times the quote. The merge mints only the base fee as weight.

118 ledger events, 7112 ms.

- pass: 200 kB file is quoted base plus 192 kB of size charge
- pass: weight minted equals the base fee only, despite the size charge and the overpayment
- pass: overpayment recorded as matched and not refunded
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## bait-and-switch

A submitter collects a yes vote, then pushes a new commit. The vote is void, the submission is withdrawn, and the fee is forfeit because a vote had been cast.

101 ledger events, 5621 ms.

- pass: push after a vote was cast is a withdrawal with the fee forfeit
- pass: no held fee was created
- pass: pull request closed
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## withdrawal-before-any-vote

A submitter closes the pull request after paying but before anyone votes. The fee is held for resubmission.

101 ledger events, 5684 ms.

- pass: closing before any vote holds the fee
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## fee-pump

Ten attacker accounts open three paid submissions a day for twelve days with nobody voting. The base fee rises to its cap of ten times the floor, concurrency pricing makes the flood expensive, and the fee falls back within a week of the flood stopping.

1975 ledger events, 307533 ms.

- pass: base fee reaches the cap of ten times the floor
- pass: base fee never exceeds the cap
- pass: the flood cost the attackers more than 10,000 USDC
- pass: base fee returns to the floor within a week of the flood stopping
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies
- note: attackers spent 137761 USDC over 12 days; peak base fee 10 USDC

## protected-paths

Changes that touch the Constitution, the ledger, owner files, a workflow, a case-colliding filename, a symbolic link or a non-ASCII path are rejected at intake with no fee. A README change is quoted at the Laws multiplier.

105 ledger events, 5431 ms.

- pass: editing CONSTITUTION.md is rejected at intake with no quote
- pass: adding Laws.json beside laws.json is rejected at intake with no quote
- pass: adding a workflow under .github is rejected at intake with no quote
- pass: writing to the ledger is rejected at intake with no quote
- pass: editing NOTICES.md is rejected at intake with no quote
- pass: a non-ASCII path is rejected at intake with no quote
- pass: an HTML file in the World is rejected at intake with no quote
- pass: a symbolic link is rejected
- pass: a README change is Laws-layer and quoted at ten times the base
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## laws-capture-attempt

Three mature attacker accounts submit a laws.json that sets the World quorum to one and the window to one hour. The Laws quorum of five defeats it. Even if such a file reached the ledger as a snapshot, the agent refuses it under Article 9A and keeps the rules in force.

236 ledger events, 24325 ms.

- pass: a Laws change is quoted at ten times the base
- pass: Laws vote window is 168 hours
- pass: two bloc yes votes fail the Laws quorum of five
- pass: agent records a refusal for the non-compliant snapshot
- pass: rules in force are unchanged: the next World vote still has a 72-hour window
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## laws-change-takes-effect-after-delay

Five founders pass a Laws change that makes the World window 96 hours. It takes effect 14 days after merging; a vote opened before then keeps 72 hours, one opened after gets 96.

201 ledger events, 15529 ms.

- pass: Laws change with five yes votes merges
- pass: snapshot takes effect 14 days after the merge
- pass: a vote opened before the effective time keeps the 72-hour window
- pass: a vote opened after the effective time gets the 96-hour window
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## illegal-content-holds

Content the screen flags is held with no fee. The owner rejects one hold and bars the author; a second hold times out after 14 days; a third is released by the owner and proceeds to a quote without a second screen.

122 ledger events, 6392 ms.

- pass: flagged content is held with no quote
- pass: hold rejected by the owner closes the pull request
- pass: the barred author's next submission is rejected at intake
- pass: an unresolved hold times out and closes without charge
- pass: a released hold is quoted without being screened again
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## apathy-and-held-fee

Nobody votes on a newcomer's submission. It expires with the fee held, the held fee covers a resubmission, and after 90 days an unused held fee is forfeit.

237 ledger events, 19681 ms.

- pass: no votes: expired with the fee held
- pass: resubmission is covered by the held fee with nothing to pay
- pass: the second expiry keeps a held fee on the account
- pass: held fees are forfeit after 90 days
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## bootstrap-owner-decisions

During bootstrap a passing tally waits for the owner. A rejection after a pass holds the fee, and thirty days of owner silence expires a submission with the fee held.

174 ledger events, 10331 ms.

- pass: a passing tally waits for the owner during bootstrap
- pass: owner rejection after a passing vote holds the fee (Article 3)
- pass: pull request closed and not merged
- pass: thirty days of owner silence after close expires the submission with the fee held
- pass: a confirmation that arrives after the expiry is stale and changes nothing
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## tamper-detection

After an honest flow, a copy of the ledger with one merge's weight altered fails both the signature check and the arithmetic replay.

118 ledger events, 6116 ms.

- pass: baseline merge
- pass: tampered ledger is detected
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## questions-and-mentions

A merged file asks a question; a later merged file answers it and cites a third. The index records the question as open then answered, and the agent mentions the asker and the cited author, never the answerer.

163 ledger events, 9956 ms.

- pass: the question is indexed as open after merge
- pass: cited entry merged
- pass: answer merged
- pass: the question moved from open to answered
- pass: asker and cited author were mentioned, the answerer was not
- pass: the mention comment names the asker
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## mention-cap

A merge citing thirty entries by thirty authors mentions at most ten of them.

772 ledger events, 224943 ms.

- pass: exactly ten mentions were sent
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## doorbell

An account registers a doorbell by commenting on the doorbell issue. It receives signed deliveries for events that concern it and nothing for events that do not. A dead doorbell is retired after repeated failures and the account is told by mention.

210 ledger events, 22269 ms.

- pass: registration recorded as a channel event with a hash, not the URL
- pass: the newcomer's doorbell received its quote, vote open, close and merge
- pass: every delivery carries the ledger signature
- pass: deliveries were recorded as notices
- pass: another account's submission was not delivered to the newcomer's doorbell
- pass: a doorbell that keeps failing is retired
- pass: the account was told by mention on the doorbell issue
- pass: posting the address again re-registers it
- pass: a plain-http or private address is refused, recorded, and the account told
- pass: nothing is ever delivered to a refused address
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## digest-and-watchers

After seven days the agent posts a digest listing the week's merges and open questions, and records who watches the repository.

136 ledger events, 9188 ms.

- pass: at least one digest was posted after a week
- pass: the digest lists the open question
- pass: the digest is recorded in the ledger
- pass: the watcher was recorded as a channel
- pass: a failed digest post is not recorded and does not stop the agent
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies
- note: log: digest not posted: discussions are not enabled
- note: log: digest not posted: discussions are not enabled
- note: log: digest not posted: discussions are not enabled
- note: log: digest not posted: discussions are not enabled

## tie-expires

Six founders merged in the same instant hold identical weight. Three vote yes and three vote no: equal weight is no decision, so the contribution expires with the fee held and nothing outside the ledger is consulted.

98 ledger events, 7743 ms.

- pass: the six founders hold identical mature weight
- pass: the tally records an exact tie and expiry
- pass: the fee is held for resubmission, nothing merged
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## intake-recheck-at-close

Two approved submissions add world/Foo.md and world/foo.md. Both passed intake at quote time; at close the second is checked again against the main the first changed and expires for the case collision Law 6 forbids.

126 ledger events, 7248 ms.

- pass: the first merged
- pass: the second expired at close for the collision, fee held
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## close-order

Two approved submissions add the same path and their windows close in the same tick. The platform lists the newer first; the agent settles the older first, so it merges and the newer expires as unmergeable.

126 ledger events, 7355 ms.

- pass: the older submission merged
- pass: the newer one expired with its fee held
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## crash-recovery

GitHub performs a merge but the agent dies before recording it; later a merge call fails before GitHub performed it. After each, the next tick leaves the ledger explaining the repository: one merge event, weight minted once.

137 ledger events, 9159 ms.

- pass: the tick that lost the merge response failed after GitHub merged
- pass: the next tick recorded the merge GitHub had already made, exactly once, with its commit
- pass: the tick whose merge call failed recorded no merge
- pass: the next tick retried and merged, once
- pass: both authors hold weight
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## screen-spam

One account opens seven submissions and pays for none. Five are screened; two wait without being screened or touching the platform, commented on once. Paying one quote frees a place; a day later the rest are screened. Quotes that lapse and renew reuse the earlier pass instead of screening the same content again.

122 ledger events, 9623 ms.

- pass: five submissions were screened and quoted
- pass: the other two wait, each recorded and commented on once
- pass: waiting submissions are not screened again or re-commented on later ticks
- pass: paying one quote frees a place and one waiting submission is screened
- pass: a day later the last waiting submission is screened
- pass: lapsed quotes were renewed without screening the same content again
- pass: another account is unaffected by this account's limit
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## screen-budget

Thirty-six accounts that never paid each open a 1 MB submission in one tick, after one of them already used its 4 MB. Only the newcomers' half of the 32 MB daily budget is screened; the rest wait. A founder who has paid is still screened. A day later the freed budget screens sixteen more, and the remainder the day after.

222 ledger events, 26699 ms.

- pass: one account is screened up to 4 MB a day and its fifth submission waits
- pass: newcomers get the remaining 12 MB of their 16 MB half; the other 24 wait on the global budget
- pass: an account that has paid before is still screened from the reserved half
- pass: a day later the freed budget screens sixteen more
- pass: and the rest the day after, nothing screened twice
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies
