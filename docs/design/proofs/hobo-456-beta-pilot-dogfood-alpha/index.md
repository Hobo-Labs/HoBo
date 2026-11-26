# HOBO-456 Beta Pilot Dogfood/Alpha Evidence Proof

HOBO-456 is proven by the focused M1 contract at
[`src/draft/exp-proofs/cx/beta-pilot-dogfood-alpha-evidence-contract`](../../../../src/draft/exp-proofs/cx/beta-pilot-dogfood-alpha-evidence-contract/README.md)
and the durable scope record at [beta-pilot-feedback.md](../../beta-pilot-feedback.md).

## Acceptance Evidence

- Required M1 dogfood/alpha evidence is listed and mapped to owner projects.
- Blockers and accepted risks route through cutline, support, product UX, docs,
  or capability owners.
- Cross-project dependencies are reflected in the release cutline map.
- Follow-up issues are allowed only for missing accepted evidence, owner
  blockers, or scope changes.
- Parent initiative status updates are required when the evidence gate changes
  launch risk; this proof records no launch-risk delta.

## Negative Coverage

- Follow-up validation rejects broad backlog creation without a missing evidence
  gap.
- Launch-risk validation rejects a changed risk delta unless the parent
  initiative status update is required.
- Scope notes keep customer onboarding, general feedback portal work, and beta
  blocker resolution outside this issue.

## Verification

```powershell
pnpm --dir src\draft\exp-proofs\beta-pilot-dogfood-alpha-evidence-contract test
```
