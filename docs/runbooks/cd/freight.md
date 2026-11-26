---
type: Runbook
title: "HoBo.CD runbook: Freight ledger"
description: "Recording, yanking, qualifying, approving and retiring Freight. Assembled from the Runbook section of packages/cd/src/freight/README.md."
tags: [hobo, cd, runbook, freight]
---

# HoBo.CD runbook: Freight ledger

Recording, yanking, qualifying, approving and retiring Freight. This page is assembled from the **Runbook** section of `packages/cd/src/freight/README.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

| Symptom | Meaning | Action |
|---|---|---|
| `freight-artifacts-unverified` with `artifact-digest-mismatch` | The bytes at a coordinate are not the declared digest. | Treat as possible tampering. Republish the artifact from the build, or fix the manifest, and resubmit. Never edit the digest to match. |
| `freight-manifest-invalid` | The document is not `hobo.freight-manifest/v1`. | Emit it with `writeFreightManifest`. The reason's `subject` names the field. |
| `freight-secret-in-record` | A coordinate, label or source field carries a credential. | Rotate the credential. Move it to a `credentialRef`. |
| `freight-action-ungoverned` on approve | The ledger was composed without an authorizer. | Pass the `CdAuthorizer` to `createFreightLedger` (WP18 compose). |
| `freight-proposal-only` | An agent or other proposal-only principal tried to approve or yank. | A granted principal applies the proposal. |
| `freight-journal-unreadable` | A Freight event body cannot be decoded. | Restore the stream from backup. Until then the Freight is unusable, by design. |
| `hobo.cd.freight.retention.aborted` rises | The sweep found an unreadable `set.Created` or `env.PromoteRequested`. | Find the event by position in the reason, repair it, and rerun the sweep. Nothing was retired. |
| Freight unexpectedly retired | The rules above all said retire. | Retirement is final. Recording the same build again returns the retired record (same id). Promote newer Freight. To keep Freight longer, add a legal-hold label at build time or raise `keep_per_camp`. |
| Alias lookup returns nothing | No Freight, or two Freight share the alias. | Use the `sha256:` id. Aliases are for humans. |
