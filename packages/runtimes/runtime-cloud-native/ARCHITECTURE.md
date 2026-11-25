# @hobo/runtime-cloud-native — Architecture Evidence

Camp component host registry for **cloud-native** multi-provider backends
(aws, gcp, azure, vercel, cloudflare, …). This package owns the registry seam;
provider implementations land incrementally.

## Schema and constraints

- Protobuf records live in [`data-models/`](./data-models).
- CUE constraints bound every protobuf type in that folder.
- PACT evidence lives under [`contracts/`](./contracts).

## Parse, don't validate

Provider ids are selected once at host construction. Unknown default providers
throw at the boundary before serve. Stub providers refuse serve with a typed
error code in the message (`HOBO_CLOUD_NATIVE_UNIMPLEMENTED`).

## Component host — event architecture

- **Command** — ensure all providers; servePrivate on the selected provider.
- **Event** — registry readiness notes per provider.
- **Actor** — each cloud provider is a pluggable host actor.
- **Event store** — yard durable log owned by composition root.
- **Materialized view / projection** — isolation metadata (`cloud_native`, provider id).
- **Snapshot** — none yet (stateless registry).
- **Read store** — mesh handlers from the selected provider.
