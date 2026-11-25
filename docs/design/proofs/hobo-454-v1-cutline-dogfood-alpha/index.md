# HOBO-454 V1 Cutline Dogfood/Alpha Proof

HOBO-454 is proven by the focused M1 contract at
[`src/draft/technical-proofs/v1-cutline-contract`](../../../../src/draft/technical-proofs/v1-cutline-contract/README.md).

## Acceptance Evidence

- The required M1 evidence IDs cover the cutline baseline, dogfood/alpha outcome,
  blocker delta, accepted-risk register, and cross-project handoff.
- Each evidence item maps to an owning project and source record.
- Blockers, accepted risks, release-note/support/legal/launch-message dependencies, and missing
  beta evidence are recorded in the cutline proof.
- Follow-up issues are allowed only for missing evidence; this proof points beta evidence to the
  existing HOBO-463 private-beta issue rather than creating duplicate work.
- Parent release-readiness sync is required when this gate changes launch risk.

## Negative Coverage

- Pending evidence cannot pass the M1 gate.
- Speculative follow-ups against accepted evidence are rejected.
- A launch-risk change without parent status sync is rejected.
- Dogfood/alpha evidence is not promoted to beta, release-candidate, or GA proof.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\v1-cutline-contract test
```
