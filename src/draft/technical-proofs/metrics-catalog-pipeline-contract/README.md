# Metrics Catalog Pipeline Contract

Independent POC for HOBO-257.

This package proves the metrics side of the HoBo observability substrate:

- A typed metric catalog declares metric name, type, unit, and bounded labels.
- Control-plane deploy and provider metrics emit through one pipeline.
- Data-plane RED metrics are emitted for `service`/`web` requests.
- Wasm runtime metrics cover cold starts, instance density, and link-call latency/errors.
- A mock OTLP collector receives OTLP-shaped cumulative series from the same public interface.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\metrics-catalog-pipeline-contract test
```

Scope kept out:

- SLO/burn-rate computation and alert routing.
- Real OTLP network transport or provider-specific collector adapters.
- AI-method/OpenInference metrics beyond the catalog family.
- Cardinality-explosion guard implementation beyond this contract's fail-closed label schema.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Metrics Catalog Pipeline Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
