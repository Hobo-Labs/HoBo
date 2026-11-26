---
type: Design Proof Evidence
title: "HOBO-576 SDK-to-CLI Golden Path Proof"
description: "Proof record for the SDK consumer to CLI terminal transcript golden path."
tags: [hobo, proof, sdk, cli, dx]
timestamp: 2026-07-01T00:00:00Z
---

# HOBO-576 SDK-to-CLI Golden Path Proof

HOBO-576 records the first SDK-to-CLI golden path transcript for `shop-api`, using one deterministic
fixture id across SDK example, manifest IR, CLI transcript, API shape, MCP result, and downstream
handoff records.

## Evidence

- Proof package:
  [`sdk-to-cli-golden-path`](../../../../src/draft/exp-proofs/api/sdk-to-cli-golden-path/README.md)
- Fixture id: `dx.lifecycle.shop-api.v1`
- Source record:
  `src/draft/exp-proofs/api/sdk-to-cli-golden-path/src/sdk-to-cli-golden-path.ts#createSdkToCliGoldenPathProof`
- Contract artifacts:
  `architecture/sdk_to_cli_golden_path.proto`,
  `architecture/sdk_to_cli_golden_path.cue`, and
  `architecture/pacts/sdk_to_cli_golden_path.pact.json`

## Acceptance Mapping

- The example SDK consumer demonstrates a smallest meaningful API plus managed Postgres resource
  graph without cloud-provider logic in SDK code.
- Compile/type tests prove the `@hobo/bindles` and `@hobo/sdk/results` API shape and the command
  result envelope consumed by the transcript.
- The terminal transcript covers happy path, gatekeeper denial, contract incompatibility, stale or
  unknown evidence, and support handoff result paths.
- The same fixture id links SDK example, CLI transcript, API shape, MCP result, and this proof
  README.

## Scope Boundary

No production app scaffold, real deploy URL, package publication, live MCP server, dashboard
screenshots, live provider, customer data, or credential flow is implemented here. The accepted
artifact is a deterministic design-time proof package for downstream docs, tutorials, support,
plan/diff, and dashboard owners.

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\sdk-to-cli-golden-path test
```
