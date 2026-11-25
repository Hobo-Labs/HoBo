# HOBO-352 Generation Material Sanitization Proof

HOBO-352 proves the Plan 23 and ADR-0023 prompt-injection boundary for
generation material. The draft package is
`src/draft/technical-proofs/generation-material-sanitization-contract`.

## Evidence

- Clean provider material is escaped, wrapped in an untrusted-material block,
  and converted into `trusted: false`, `sanitized: true` refs that validate
  against the HOBO-307 generation request contract.
- OpenAPI description injection is refused before fill and cannot change the
  authoritative WIT port, widen claimed capabilities, grant egress, or certify.
- Terraform comments and trace payloads produce refusal events.
- Base64-layered and Unicode-confusable injections are detected before fill.
- Certification uses the authoritative request and Capability Manifest, not
  material text, as its load-bearing source.

## Commands

```powershell
npm.cmd --prefix src\draft\technical-proofs\generation-material-sanitization-contract test
```
