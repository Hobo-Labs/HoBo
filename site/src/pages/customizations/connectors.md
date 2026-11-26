---
layout: ../../layouts/Docs.astro
title: Connectors
description: "Conductor connector registry: external systems the control plane may act through — credentialRef only."
---

# Connectors

The Conductor acts on the outside world through a **connector registry** (GitHub App, Pulumi, cloud accounts, delivery systems). Entries hold **capability metadata + credentialRef** — never long-lived secrets in the catalog.

## Rules

1. Register → sign/provenance/conformance when required 
2. Broker short-lived access via Station connections + identity 
3. Fail closed when the connector or policy engine is unavailable 

## Related

[Stations & Conductor](/HoBo/primitives/stations/) · [Custom providers](/HoBo/customizations/providers/) · [Security](/HoBo/security/)
