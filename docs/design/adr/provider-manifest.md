---
type: Architecture Decision Record
title: "Provider Manifest as Data"
description: "Provider auth flows, capability mappings, and billing models are one serialized manifest deserialized into existing types, not a provider package."
tags: [hobo, design, adr, providers, pricing, auth, registry]
---

# ADR-0177 — Provider Manifest as Data {#adr-0177}

**Status:** Accepted
**Date:** 2026-11-10

## Context

Describing a provider to HoBo meant writing a TypeScript package: a hand-built
`publishCapabilityManifest()`, a `COST_FACTS` table, an auth document literal.
That is a high bar for a provider or a community contributor who only wants to
state facts — which OAuth flows exist, which service realizes which port, what
a GPU-hour or a million tokens costs. The pieces those facts feed already
exist: the `@hobo/pricing` catalog (ADR-0176), the `@hobo/core` Capability
Manifest documents, and `@hobo/auth-md` discovery.

## Decision

Add `@hobo/provider-manifest`: one YAML/JSON document, schema
`hobo.provider-manifest/v1`, defined in protobuf with CUE constraints. Its
protobuf JSON form is the authoring format. The package parses it once and
**deserializes into the existing types** — a `PricingCatalog` and a
`CapabilityManifest` — rather than generating new ones. See
[Provider Manifest](../provider-manifest.md).

- **Auth** is a list of flows, each exactly one of `oauth2` (five grants),
  `authMd`, `oidcFederation`, `apiKey`, or an `x-` `extension`.
- **Capabilities** are mappings from a HoBo port and resource class to the
  provider service, optionally naming capability profiles and billing products.
- **Billing** is an author-defined vocabulary of billables plus products, plans,
  and charges: `recurring`, `metered` (per unit, per package, graduated,
  volume), or an `x-` `external` model.

Extension points are explicit and inert: an extension auth flow is published
but never brokered; a plan with an external charge is reported as unrated and
gets no rate card.

## Consequences

- A provider can be discovered, authenticated against, ranked, and quoted from
  a data file. Provisioning still needs `realize()` or a Resource Pack.
- New billable kinds (materials, licences, seats) need no code change; new
  *pricing models* do, in `@hobo/pricing`, and are declarable as `external`
  until then.
- The manifest is a second authoring surface over the same kernel types, so
  the kernel stays the single place rating semantics live.
- Not yet wired into `hobo registry add`.
