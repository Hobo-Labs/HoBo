# HOBO-78 Capability Negotiation Contract

This draft package proves the M2 capability-negotiation seam from
[Plan 04](../../../../docs/design/control-plane.md#plan-04),
[Plan 25](../../../../docs/design/platform-engineering.md#plan-25), and
[ADR-0033](../../../../docs/design/adr/01-architecture-core.md#adr-0033).

## Contract Surface

- ResourceDefinition candidates still gather and rank deterministically from a catalog snapshot.
- Each matching candidate evaluates provider capabilities before ranking.
- `full` satisfies the request and produces no warning.
- Missing `require` capabilities reject only that candidate, allowing fallthrough to another provider.
- Missing `prefer` capabilities accept with a structured `PlanWarning`.
- If no candidate satisfies required capabilities, the result emits a valid
  `deployment.PlanRejected` event with a machine-readable `capability.require.unsatisfied` reason.

## Proof Boundaries

This proof does not implement author-time static remediation, objective ranking among full matches,
concrete provider Capability implementations, or policy/Gatekeeper enforcement. It only pins the
Planner-side capability filter and resulting event contract.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\capability-negotiation-contract test
```

The checks live in
`src/draft/technical-proofs/capability-negotiation-contract/test/capability-negotiation.test.ts`.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Capability Negotiation Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
