# HOBO-402 Launch Blocker Taxonomy Proof

HOBO-402 is proven by the focused M0 contract at
[`src/draft/exp-proofs/cx/launch-blocker-taxonomy-contract`](../../../../src/draft/exp-proofs/cx/launch-blocker-taxonomy-contract/README.md)
and the durable design record at
[`launch-blocker-taxonomy.md`](../../launch-blocker-taxonomy.md).

## Acceptance Evidence

- Launch blocker, high-risk non-blocker, launch note, and post-GA follow-up are defined with
  go/no-go action, ship posture, evidence, and exit criteria.
- Exception requests require finding record, impact, mitigation, expiry, and an approved role.
- Dogfood, beta, support, security, legal/privacy, and upgrade findings all map into go/no-go
  decision inputs and owner projects.
- Example triage cases cover every required source and every decision class.

## Negative Coverage

- Launch blockers cannot be waived by exception.
- CI, review, security, and contract-test gates cannot be overridden.
- Scope validation rejects blocker resolution, runtime policy implementation, and merge/review
  bypasses.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\launch-blocker-taxonomy-contract test
```
