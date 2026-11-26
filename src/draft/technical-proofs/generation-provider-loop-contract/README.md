# Generation Provider Loop Contract POC

Independent POC for HOBO-207. It pins the provider-side generation loop that
turns a target WIT port, provider conformance suite, Capability Manifest, and
sanitized provider material into a generated provider candidate.

## Contract

- `generateProvider()` composes the existing generation stage contracts:
  request IO, scaffold, LLM-fill, no-egress validation, bounded repair, and
  certification.
- Authoritative inputs stay contract-first: target WIT port, conformance suite,
  and Capability Manifest digest. Provider docs/OpenAPI/Terraform material is
  sanitized into untrusted refs before prompt assembly.
- Missing Capability Manifest inputs take the cold-start path: the loop creates a
  deterministic cold-start manifest ref, keeps it in the run evidence, and still
  validates through sandboxed conformance plus trace replay.
- Validation runs through the HOBO-320 no-egress sandbox contract and refuses to
  certify a provider if the conformance suite is too thin for the claimed
  database port.
- Repair is bounded by the configured budget. Failed convergence emits
  `gen.NeedsHuman` instead of looping.
- Certified results carry pinned model, prompt digest, seed, conformance report,
  sandbox report, trace replay, and material scrub evidence.

## Scope Boundaries

This package does not implement a real LLM optimizer, Firecracker runtime,
Registry service, signing infrastructure, provider runtime, Resource Definition
generation, or malicious-provider oracle. It consumes those boundaries from the
neighboring draft contracts and proves the provider-generation orchestration
shape.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\generation-provider-loop-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Generation Provider Loop Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
