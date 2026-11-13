# `@hobo/provider-flux`

Flux **compute** CloudProvider. [Orbit](https://orbit.runonflux.com/) is the **Git-to-Flux** deploy mode (`source: git`), not a fourth topology and not an actor runtime.

| Primitive | Verdict |
|---|---|
| `web` / `api` / `service` | Honest yes |
| `actor` / `data` / `kv` / `queue` / `bucket` | **none** (use Rivet/celld or a data provider) |

Production apply requires OCI digest, signed webhook, authenticated status/logs, paid multi-instance. Rivet **runners** may live here; Rivet **control plane** and celld fleets must not sit on community nodes.

Live public probes fail closed: unsigned `GET /apps/appregister` must be HTTP ≥400. Timeout or network error is a failure, not a skip.

## Delivery coverage (plan 0024 WP13, I14)

| Export | What it is |
|---|---|
| `fluxResolverRegistry(options?)` | Registry with `flux.app/v1` (`src/app-resolver.ts`): reads `GET /apps/appspecifications/{name}` and `GET /apps/location/{name}` on `api.runonflux.io`, adopts an app whose owner and digest-pinned compose images match, and reports ready only when enough distinct nodes run it. It never registers, updates or removes an app: each needs the owner's wallet signature. Optional `metrics` + `nowMs` emit `hobo.cd.resolver.*`. |
| `FLUX_TRAFFIC_ROUTING_PROFILE` | Kind `other`; only `inprocess.weighted` (FluxOS balances instances evenly; one app runs one image set). |
| `FLUX_TRAFFIC_ROUTING_ABSENT` | Every other portable offering, with its reason (ADR-0144). |
| `FLUX_HOSTING_COVERAGE` | The I14 document; protobuf `data-models/hosting_coverage.proto`, CUE `#HostingCoverage`. |
| `fluxProductRefusal(productId)` | Typed `RESOLVER_PRODUCT_UNSUPPORTED` for `flux.orbit-git/v1` (Orbit rebuilds from Git on the node, which breaks promote-never-rebuild). |

Reads are public: the resolver resolves no credential and sends no auth
header. Registered `environmentParameters` are never copied into outputs. A
single-component app reports `artifactDigest`; a multi-component app reports
`componentDigests` only, so an artifact-gated transition fails closed. Outputs
are constrained by `#FluxAppOutputs` (`data-models/app_resolver.cue`). The PACT
is `contracts/provider-flux-apps.pact.json`; the fixtures replay it.

Live lane (read-only, public API; skipped with a visible reason unless all are
set): `HOBO_FLUX_LIVE=1`, `FLUX_LIVE_APP_NAME`, `FLUX_LIVE_APP_OWNER`,
`FLUX_LIVE_COMPONENT`, `FLUX_LIVE_IMAGE`.

## Runbook

| Symptom | Meaning | Action |
|---|---|---|
| `RESOLVER_PROVIDER_REJECTED` "is not registered" | FluxOS does not know the app; HoBo cannot register it. | Register it with the owner's wallet (through an agent-local bridge called from a signed `hobo:resolver` component), then reconcile to adopt. |
| `RESOLVER_PROVIDER_REJECTED` "runs another image" or "components differ" | The registered compose drifted from the Set. | Sign and broadcast an `appupdate` with the Freight's digest-pinned images, then reconcile. |
| `RESOLVER_PROVIDER_REJECTED` "another owner" | The app name belongs to a different owner (names are global). | Pick an app name registered to your owner address. |
| Outputs `lifecycleStatus: pending` for a long time | Fewer distinct nodes run the app than required. | Check the subscription and node availability; verification fails closed at its deadline. |
| `RESOLVER_PRODUCT_UNSUPPORTED` naming `flux.orbit-git/v1` | Orbit Git mode rebuilds on the node. | Build in CI, publish by digest, deliver through `flux.app/v1`. |
