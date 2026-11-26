# Architecture — `@hobo/provider-flux`

## Schema

- Protobuf: `data-models/provider_flux.proto`
- CUE: `data-models/provider_flux.cue`
- PACT: `contracts/provider-flux-boundary.pact.json`

## Parse, don't validate

Parse, don't validate: derived domain types (`FluxDeploySpec`) are produced only
by `parseFluxDeploySpec`. `applyFluxDeploy` fails closed on unsigned production
webhooks, public logs, missing digest, unsupported primitives, community
production, and control-plane-on-community.

## Event architecture

- **Command** — parse deploy spec; apply Flux/Orbit compute (web/api/service).
- **Event** — `policy.Decided` / deploy apply facts via Camp EventStore.
- **Actor** — none. Flux is not an ActorHost; actor primitives fail closed.
- **Event store** — Camp EventStore remains authority; this package emits none.
- **Materialized view / projection** — apply result (`orbitMode`, recipe notes).
- **Snapshot** — none.
- **Read store** — recipe + doctor notes (outbound-only runners).

## Recipe

`FLUX_RIVET_RUNNER_RECIPE`: trusted-yard control plane, Flux outbound-only runners.
