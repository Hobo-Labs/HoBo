# Meta-cloud Broker Resolution Contract

Source issue: HOBO-525.

This draft package proves deterministic Meta-cloud Broker resolution without building the hosted
broker runtime. It accepts a Contract Manifest and an explicit Broker Environment snapshot, then
emits either a signed Resolution Receipt or a structured Resolution Rejection.

## What It Proves

- Same Contract Manifest plus same Broker Environment snapshot yields identical receipt or
  rejection output, even if catalog or mapping inputs arrive in a different order.
- Different Broker Environment snapshots are explicit inputs and change the receipt identity and
  digest instead of drifting silently.
- Rejection reasons are structured for ambiguous, incompatible, and unavailable mappings.
- Provider defaults are catalog inputs, not implicit broker decisions.
- Missing mappings never fall back to Yard-local matching.

## Acceptance Mapping

| HOBO-525 acceptance | Proof |
|---|---|
| Same manifest plus same broker environment yields identical receipt or rejection output. | `broker-resolution.test.ts` resolves an accepted fixture twice with reversed mapping/catalog order and asserts deep equality. |
| Different broker snapshots are explicit inputs and cannot drift silently. | The snapshot-drift test changes `environmentDigest`, `catalogSnapshotDigest`, and `snapshotId` and asserts a different receipt identity and digest. |
| Rejection reasons are structured and actionable. | The rejection test asserts `mapping.ambiguous`, `mapping.incompatible`, and `mapping.unavailable` reason codes plus replay inputs. |

## Adversarial Coverage

- Catalog-order nondeterminism is refused through deterministic ambiguous-mapping rejection.
- Implicit provider defaults are refused unless an approved broker mapping names them.
- Yard-local matching fallback is never invoked from broker resolution.

## Architecture Evidence

- `ADR.md` records the parse boundary, command/event/actor/projection vocabulary, and
  scope boundaries.
- `architecture/meta_cloud_broker_resolution.proto` pins the protobuf data contract.
- `architecture/meta_cloud_broker_resolution.cue` pins CUE constraints for the protobuf types.
- `architecture/pacts/meta_cloud_broker_resolution.pact.json` records consumer/provider expectations
  for receipt and rejection outcomes.

## Verification

```powershell
pnpm.cmd --prefix src\draft\technical-proofs\meta-cloud-broker-resolution-contract test
```

## Scope Boundaries

This package does not implement hosted broker service persistence, live provider calls, provider
adapters, Admin Console controls, Yard planner or Matching behavior, Gatekeeper policy changes, or
release-facing broker claims. It is a branch-proof contract that later broker runtime work must
honor.
