# Generation Certify Stage Contract

Independent POC for HOBO-346. The package proves the final generation pipeline
certify step:

- assemble a candidate artifact, validation report, conformance report, gate
  decision, and signed HOBO-312-style provenance into a Registry record;
- sign the Registry record with Ed25519;
- publish only when the Registry can verify the record signature, complete
  provenance, green validation/conformance, and claimed-port coverage;
- emit `gen.Certified` and `gen.PluginCertified` events.

The POC uses an in-memory Registry boundary. It does not implement production
Registry storage, crawling, discovery, or signing-key infrastructure.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\generation-certify-stage-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Generation Certify Stage Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
