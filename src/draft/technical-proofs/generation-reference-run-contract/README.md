# Generation Reference Run Contract

Independent POC for HOBO-348. It composes the generation pipeline stage
contracts into one cold-start reference run for a database provider targeting
`hobo:database/postgres@0.1.0`.

## Contract

- The run starts from a `hobo.gen.request/v1` with authoritative WIT,
  conformance suite, Capability Manifest digest, sanitized material refs,
  pinned model, frozen prompt, and seed.
- Scaffold and LLM-fill are composed before validation; material remains
  untrusted and cannot change the authoritative WIT target or conformance suite.
- Validation runs under the no-egress sandbox profile and combines provider
  conformance with recorded trace replay.
- Repair is bounded to two attempts and emits exactly one `gen.NeedsHuman` on
  exhaustion.
- Certification publishes only after validation, conformance, local+Camp
  database coverage, policy, and signed provenance gates pass.

## Scope Boundaries

This POC does not implement a production LLM, a real Firecracker runner, real
cloud provisioning, Registry storage, or provider runtime defenses. It proves
the event-stream composition and certification boundary that production
implementations consume.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\generation-reference-run-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Generation Reference Run Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
