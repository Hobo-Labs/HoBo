# Launch Messaging Claim Register

HOBO-406 proof for the V1 Launch Site, Messaging & Demo Assets M0 claim register.

This package keeps launch claims tied to evidence before any public site or final launch copy
exists. The executable register is intentionally small: it classifies claims, requires an evidence
owner and source, lists launch demo assets, and rejects evidence-less or launch-site implementation
scope creep.

## Acceptance

- Public-facing claims include evidence owner, evidence source, and risk rating.
- Claim states distinguish `implemented`, `simulated-reference`, `beta-only`, and
  `future-roadmap` capabilities.
- Demo assets required for launch are listed with owner, proof mode, and refresh trigger.
- Unsupported or risky claims route to `scopeOut` or `followUps` before publication.
- Evidence-less claims and launch-site build work are rejected by negative tests.

## Files

- `src/launch-messaging-claim-register.mjs` exports the register plus validation helpers.
- `test/launch-messaging-claim-register.test.mjs` is the acceptance contract for HOBO-406.
- [`../../../../../docs/design/launch-messaging-claims.md`](../../../../../docs/design/launch-messaging-claims.md)
  records the human-readable M0 claim register.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\cx\launch-messaging-claim-register test
```

## Scope Boundary

This proof does not build the launch site, publish final copy, create demo recordings, or assert
production readiness without linked evidence.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Launch Messaging Claim Register.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
