# HOBO-221 malicious provider containment proof

This branch proves the hostile third-party provider package boundary with an
independent contract package:
[`src/draft/technical-proofs/malicious-provider-containment-contract`](../../../../src/draft/technical-proofs/malicious-provider-containment-contract).

## Acceptance Coverage

| Requirement | Executable proof |
|---|---|
| Unsupported claimed capability is refused. | `provider claiming unsupported capability is refused before certification` |
| Egress beyond scoped sandbox target is denied. | `sandbox executor denies egress beyond the scoped target and records the attempt` |
| Unsigned or tampered package is refused. | `unsigned and tampered provider packages are refused at install` |
| Forged conformance report is caught by rerun. | `forged conformance report is rejected by in-boundary rerun rather than attachment trust` |
| Older signed vulnerable version is blocked. | `older signed vulnerable provider versions are blocked by anti-rollback` |
| Yanked version is blocked from new selection. | `yanked provider version is blocked from new selection` |

## Adversarial Coverage

- Compromised signing keys are denied by offline revocation, not accepted by
  signature validity alone.
- Scoped covert-channel attempts are contained to the allowed target and logged
  as residual risk.
- A provider that is benign in conformance but malicious in production does not
  receive a benignity claim; the verdict reports explicit residual risk.

## Scope Guard

The proof does not implement real Firecracker/no-egress isolation, signing or
SLSA plumbing, registry yank lifecycle mechanics, or provider generation.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\malicious-provider-containment-contract test
```
