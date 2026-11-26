# Generation Material Sanitization Contract POC

Independent POC for HOBO-352. It pins the material-input sanitizer that runs
before LLM-fill: provider docs, OpenAPI descriptions, Terraform comments, and
trace payloads are treated as untrusted data, escaped into delimited blocks, and
refused when they contain prompt-injection attempts.

## Contract

- `sanitizeGenerationMaterials()` consumes raw material payloads plus the
  authoritative generation request.
- Clean material becomes `trusted: false`, `sanitized: true` material refs that
  satisfy the HOBO-307 generation request contract.
- Prompt delimiter text inside material is escaped before prompt assembly.
- OpenAPI, Terraform, trace, base64-layered, and Unicode-confusable injection
  attempts produce a digest-addressed scrub report with `decision: "deny"`.
- Refused material emits `gen.MaterialRefused`; accepted material emits
  `gen.MaterialSanitized`.
- `certifyCandidateAgainstMaterial()` refuses certification when the scrub
  report denied, the candidate changes the authoritative WIT port, or the
  candidate claims capabilities outside the Capability Manifest.

## Acceptance Mapping

| Acceptance / adversarial case | Executable proof |
|---|---|
| Clean material is usable only as sanitized, untrusted hints. | `clean material is escaped, delimited, and passed as untrusted sanitized refs` validates the resulting HOBO-307 request. |
| OpenAPI description injection cannot change port, capabilities, or certification. | `OpenAPI description injection is refused and cannot change port, capabilities, or certification` asserts refusal, event evidence, and deny reasons. |
| Terraform comments and trace payloads are covered. | `Terraform comments and trace payload prompt injections are both refusal events` checks both material kinds. |
| Layered/encoded injections are covered. | `layered base64 and unicode-confusable injections are detected before fill` checks base64 and confusable text. |
| Authoritative spec remains load-bearing. | Certification compares candidate target and capabilities to the authoritative request and Capability Manifest, not to material. |

## Scope Boundaries

This POC does not implement the LLM-fill driver, a general SAST or output
backdoor detector, production prompt-provider integration, or Registry publish
logic. Those remain separate generation pipeline slices.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\generation-material-sanitization-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Generation Material Sanitization Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
