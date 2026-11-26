# HOBO-355 Generation Safety Gate Proof

This executable proof pins the malicious/backdoored generated-code rejection
gate for [Plan 23](../../generated-stack.md#plan-23),
[Plan 12](../../security-networking.md#plan-12), and
[ADR-0023](../../adr/02-identity-security.md#adr-0023). It sits after green
conformance validation and before certification, because a candidate can satisfy
the port contract while still attempting exfiltration or hidden-trigger
behavior.

## Acceptance Mapping

| Requirement | Executable proof |
|---|---|
| A clean conformance-green candidate passes. | `clean conformance-green candidate passes the post-conformance safety gate` validates the digest-addressed safety report with no findings. |
| Network egress attempt rejects before certification. | `network egress attempt rejects before certification and emits gen.SafetyRejected` records static and sandbox findings and replays the generation stream to a deny decision. |
| Read outside scoped capabilities rejects. | `filesystem read outside scoped paths rejects a contract-green candidate` blocks a literal `/etc/passwd` read outside the allowed scoped paths. |
| Trigger-gated payload rejects. | `input-triggered backdoor is rejected even when normal conformance paths pass` blocks a literal input trigger and secret-like environment read. |
| Time-bomb payload rejects. | `time-bomb payload is rejected even when conformance stays green` catches wall-clock gated behavior. |
| Typosquatted dependency rejects. | `typosquatted dependency is rejected as a generated-code safety finding` catches a near-name dependency. |
| Over-broad capability request rejects. | `over-broad capability request is rejected against declared allow grants` proves requested capabilities must be covered by `.allow()`. |
| Sandbox no-egress is the enforcing floor even if static misses. | `sandbox no-egress evidence is the floor even when static scan misses` rejects late-bound network behavior only through sandbox denial evidence. |

## Boundary

The proof lives in
[`src/draft/technical-proofs/generation-safety-gate-contract`](../../../../src/draft/technical-proofs/generation-safety-gate-contract/README.md).
It consumes the HOBO-320 sandbox event shape and extends the HOBO-307
generation event family with `gen.SafetyRejected`.

It intentionally does not implement a SAST product, sandbox runner,
certification publisher, Registry storage, provider runtime behavior, or
malware adjudication beyond the contract checks named by HOBO-355.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\generation-safety-gate-contract test
npm.cmd --prefix src\draft\technical-proofs\generation-pipeline-io-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
git diff origin/main...HEAD --check
```
