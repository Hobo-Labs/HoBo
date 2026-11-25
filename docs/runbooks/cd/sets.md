---
type: Runbook
title: "HoBo.CD runbook: Sets and Deltas"
description: "Desired state and Delta application. Assembled from the Runbook section of packages/cd/src/sets/README.md."
tags: [hobo, cd, runbook, sets]
---

# HoBo.CD runbook: Sets and Deltas

Desired state and Delta application. This page is assembled from the **Runbook** section of `packages/cd/src/sets/README.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

| Symptom (reason code) | Meaning | Action |
|---|---|---|
| `delta-overlap` | The Camp already has an open Delta. | Find it with `spec(campId).openDeltaId`; apply or reject it. A promotion that died mid-flight leaves its Delta open: reject it with reason `abandoned`. |
| `delta-stale-base` / `concurrent-apply` | Another writer moved the Camp's current Set. | Re-resolve against `current(campId)` and open a new Delta. Repeated `apply_conflicts` on one Camp means two controllers drive it; check fan-out/promotion leases. |
| `delta-diff-mismatch` | The resolved set does not match the Delta's declared changes. | Recompute `changes` with `diffResolvedSets(base, resolved)`; a mismatch means the resolver and the Delta disagree about what changes. |
| `secret-material` | A plaintext secret reached a resolved set. | Replace the value with a `secretRef:` locator at its source (declaration or Matching). Nothing was stored. |
| `resolved-set-missing` | The blob a Set names is gone from the artifact store. | Restore the blob (the digest is in the message) from a replica or backup, or re-apply the Set with a new Delta. Retention (WP1) must never delete a referenced blob; check its referenced-set scan. |
| `resolved-set-digest-mismatch` | The stored bytes no longer hash to the Set's digest (corruption at rest). | Promotion and reconciliation for the Camp stay blocked. Restore the blob from a replica; `hobo.cd.sets.resolved_set_verify_failures` shows the scope. |
| `blob-digest-mismatch` | The artifact store returned a different digest for bytes it was given. | The store backend is faulty or misconfigured (wrong hashing or a proxy rewriting bodies). Fix the backend; nothing was appended. |
| `journal-invalid` | A Camp's spec stream is inconsistent (a write outside this module). | Stop writers for the Camp, export the stream, and repair it by an operator-reviewed append. Never edit events in place. |
| Legacy estate shows no current Set | `adoptLegacy` has not run, the deployment was rolled back, or it was skipped. | Run adoption (composition does it at start); read `skipped` reasons and `hobo.cd.sets.legacy_skipped`. |
