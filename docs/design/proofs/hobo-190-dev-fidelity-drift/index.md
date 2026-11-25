# HOBO-190 Dev Fidelity Drift Proof

This branch proves the `hobo dev` local-to-Camp fidelity hardening slice with an independent
contract package:
[`src/draft/technical-proofs/hobo-dev-fidelity-drift-contract`](../../../../src/draft/technical-proofs/hobo-dev-fidelity-drift-contract).

## Acceptance Coverage

| Requirement | Executable proof |
|---|---|
| Mislabeled `simulated` capability that is only `mocked` is caught. | `mislabeled simulated capability that only has mock behavior fails fidelity audit` |
| Prod-ready claims for mocked-only behavior are refused. | `prod-ready claim for mocked-only behavior is refused with defer-to-Camp evidence` |
| `--fork` writes are invisible to baseline. | `fork lanes keep writes out of baseline and out of each other` |
| Local-vs-Camp drift for `real` fidelity fails. | `local-vs-Camp mismatch for a labeled-real capability fails drift check` |

## Adversarial Coverage

- Missing fidelity labels default to `camp-only`, never `real`.
- Concurrent fork lanes cannot cross-contaminate each other.
- Mock behavior drifting from the declared contract is reported.
- Clock-driven simulated behavior must replay identically across restarts.
- Camp partition or incident evidence blocks confident local success.

## Scope Guard

The proof does not implement `hobo verify`, production runtime backends, Camp conformance suites,
or the `hobo dev` daemon. It hardens the honesty boundary consumed by those systems.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-dev-fidelity-drift-contract test
```
