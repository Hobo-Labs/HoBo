# Control-Plane Policy Bypass Guard Proof

Independent HOBO-205 adversarial proof for the Plan 29 control-plane policy boundary.

This draft package composes the existing HOBO-154 action taxonomy and HOBO-133 built-in policy
engine contracts. It proves that control-plane side effects cannot run through an unmapped,
un-enumerated, or unbound action path:

- CLI/MCP routes must carry a stable `hobo:<resource>:<verb>` action ID and pass the taxonomy
  completeness gate.
- Smuggled routes with no action ID fail before policy evaluation or side effects.
- Enumerated but unbound tuples produce a deny `policy.Decided` event and do not run side effects.
- Fuzzed near-miss action/resource strings fail closed.
- High-privilege derivative, registry, and relay actions remain enumerated.

## Boundary

This POC does not change the taxonomy, role matrix, built-in policy engine, or any provider/runtime
side-effect implementation. It is only the adversarial guard harness that proves those existing
contracts compose without a bypass.

## Verification

```sh
npm.cmd --prefix src/draft/technical-proofs/control-plane-policy-bypass-guard test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Control Plane Policy Bypass Guard.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
