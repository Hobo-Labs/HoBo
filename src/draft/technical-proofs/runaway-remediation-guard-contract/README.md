# Runaway Remediation Guard Contract

Independent POC for HOBO-308. It proves the event-sourced safety rail that sits around the
SRE remediation write path after the decision tree and gated apply contracts have produced a
candidate action.

The guard consumes:

- the source signal and its causation link to a prior Crew action, when present;
- the existing `RemediationAction` shape;
- prior `policy.Decided` and `crew.*` facts.

It emits:

- `policy.Decided`;
- `crew.ActionProposed`;
- either `crew.ActionApplied` or `crew.ActionDenied`;
- `crew.HandoffRequested` when the circuit breaker or blast-radius guard escalates to A2H.

## Executable Proof

```powershell
npm.cmd --prefix src\draft\technical-proofs\runaway-remediation-guard-contract test
```

The tests cover the acceptance and adversarial cases from HOBO-308:

- a flapping self-caused signal creates one remediation, then cooldowns, then trips a circuit
  breaker and escalates without applying again;
- the opened circuit continues to block later remediation attempts;
- per-action cooldowns and rate limits deny repeated writes in a window;
- repeated and causally linked attempts cannot widen blast radius;
- two operators fixing each other's symptoms are detected as a causation loop;
- an amplifying fix hard-stops to A2H.

## Scope Boundary

This package does not add remediation kinds, implement the policy engine, run canaries, page a
vendor, or replace HOBO-284's gated apply path. It proves the containment contract and replay state
that downstream SRE runtime code must preserve.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Runaway Remediation Guard Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
