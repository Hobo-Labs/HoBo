---
type: Runbook
title: "HoBo.CD runbook: Composition and the hobo binary"
description: "hobo deploy, hobo serve cd and hobo incident. Assembled from the Runbook section of packages/hobo/CD.md."
tags: [hobo, cd, runbook, compose]
---

# HoBo.CD runbook: Composition and the hobo binary

hobo deploy, hobo serve cd and hobo incident. This page is assembled from the **Runbook** section of `packages/hobo/CD.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

- **`compose-realizer-missing`** on `serve cd` or `deploy reconcile`: no
  conductor realizer is composed for the Station. Configure one (Kubernetes
  fleets via `HOBO_CD_KUBE_FLEET`, the hosting-transition or orchestrator
  realizer through the host API), enroll agents for agent-mode Camps, or use
  `--simulate` for a labelled dry run. `/readyz` lists the refusal.
- **`compose-store-multinode`**: more than one replica on SQLite. Set
  `HOBO_CD_POSTGRES_URL`.
- **`cd-store-unavailable`**: the journal could not be opened. For SQLite check
  that `$HOBO_HOME` is writable; for Postgres check reachability and version.
- **`cd-kube-fleet-invalid`**: fix the `HOBO_CD_KUBE_FLEET` file (exactly one of
  `ocm`/`karmada`).
- **`delivery-module-invalid` / `delivery-module-unreadable`**: the
  `--file` module has an unknown export or a malformed record; nothing was
  applied. Fix the named record and re-run.
- **`agent-jwk-invalid`**: `agent enroll` takes the PUBLIC JWK; a key with a
  private member `d` is refused.
- **`cd-not-found`**: the named Freight, pipeline, Camp or decision does not
  exist; the remediation names the list command.
- Any other code comes from the owning `@hobo/cd` module; its remediation is in
  the envelope and in that module's README.
