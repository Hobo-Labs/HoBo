# @hobo/provider-lakebed

The Lakebed deploy-target `CloudProvider` (HOBO-714,
[ADR-0127](../../../docs/design/adr/07-portability-extensibility.md#adr-0127)):
HoBo's portability promise demonstrated against the **head-on competitor** —
the same Bindle that targets AWS/Azure/GCP lands on the closed Capsule PaaS,
with the gaps stated honestly instead of papered over.

| Port | Lakebed surface | Resource class | Honest gaps |
|---|---|---|---|
| `compute` | Capsule | `lakebed:capsule` | not `container` |
| `kv` | Capsule KV | `lakebed:capsule-kv` | — |
| `objectStore` | File Store | `lakebed:file-store` | not `s3-compatible` |
| `database` | Reactive DB | `lakebed:reactive-db` | not `postgres` |
| TrafficRouting (ADR-0143) | Deploy-time route binding | `lakebed:traffic-route` | no multi-LB API — in-process weighted selection lives in `@hobo/connectivity`; this resource binds capsule endpoints for `lakebed-deploy` |

No queue, no cache — a `require` the Capsule runtime can't satisfy surfaces
as `partial(missing)`/rejection with remediation naming a provider that can
(ADR-0033).

`realizeTrafficRoutingPlan(plan)` emits a one-resource `hobo.driver-program/v1`
with `lakebed:traffic-route` for dual-layer production routing (in-process
selection in connectivity + optional deploy binding here).

Matching surface: `LAKEBED_TRAFFIC_ROUTING_PROFILE` declares
`inprocess.weighted` + `driver.route-bind`.

- **Realization is a Driver, not IaC**: `realize()` emits a
  `hobo.driver-program/v1` targeting the `lakebed-deploy` driver — one
  Capsule deploy per deployment. Output-reference validation ignores non-string
  values rather than treating them as references.
- **Opt-in approval**: `hobo add lakebed` registers **held**; a second
  `hobo add lakebed` approves (HOBO-710 semantics) — deploying to the
  competitor's runtime is an explicit operator decision.
- **Secretless**: broker-minted, deployment-scoped deploy tokens;
  `staticSecrets: false` parse-enforced.
- **Anonymous temporary stations**: `provisionTemporaryEnvironmentStation()`
  runs Lakebed's password-free anonymous deploy (CLI transport by default;
  injectable for tests). Returns the shared
  `hobo.temporary-environment-station/v1` shape (`stationUrl` + `claimUrl` +
  provider-reported expiry). The pinned `lakebed@0.0.41` child runs with an
  isolated HOME and an allowlisted environment, so it cannot use an ambient
  login or token. Permanent-token operator
  deploys are out of scope for Examples.

Native ports (Matching truth): `compute`, `kv`, `objectStore`, `database` —
see `lakebedNativePorts()`. Queue/container are not native.

## Verification

```sh
pnpm --filter @hobo/provider-lakebed build
pnpm --filter @hobo/provider-lakebed test
```

## Hosting budget execution

Static cost facts are marked `pricingStatus: "estimate"`; production admission resolves
fresh account-scoped quotes and all lifetime obligations through the shared authority.
Anonymous deploy output rejects credential-bearing URLs and custom ports. An invalid
explicit claim URL is refused, rather than swallowed and replaced with a derived URL.
The parser accepts the CLI's complete pretty-printed JSON and JSON lines. It
requires an explicit deployment id, provider-issued claim URL and native expiry;
it never reconstructs identity or a claim credential from the app hostname.

A CLI acknowledgement alone cannot establish serving health, data-transfer safety,
resource retirement or final usage. The common hosting coordinator requires separate
provider observations for those postconditions.

## Delivery coverage (ADR-0182: I14)

`lakebedResolverRegistry({ host, resolveCredential })` ships one resolver,
`lakebed.capsule/v1`, over the `LakebedDeployHost` seam (the `lakebed-deploy`
driver that runs next to the reconciler). A reconcile builds one
`hobo.driver-program/v1` with `realizeResourcePlans`, so Capsule KV, File Store
and Reactive DB resources declared in `desired.resources` ride inside the same
capsule deploy. Readiness is a probe of the parsed `https://*.lakebed.app`
origin; a live capsule serving another digest is refused (deliver to a new
deployment id), and a retired one is never resurrected.

`LAKEBED_HOSTING_COVERAGE` (contract `hobo.provider-hosting-coverage/v1`,
`data-models/hosting_coverage.{proto,cue}`) lists the resolved product, the
four refused products (`lakebed.capsule-kv/v1`, `lakebed.file-store/v1`,
`lakebed.reactive-db/v1`, `lakebed.traffic-route/v1`) with remediation, and the
traffic profile: `inprocess.weighted` + `driver.route-bind` present, the other
fifteen portable offerings declared absent with a reason.
`lakebedProductRefusal(productId)` returns the typed
`RESOLVER_PRODUCT_UNSUPPORTED`. The driver seam is pinned by
`contracts/provider-lakebed-deploy-host.pact.json`.

Metrics: with `metrics` and an injected `nowMs`, every call emits
`hobo.cd.resolver.operations` and `hobo.cd.resolver.duration` through a
`TelemetrySink`-shaped sink; an export failure never changes an outcome.

## Runbook

| Symptom | Meaning | Action |
|---|---|---|
| `RESOLVER_CREDENTIAL_MISSING` | the brokered `lakebed.deploy` token did not resolve | re-enroll the Camp's deploy token; the token never appears in records |
| `RESOLVER_PROVIDER_REJECTED` "serves another artifact" | a promotion tried to replace a live deployment in place | deliver to a new deployment id and shift traffic in-process |
| `RESOLVER_PROVIDER_REJECTED` "was retired" | the deployment id was retired | use a new deployment id; retired capsules are not resurrected |
| `RESOLVER_OUTPUT_UNPARSEABLE` | the driver reported a URL outside `https://*.lakebed.app` | inspect the driver; nothing is probed or recorded until it answers a Lakebed origin |
| outcome `ready: false`, diagnostic `HTTP 5xx` | the capsule is deployed but not serving | the reconciler re-observes; verification fails closed meanwhile |
| `RESOLVER_PRODUCT_UNSUPPORTED` for kv, file-store or reactive-db | the resource was requested on its own | declare it in `desired.resources` of the capsule deployment |
