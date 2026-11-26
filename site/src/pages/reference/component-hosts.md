---
layout: ../../layouts/Docs.astro
title: Component hosts
description: "Camp component hosts vs EventStore engines: local journal, browser journal, Wasmtime, OCI/Kubernetes, and optional cloud-native hosts."
---

# Component hosts

Camps separate two concerns:

| Concern | Role |
|---|---|
| **Durable EventStore engines** | Single-owner journal, fencing, staged effects |
| **Component hosts** | How Bindle components actually run |

App authors pick ports and Bindles; operators choose engines. Conformance certifies claims.

## EventStore engines (default path)

| Engine | Host | Notes |
|---|---|---|
| Local SQLite | Node / server | Storage worker; crash-safe defaults |
| Browser SQLite | Browser | WASM + OPFS; fail-closed if durable required without OPFS |

See [EventStore](/HoBo/reference/eventstore/) · [Runtime ports](/HoBo/reference/runtime-ports/).

## Component host kinds

### Wasm (Wasmtime)

- Private components as **wasi:http** processes in sandboxes 
- Public web may stay process-local 
- Deny-by-default: only linked WIT imports are invokable 

### OCI / Kubernetes

1. Accept prebuilt wasi:http components 
2. Pack local OCI layout under the HoBo home directory 
3. Schedule on Kubernetes through a typed transport (version, apply, rollout) 

### Cloud-native registry

- Multi-cloud host registry with a **mock** path for parity tests 
- Cloud providers appear as they pass conformance 

## Optional sidecar runtime

Some Camps may opt into a **sidecar-style** runtime (for example Dapr-backed actors and pub/sub). It is never the default local path.

## Later engines

Postgres journals, Temporal, Restate, and similar remain future adapters behind the same ports.

## Related

[Capability map](/HoBo/reference/packages/) · [WASM guide](/HoBo/architecture/wasm/) · [Trail map](/HoBo/guide/status/) · [Conformance](/HoBo/testing/conformance/)
