# Launch Site Private Beta Evidence Contract

HOBO-465 proves the M2 private beta evidence gate for V1 Launch Site, Messaging & Demo Assets.

This package records a machine-checkable private-beta launch messaging and demo-asset evidence
contract. It consumes the accepted M0 claim register and golden-path demo records, then proves that
private beta launch assets have owners, evidence sources, refresh triggers, blockers, accepted risks,
cross-project dependencies, and release-readiness sync.

## Acceptance

- Required evidence is listed and mapped to owning projects.
- Blockers and accepted risks are recorded.
- Cross-project dependencies are reflected in the release cutline.
- Follow-up execution issues are allowed only where evidence is missing.
- Parent release-readiness status sync is required when this gate changes launch risk.

## Negative Coverage

- Pending required evidence fails the private beta gate.
- Demo assets without owners, proof modes, source evidence, or refresh triggers fail.
- Private beta evidence cannot promote public, release-candidate, or GA launch claims.
- Speculative follow-ups against accepted evidence fail.
- Unsynced launch-risk changes fail.

## Files

- `src/launch-site-private-beta-evidence.ts` exports the contract plus validation helpers.
- `test/launch-site-private-beta-evidence.test.ts` is the executable acceptance and negative proof.
- `architecture/` carries the protobuf, CUE, and Pact evidence required by the repo architecture guard.
- [`../../../../../docs/design/proofs/hobo-465-launch-site-private-beta/README.md`](../../../../../docs/design/proofs/hobo-465-launch-site-private-beta/README.md)
  summarizes branch evidence.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\cx\launch-site-private-beta-evidence-contract test
```

## Scope Boundary

This proof does not build the launch site, publish final copy, create polished screenshots or videos,
provision live cloud resources, or turn private beta evidence into release-candidate or GA evidence.
