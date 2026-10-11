# Simulation report

Generated 2026-10-11 by `npm run sim`. 14 scenarios, 73 claims, 0 failed. Each scenario runs the real agent runtime against in-memory GitHub and chain adapters on a fake clock, and ends by replaying its own signed ledger.

## honest-flow

Five founders are seeded during bootstrap. After bootstrap ends and their weight matures, a newcomer passes with three yes votes and is merged.

150 ledger events, 7549 ms.

- pass: with nobody qualified to vote, the first founder's vote closed the moment it opened (Law 9)
- pass: five founders hold mature weight after 31 days
- pass: newcomer merged
- pass: tally recorded merge with three yes voters
- pass: newcomer's weight is immature right after merge
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## sybil-bloc

Three attacker accounts get merged by honest votes, then approve each other. Immature weight does not qualify; after maturity two yes votes still miss the quorum of three. A fourth attacker reaches quorum but honest voters outweigh it.

287 ledger events, 20632 ms.

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

323 ledger events, 30145 ms.

- pass: whale's no vote counts for at most a fifth of all mature weight
- pass: four honest yes votes beat the capped whale
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies
- note: whale holds 8393410 of 11371066 micro-USDC mature weight (73.8 percent)

## size-and-overpayment-mint-no-weight

A 200 kB file is quoted base plus size charge, and the submitter pays ten times the quote. The merge mints only the base fee as weight.

112 ledger events, 4094 ms.

- pass: 200 kB file is quoted base plus 192 kB of size charge
- pass: weight minted equals the base fee only, despite the size charge and the overpayment
- pass: overpayment recorded as matched and not refunded
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## bait-and-switch

A submitter collects a yes vote, then pushes a new commit. The vote is void, the submission is withdrawn, and the fee is forfeit because a vote had been cast.

96 ledger events, 3541 ms.

- pass: push after a vote was cast is a withdrawal with the fee forfeit
- pass: no held fee was created
- pass: pull request closed
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## withdrawal-before-any-vote

A submitter closes the pull request after paying but before anyone votes. The fee is held for resubmission.

96 ledger events, 3282 ms.

- pass: closing before any vote holds the fee
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## fee-pump

Ten attacker accounts open three paid submissions a day for twelve days with nobody voting. The base fee rises to its cap of ten times the floor, concurrency pricing makes the flood expensive, and the fee falls back within a week of the flood stopping.

1967 ledger events, 278785 ms.

- pass: base fee reaches the cap of ten times the floor
- pass: base fee never exceeds the cap
- pass: the flood cost the attackers more than 10,000 USDC
- pass: base fee returns to the floor within a week of the flood stopping
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies
- note: attackers spent 137761 USDC over 12 days; peak base fee 10 USDC

## protected-paths

Changes that touch the Constitution, the ledger, owner files, a workflow, a case-colliding filename, a symbolic link or a non-ASCII path are rejected at intake with no fee. A README change is quoted at the Laws multiplier.

100 ledger events, 3626 ms.

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

227 ledger events, 14912 ms.

- pass: a Laws change is quoted at ten times the base
- pass: Laws vote window is 168 hours
- pass: two bloc yes votes fail the Laws quorum of five
- pass: agent records a refusal for the non-compliant snapshot
- pass: rules in force are unchanged: the next World vote still has a 72-hour window
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## laws-change-takes-effect-after-delay

Five founders pass a Laws change that makes the World window 96 hours. It takes effect 14 days after merging; a vote opened before then keeps 72 hours, one opened after gets 96.

192 ledger events, 9721 ms.

- pass: Laws change with five yes votes merges
- pass: snapshot takes effect 14 days after the merge
- pass: a vote opened before the effective time keeps the 72-hour window
- pass: a vote opened after the effective time gets the 96-hour window
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## illegal-content-holds

Content the screen flags is held with no fee. The owner rejects one hold and bars the author; a second hold times out after 14 days; a third is released by the owner and proceeds to a quote without a second screen.

115 ledger events, 4465 ms.

- pass: flagged content is held with no quote
- pass: hold rejected by the owner closes the pull request
- pass: the barred author's next submission is rejected at intake
- pass: an unresolved hold times out and closes without charge
- pass: a released hold is quoted without being screened again
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## apathy-and-held-fee

Nobody votes on a newcomer's submission. It expires with the fee held, the held fee covers a resubmission, and after 90 days an unused held fee is forfeit.

218 ledger events, 11096 ms.

- pass: no votes: expired with the fee held
- pass: resubmission is covered by the held fee with nothing to pay
- pass: the second expiry keeps a held fee on the account
- pass: held fees are forfeit after 90 days
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## bootstrap-owner-decisions

During bootstrap a passing tally waits for the owner. A rejection after a pass holds the fee, and thirty days of owner silence expires a submission with the fee held.

162 ledger events, 6525 ms.

- pass: a passing tally waits for the owner during bootstrap
- pass: owner rejection after a passing vote holds the fee (Article 3)
- pass: pull request closed and not merged
- pass: thirty days of owner silence after close expires the submission with the fee held
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies

## tamper-detection

After an honest flow, a copy of the ledger with one merge's weight altered fails both the signature check and the arithmetic replay.

112 ledger events, 3991 ms.

- pass: baseline merge
- pass: tampered ledger is detected
- pass: replay of the full ledger reproduces every recorded outcome and every signature verifies
