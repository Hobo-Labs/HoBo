# Componentize Artifact Trust Contract (S0-10 POC)

Independent draft POC for [HOBO-587](https://linear.app/quickdeploy-ai/issue/HOBO-587): artifact signing,
SLSA-style provenance on publish, and fail-closed install verification before Matching visibility.

Promotion target: `packages/componentize/src/publish/` once S0-07 (`@hobo/componentize`) and S0-09 (CI
fabric) land on `main`.

## Contract Surface

- Publish normalizes artifacts to digest-pinned URIs and signs artifact ref + provenance + conformance
  with ephemeral Ed25519 keys.
- Install recomputes digests, verifies signatures against a trust boundary, and accumulates every failed
  check into machine-readable `RefusalReason` values.
- Verified artifacts become `availableToMatching: true` but `selectedByMatching: false`.
- Passing verdicts state assurance `integrity-and-conformance-verified` with residual risks
  `validly-signed-but-malicious` and `compromised-builder-or-key`.

## Verification

```bash
pnpm test:file src/draft/technical-proofs/componentize-artifact-trust-contract/test/publish-verify.test.ts
pnpm run test:contract:consumer
npm --prefix src/draft/technical-proofs/componentize-artifact-trust-contract test
```

## Architecture Evidence

- `data-models/` — protobuf records and CUE constraints for artifact trust shapes.
- `contracts/pacts/artifact-trust-boundary.pact.json` — PACT for the publish→verify boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
