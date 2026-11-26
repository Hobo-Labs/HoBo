# HOBO-156 Build CLI Proof

HOBO-156 is proven by the focused POC at
[`src/draft/technical-proofs/hobo-build-cli-contract`](../../../../src/draft/technical-proofs/hobo-build-cli-contract/README.md).

**S1-23 promotion (HOBO-613):** `hobo build` is implemented in
[`packages/cli`](../../../../packages/cli/README.md) with digest parity against
[`@hobo/componentize`](../../../../packages/componentize/README.md). Draft rollup evidence
remains at
[`src/draft/projects/s1-23-hobo-build`](../../../../src/draft/projects/s1-23-hobo-build/README.md).

## Acceptance Evidence

- `hobo build emits wasm and OCI fallback artifacts with JSON digests` proves
  wasm component output, OCI fallback output, content-addressed artifact
  descriptors, the build manifest, and `--json` reporting.
- `hobo build digests are stable on repeat and across clean checkouts` proves
  repeatable digests with no source changes and path-independent clean-checkout
  reproducibility.
- `stale _generated tree fails with a regeneration hint before build output`
  proves the `_generated/` drift gate and regeneration hint.
- `HOBO_RUNTIME container forces declared wasm services through OCI fallback
  with reason` proves target hints are honored and fallback reasons are recorded.

## Adversarial Evidence

- `componentize failure names service and cause without writing a manifest`
  proves failed componentization reports the service and cause and prevents a
  partial manifest.
- The OCI fallback test asserts fallback only for a non-wasm guest in the default
  build and records `unsupported-language: python`.
- The clean-checkout test proves artifact digests do not depend on absolute
  workspace paths.

## Scope Boundary

The package models the `hobo build` orchestration contract only. It does not
implement componentize internals, production OCI packaging, push/provisioning,
signing, or attestation.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-build-cli-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
```
