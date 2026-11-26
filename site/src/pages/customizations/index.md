---
layout: ../../layouts/Docs.astro
title: Customizations
description: "Extend HoBo: custom providers, IaC engines, messaging integrations, connectors, and component hosts."
---

# Customizations

HoBo is ports-and-adapters all the way down. Customize by **registering** conforming engines — not by forking the control plane.

## In this section

| Page | Topic |
|---|---|
| [Custom providers](/HoBo/customizations/providers/) | Capability providers behind WIT ports + conformance |
| [IaC engines](/HoBo/customizations/iac/) | Pulumi, Crossplane, Terraform/OpenTofu adapters |
| [Messaging integrations](/HoBo/customizations/messaging/) | Kafka, Dapr, and the messaging port |
| [Connectors](/HoBo/customizations/connectors/) | Conductor connector registry plugins |
| [Component hosts](/HoBo/reference/component-hosts/) | wasm / oci / cloud-native hosts (reference) |

## Rules

1. Every adapter ships conformance suite for the ports it claims. 
2. Secrets stay refs — connectors use `credentialRef`, not ambient keys. 
3. Custom **ACP agents** live under [The Crew](/HoBo/crew/) — not here. 

## Related

[Architecture](/HoBo/architecture/) · [Capability map](/HoBo/reference/packages/) · [Trail map](/HoBo/guide/status/)
