# SLSA Provenance Certification Contract POC

This POC pins the M0 contract for generation certification provenance from HOBO-312.

It proves:

- a generation provenance payload records the generated artifact digest, model id and digest, frozen prompt digest, seed, conformance report ref, eval report refs, and issue timestamp;
- the payload is signed with Ed25519 and verifies against a fixture key;
- tampering with model, prompt, seed, or content-addressed report refs fails verification;
- `gen.Certified` cannot be constructed unless it carries a complete signed provenance ref;
- a missing seed or unsigned conformance report is rejected before signing.

Out of scope here: KMS/signing-key infrastructure, Registry publication, the certify engine that emits the event, and bit-reproduction guarantees for hosted model aliases.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Slsa Provenance Certification Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
