# HOBO-205 Control-Plane Policy Bypass Proof

This proof makes the Plan 29 / ADR-0074 adversarial control-plane bypass case executable in
[`src/draft/technical-proofs/control-plane-policy-bypass-guard`](../../../../src/draft/technical-proofs/control-plane-policy-bypass-guard/README.md).

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| Deliberately un-enumerated verb fails the build gate | `un-enumerated or smuggled control-plane paths fail the build gate` |
| Enumerated-but-unbound tuple denies | `an enumerated but unbound control-plane tuple denies before side effects` |
| Fuzzed action/resource strings never reach side effects without `policy.Decided` | `fuzzed action and resource strings never reach side effects without an allow decision` |
| High-privilege derivative/registry/relay actions are enumerated | `high-privilege derivative, registry, and relay actions stay enumerated` |
| Smuggled path with no action id is caught | `un-enumerated or smuggled control-plane paths fail the build gate` |
| Side effect is unreachable before decision | `allowed operations run side effects only after policy.Decided is recorded` |

## Boundary

This is only the adversarial composition proof over the HOBO-154 taxonomy and HOBO-133 policy
engine. The taxonomy itself, default role bindings, policy engine internals, and provider/runtime
side effects remain out of scope for this slice.

## Verification

```sh
npm.cmd --prefix src/draft/technical-proofs/control-plane-policy-bypass-guard test
```
