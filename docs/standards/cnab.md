---
type: Reference Standard
title: "CNAB — Cloud Native Application Bundles"
description: "Spec for packaging multi-artifact cloud apps as signed, distributable bundles with invocation images (Porter is the living implementation); HoBo takes the packaging/signing lessons only."
tags: [hobo, standards]
---

# CNAB (Cloud Native Application Bundles)

> **Standard** · A specification (originally Microsoft + Docker, now under the
> JDF) for packaging a multi-artifact cloud application — images, IaC, config —
> as one signed, distributable **bundle** executed by an *invocation image*.
> Sources: cnab.io, github.com/cnabio/cnab-spec, porter.sh. Factual surface
> quoted under fair use for commentary and interoperability analysis.

## What it is

CNAB defines `bundle.json` (a bundle descriptor: invocation images, parameters,
credentials, outputs, referenced images), a **runtime contract** (the
invocation image's `/cnab/app/run` entrypoint receives an action —
install/upgrade/uninstall — plus parameters/credentials), **claims** (records
of installations), and **security** layers (cnab-security: signing/attestation
over registries). Bundles distribute through OCI registries. **Porter** is the
surviving mainstream implementation (mixins for Helm/Terraform/az/kubectl);
Docker App and Duffle are retired. Adoption plateaued: the spec solved
packaging, but each tool's semantics still leaked through, and per-tool
ecosystems (Helm, Terraform modules, OCI artifacts generally) won distribution.

## Key features

- **One signed unit for a whole app** — images + installers + parameters +
  credential *declarations* (never values) travel together.
- **Action contract** — install/upgrade/uninstall as a uniform lifecycle over
  arbitrary tooling via the invocation image.
- **Claims** — installation state records, separate from the bundle.
- **Registry distribution + signing** — OCI as the carrier, attestations over
  bundle content.

## Relevance to HoBo

**Lessons-only** (pinned by
[ADR-0144](../design/adr/07-portability-extensibility.md#adr-0144): CNAB
contributes signed multi-artifact packaging lessons; CNAB bundles are a
non-goal as HoBo's resource model). The lessons and where they already live:

| CNAB lesson | HoBo realization |
|---|---|
| Signed multi-artifact unit | Registry **listings** with provenance + conformance reports (ADR-0062); signed offline bundles for air-gapped Yards — `hobo registry import`, `registry.BundleImported` (ADR-0036) |
| Credentials declared, never embedded | `secretRef` / identity federation; `staticSecrets: false` manifest posture |
| Uniform lifecycle over arbitrary tooling | Driver taxonomy (Plan 25) + IaC adapters behind `hobo:iac/provider` — but typed per port, not a generic shell entrypoint |
| Claims (install records) | The event journal itself — `deployment.*` / `resource.*` facts, replayable |
| Why it plateaued | The ADR-0144 context argument: describe-once specs stall when operational reality leaks; HoBo keeps a stable high-level IR + an explicit auditable mapping layer instead |

**Naming note (recorded in ADR-0144):** HoBo's **Bindle** is unrelated to and
predates awareness of the CNAB-adjacent "bindle" aggregate-object proposal
(Deis Labs); the collision is documented, not resolved by renaming.

## Sources

- https://cnab.io — spec family (core, registries, security, claims)
- https://github.com/cnabio/cnab-spec
- https://porter.sh — the living implementation
