# HOBO-137 Lifecycle Phase Policy Proof

This proof package anchors the HOBO-137 branch implementation.

## Issue

- Linear: HOBO-137
- Draft package: `src/draft/technical-proofs/lifecycle-phase-policy-contract`
- Design refs: `contracts-policy-flags.md#plan-29`, ADR-0015, ADR-0074

## Proven Acceptance

- A request in each lifecycle phase routes only to that phase's starter rule.
- Representative starter rules cover `author`, `local`, `test`, `plan`, `apply`, `runtime`, `observe`, `train`, `promote`, and `repair`.
- Phase-scoped rules do not leak into another phase.
- `phaseEvidence` and the `policy.Decided` audit event carry the evaluated phase and matched rule ids.

## Proven Adversarial Cases

- Unknown or forged phases fail closed as deny decisions rather than defaulting permissive.
- Runtime tool calls require runtime-delegated scope even when the same action is author-time allowed.
- Runtime tool calls without declared scope evidence and promote decisions without finite scores deny.
- Repair agents may auto-fix preview, but prod auto-fix is denied as propose-only.

## Verification

```sh
npm.cmd --prefix src/draft/technical-proofs/lifecycle-phase-policy-contract test
```
