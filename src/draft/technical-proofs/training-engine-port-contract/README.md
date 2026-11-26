# training-engine port contract POC

This draft proves HOBO-317's training-engine seam without implementing a production optimizer.

It records:

- WIT-shaped `training-engine` port: `optimize(request) -> result<candidate-patch, training-error>`.
- OpenInference trajectory fixture carrying run, agent, generated-region, payload, and reward correlation.
- `training.*` telemetry event family plus deterministic replay into a run projection.
- Candidate patch validation that keeps optimizer edits inside the marked generated region.
- Sensitive trajectory payload guard requiring tokenized data or per-run encrypted references.

Scope intentionally excludes OPTO optimizer internals, external Agent Lightning or Microsoft Trace adapters, and live-eval reward attachment.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Training Engine Port Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
