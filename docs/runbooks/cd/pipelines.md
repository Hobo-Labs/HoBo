---
type: Runbook
title: "HoBo.CD runbook: Pipelines"
description: "Pipeline graph, availability and lineage. Assembled from the Runbook section of packages/cd/src/pipelines/README.md."
tags: [hobo, cd, runbook, pipelines]
---

# HoBo.CD runbook: Pipelines

Pipeline graph, availability and lineage. This page is assembled from the **Runbook** section of `packages/cd/src/pipelines/README.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

| Symptom | Meaning | Action |
|---|---|---|
| Freight never reaches a downstream node | Lineage is unmet: upstream qualification is missing, soak has not elapsed, or quorum has not been reached. | Run `available` for the node and the upstream node. Check `freight.Qualified` for the upstream Camps and the `env.Promoted` time against `required_soak_ms`. For a fleet, compare qualified Camps with the quorum threshold and check that the mandatory groups passed. |
| Hotfix Freight reached only one Camp | Approvals bypass lineage for their own Camp until expiry, by design. | Approve each Camp that needs the hotfix, or qualify it upstream. |
| `tick_blocked` `window-closed` | A node window closed between the start of the tick and the request. | The request is retried on the first tick after the window opens. Grant an override to proceed now. |
| `tick_blocked` `placement-context-missing` | The controller was composed without `placementContext`. | Compose it (WP18). Placed nodes do not auto-promote without it. |
| `tick_blocked` `fanout-halted` | A fan-out of the node is halted, so `MATCH_NODE` stops. | Resume or roll back the fan-out (governed), then late entrants catch up. |
| A deferred Camp never catches up | The node is not `MATCH_NODE`, or the Camp has a failed or rolled-back promotion of the stable Freight. | Set `auto_promotion: MATCH_NODE`, or promote the Camp explicitly after fixing it. |
| `pipeline-bindle-has-pipeline` | The Bindle is already delivered by another pipeline. | Edit that pipeline. A Bindle has one pipeline. |
| `shadow-required` | An ENFORCE node would enforce a Rail without an INFORM shadow upstream. | Add an INFORM node upstream and source the ENFORCE node from it. |
| `pipeline-unknown-source` for pushed Freight | Pushed manifests have no source name. | Use `origin:manifest` (or another origin pseudo-source) in `from_sources`. |
| `hobo.cd.pipeline.unreadable` | A `pipeline.Applied` body cannot be decoded, so the pipeline is treated as absent and does not auto-promote. | Re-apply the pipeline, or restore `cd-pipeline-<name>` from backup. |
| `pipeline-journal-conflict` | Both CAS attempts lost to concurrent writers, or the store is unavailable. | Retry. `apply` is idempotent. |
