# V1 Supported Platform Matrix Contract

HOBO-511 defines the v1 browser, device, and platform support contract.

## What This Proves

- Desktop browser support names Chrome, Edge, Firefox, and Safari with beta and GA support levels.
- Mobile/responsive support has a limited v1 posture, a 390px viewport floor, and explicit unsupported authoring uses.
- CLI and local bootstrap support names macOS, Linux, and Windows platform assumptions.
- Every support claim maps to evidence: e2e tests, accessibility checks, bootstrap smoke, docs, support guidance, or known limitations.
- Unsupported browser/device/platform reports route to support debug, release notes, or the known limitations register.

## Boundary

This package defines the support matrix contract. It does not build a device lab, native mobile app,
automated browser grid, live e2e suite, or package/runtime compatibility engine.

## Architecture Evidence

Per the repository architecture guardrails, this package ships M0 design evidence
for its boundary (see [`ADR.md`](./ADR.md)):

- [`proto/supported_platform_matrix.proto`](./proto/supported_platform_matrix.proto) — data shapes and records.
- [`cue/supported_platform_matrix.cue`](./cue/supported_platform_matrix.cue) — CUE constraints for every protobuf type.
- [`contracts/pacts/supported-platform-matrix-projection.pact.json`](./contracts/pacts/supported-platform-matrix-projection.pact.json) — projection-boundary PACT contract.

These are M0 schema/contract evidence only; no device lab, browser grid, or live e2e execution is implemented.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\cx\v1-supported-platform-matrix-contract test
```
