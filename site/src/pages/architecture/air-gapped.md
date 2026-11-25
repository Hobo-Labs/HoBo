---
layout: ../../layouts/Docs.astro
title: Air-gapped & sovereign
description: "Zero-egress Yard profile: signed offline bundles, in-boundary substitutes for registry, certs, KMS, embeddings, and telemetry."
---

# Air-gapped & sovereign

HoBo supports a **zero-egress** Yard profile for sovereign and regulated deployments. Deploy / match / migrate / route must work **without phone-home**.

## Capability substitutes

| Capability | Connected | Air-gapped substitute |
|---|---|---|
| Registry | Crawl capability manifests | **Signed offline bundle import** |
| Images | Public pull | Mirrored in-boundary OCI |
| TLS | Public ACME | Internal CA / private ACME |
| Identity / SVID | Yard-issued | Unchanged (already in-boundary) |
| Secrets | Provider KMS | In-boundary KMS/HSM |
| Embeddings | Hosted API | Local model or BYO vectors |
| AI generation | Hosted LLM | Local LLM or human-authored only |
| Telemetry | 3p sinks | In-boundary OTel collector |

## Rules

1. Registry refuses unsigned/unproven plugins even offline — trust moves to the **bundle signer**, not to “files on a USB.”
2. No feature may require egress for core deploy/migrate.
3. Metering and audit stay in-boundary; export is operator-controlled.
4. Provider free-tier games still forbidden — sovereign is not a loophole for multi-account free tiers.

## CLI

`hobo registry` offline bundle import; `hobo doctor` should report egress assumptions.

## Related

[Security](/HoBo/security/) · [Control plane](/HoBo/architecture/control-plane/) · [CLI](/HoBo/reference/cli/)
