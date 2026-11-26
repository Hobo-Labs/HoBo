---
layout: ../../layouts/Docs.astro
title: Messaging integrations
description: "Customize messaging: Kafka provider, Dapr runtime, and the portable messaging port."
---

# Messaging integrations

Beyond the Camp **Queue** port, HoBo has a **messaging** surface for brokered topics/streams with conformance and doctor hooks.

## Entry points

| Piece | Surface |
|---|---|
| Messaging port | [Messaging reference](/HoBo/reference/messaging/) · Bindle `topic()` |
| Kafka provider | Kafka-compatible capability provider |
| Dapr runtime | Optional Camp runtime for pubsub / actors |
| CLI | `hobo doctor` reports messaging readiness; plane details in the messaging reference |

## Related

[Customizations](/HoBo/customizations/) · [Queue port](/HoBo/reference/queue/) · [Conformance](/HoBo/testing/conformance/)
