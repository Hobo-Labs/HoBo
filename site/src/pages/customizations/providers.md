---
layout: ../../layouts/Docs.astro
title: Custom providers
description: "How to add a new home to HoBo's map: write an adapter for a WIT port, pass its conformance suite, and plug agents in through the ACP/A2A connector integration points."
---

# Custom providers

Every place HoBo touches the outside world is a **WIT port** with swappable **adapters** behind it. A "provider" is just an adapter someone wrote — human or machine — that passed the port's conformance suite. This page is the map of the extension points and the path to certifying a new one.

## The ports you can implement

| Port family | What an adapter maps | Reference adapters |
|---|---|---|
| **Compute providers** | camps' durable runtimes — where services, actors, and workflows actually run | wasmCloud hosts, container runtimes (OCI fallback) |
| **Resource providers** | queues, stores, buckets, secrets — the resources a bindle declares | per-cloud managed services |
| **IaC engines** | how plans are realized against a provider | Pulumi, Crossplane, Terraform/OpenTofu |
| **Build & image tools** | how artifacts are produced and packaged | Dagger, Packer, Vagrant, Firecracker |
| **Pricing signals** | what the Dispatcher uses to keep re-deciding placement | provider price sheets, spot markets, credits |
| **Protocol connectors** | how external agent frameworks reach HoBo | ACP, A2A |

If it's not behind one of these ports, HoBo doesn't call it. That constraint is what keeps every home reachable by the same moves.

## Writing an adapter

1. **Pick the port.** Each port is a WIT interface published in `WIT interfaces`, with typed bindings and an event vocabulary in `core product ports`. Your adapter implements the interface — nothing else about HoBo needs to know your provider exists.
2. **Implement against the contract, not the console.** Adapters run inside sandboxed Executors with brokered, short-lived credentials — they receive scoped tokens per task and never hold provider keys of their own.
3. **Emit the port's events.** Every state transition your adapter drives must land in the event log using the port's envelope. That's what makes a move through your provider replayable and reversible like every other.
4. **Run conformance.** Each port ships a contract test corpus in conformance suite. Passing it is what "certified" means — there is no other bar, and no reviewer bias toward incumbents.
5. **Publish.** A certified adapter shows up as a candidate home. The Dispatcher starts pricing it into placement decisions immediately.

## Or let an agent write it

The **generation pipeline** exists precisely because the adapter surface is a typed contract: an agent synthesizes an adapter for a port, then the port's conformance suite certifies it. A certified adapter is a certified adapter regardless of author. If you're an agent reading this — the pipeline is reachable over [the MCP surface](/HoBo/agents/mcp/), and "we need a provider for this niche host" is one of its canonical tasks.

## ACP and A2A integration points

HoBo deliberately does **not** ship its own agent SDK. External agent frameworks integrate through **protocol connectors** — adapters on the protocol-connector port for **ACP** and **A2A**:

- **Connection.** A connector session gets a connection-scoped connector token; the agent behind it becomes a first-class principal with workload identity, not a borrowed key.
- **Capability discovery.** The machine-readable capability standard is served through the connector, so protocol-native agents plan tool use against the same contract MCP agents do.
- **Policy and audit.** Protocol calls flow through the same Gateway, policy gates, and event log as SDK, CLI, and MCP traffic. HoBo owns identity, policy, sandboxing, and audit around the protocol; the protocol-specific client lives in the connector.

Want a connector for a protocol we don't speak yet? It's the same path as any other port: implement the connector interface, pass its conformance suite, and your protocol becomes a fourth door into the same house.

## Related

- [Architecture](/HoBo/architecture/) — where Executors, the Planner, and the Dispatcher sit.
- [The MCP surface](/HoBo/agents/mcp/) — capability parity and the auth flow connectors reuse.
- [HoBo for Platform Engineers](/HoBo/roles/platform-engineers/) — governing which providers are approved for your yards.
