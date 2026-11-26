# @hobo/runtime-oci — Architecture Evidence

Camp component host for **oci**: WASM components packed as OCI artifacts and
scheduled on **Kubernetes** via a real, minimal `kubectl` transport
(`createProcessKubectlTransport` / `createKubectlKubernetesClient`).

The kubectl/cluster integration boundary is HTTP-shaped and captured as PACT
(`contracts/pacts/kubectl-cluster.pact.json`). Tests inject
`createMockProviderFromPact` — no shell shim and no in-memory fake client class.

## Schema and constraints

- Protobuf records live in [`data-models/`](./data-models).
- CUE constraints bound every protobuf type in that folder.
- PACT evidence lives under [`contracts/`](./contracts).

## Parse, don't validate

Image refs and resource names are sanitized once before manifests. Invalid empty
resource names cannot form Deployment metadata. Pack requires an existing wasm
file path — missing bytes throw at the pack boundary. Kubectl binaries resolved
by `ensureKubectlBinary` become **derived types** (`KubectlBinary` with pinned
version + source) — consumers receive the parsed record, never a bare path string
that still needs validation.

## Component host — event architecture

- **Command** — pack OCI, apply Deployment/Service, port-forward, delete.
- **Event** — ensure/serve progress for schedule and teardown.
- **Actor** — each private resource is a K8s Deployment actor.
- **Event store** — yard durable log owned by composition root.
- **Materialized view / projection** — isolation metadata (namespace, image refs).
- **Snapshot** — OCI layouts under `$HOBO_HOME/oci/<resource>/<hash>`.
- **Read store** — loopback port-forward URLs for Camp mesh handlers.
