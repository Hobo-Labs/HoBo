# @hobo/provider-webernetes

Webernetes — the **local** yard — as a HoBo `CloudProvider`: an equivalence
table, Matching answers over it, a driver program per plan, and a temporary
Environment Station that this provider really can stand up, because standing it
up needs no account.

`src/` has no `fetch`, no `process.env`, and no filesystem access. The single
seam is `LocalTempTransport`, injected by whoever hosts the station — in this
repo, the Examples dev server (`site/scripts/vite-temporary-station-api.mts`),
which answers same-origin at `/api/anon/host/<id>/`.
An unconfigured transport refuses before producing a station result. The provider
does not invent a `.hobo.localhost` URL and present it as a running host. Consumers
must independently probe the returned endpoint before routing application traffic;
the endpoint parser proves locality and credential hygiene, not service health.

## What the provider actually claims

| Abstract port | Resource class | Service | Features admitted |
|---|---|---|---|
| `compute` | `webernetes:pod` | Local Webernetes | `http`, `container` |
| `kv` | `webernetes:kv` | Local KV | `key-value` |
| `queue` | `webernetes:queue` | Local queue | `queue` |

`WEBERNETES_PORTS` is the frozen source of this admitted port list.

The compute row is deliberately one feature shorter than a hosted provider's:
there is no `managed`, because nobody operates a pod on a developer's machine.
A requirement that asks for `managed` gets a **partial** match naming it, which
is what stops it from landing here.

### Deliberately absent

| Not claimed | Why |
|---|---|
| Regions | `regions: ["global"]`. A local yard has one place, and it is wherever the machine is. |
| Buckets, relational data, anything else | Not in the equivalence table, so `satisfies` answers `none`. |
| Public reachability | Stations are loopback, RFC1918, or `.hobo.test` overlay names, and the parser enforces it. A public URL from the transport is a rejection, not a station. |

The zero in `estimateCost` is marked `pricingStatus: "verified-zero"` for
incremental vendor charges: a local pod produces no vendor invoice. This does
not erase operator hardware, power or shared infrastructure exposure, which
belongs in the shared authority's existing commitments.

## Parse, don't validate

`src/parse.ts` is the only place untrusted input crosses into this package, and
what comes out are **derived domain types** that cannot hold the bad case:

- `parseWebernetesResourcePlan` turns a deploy plan of `unknown` provenance into
  a `WebernetesResourcePlan` whose `port` is one the local yard hosts and whose
  `name` is a branded `WebernetesResourceName` — already a DNS label, because it
  becomes part of a local named endpoint (ADR-0130). `realize()` calls it first.
- `parseWebernetesLocalEndpoint` is the important one. Every URL the transport
  returns crosses it and comes back as a `WebernetesLocalEndpoint` carrying its
  scheme, its lowercased host, and its **locality** — `loopback`,
  `private-network`, or `overlay`. A public host, a `file:` URL, userinfo in the
  authority (a credential inside a locator, which ADR-0027 forbids), or a bare
  `.hobo` name never becomes one. No code downstream re-parses the string to ask
  where the station lives; the parsed type already knows.
- `parseWebernetesStationDeployment` applies that to the transport's whole
  reply, so `provisionTemporaryEnvironmentStation` returns a result whose
  `anonymous: true` is backed by the endpoint being local rather than by the
  function asserting it.
- `parseWebernetesBindings` refuses a deploy output that is a document rather
  than a locator, and `parseWebernetesPort` / `webernetesPortOrUndefined` split
  the port question into the contract-violation form and the ordinary Matching
  form.
- Rejections are one type, `WebernetesInputRejectedError`, carrying the code
  `HOBO_WEBERNETES_INPUT_REJECTED` and the offending field.

`data-models/provider_webernetes.proto` is the design-time wire view of these
shapes and `data-models/provider_webernetes.cue` carries the invariants the
parsers enforce (DNS-label names, the three-row equivalence table, no `managed`
on a local pod, http-or-https with no userinfo, loopback/overlay host forms, and
a TTL that is bounded and non-zero). The parsed types above are the executable
view of that pair. No buf codegen is wired for this package, so the TypeScript
declarations sharing a proto message name are marked `domain-view:` where they
are declared.

## Event architecture

This package is a strategy leaf: it owns no reducer, no stream, and no store.
The durable machinery is the yard placement plane in `@hobo/broker`
(`src/yard-placement/`).

1. The **command** side of the yard family is recorded as facts rather than a
   separate type: `yard.PlacementRequested` and `yard.GenerationRequested` are
   what a caller issues. `capabilityManifest()`, `satisfies()`, `estimateCost()`,
   `realize()`, `client()`, and `provisionTemporaryEnvironmentStation()` are the
   halves those commands drive here.
2. The plane turns the answers into the **events** of the `yard.*` family —
   `yard.MatchDecided`, `yard.GenerationReserved`, `yard.GenerationProvisioned`,
   `yard.TemporaryAccountProvisioned`, `yard.GenerationFailed`,
   `yard.PlacementResolved`, `yard.PlacementRejected`. A refused transport reply
   surfaces as a rejection carrying `HOBO_WEBERNETES_INPUT_REJECTED` and the
   field that failed, so the reason survives into the stream.
3. `foldYardEventStore` is the **actor** over that stream: it consumes the
   family and rebuilds `YardEventStoreState` from the durable **event store**,
   the SQLite-backed journal behind the ports in `@hobo/storage-sqlite`
   (ADR-0135) — one partition, one writer, appends fenced by stream head.
4. `snapshotYardEventStore` / `restoreYardEventStore` are the **snapshot** pair
   the next fold resumes from instead of replaying the whole journal.
5. `inventorySnapshotFromFold` produces `YardInventorySnapshot`, the
   **materialized view** the placement **projection** reads, and
   `YardPlacementDecisionRow` / `YardGenerationAttemptRow` are the **read store**
   rows the Examples console and `hobo yard status` render. What this package
   contributes to those rows is a port name, a resource class, a local station
   URL, and an expiry — never a credential, because a URL carrying one cannot
   get past the parser.

The station lease is what keeps the read model honest over time: `expiresAt` and
`ttlSeconds` come from the shared `TEMPORARY_STATION_TTL_MS` in `@hobo/core`, so
a projection showing a live local station is showing one that has not yet
expired rather than one nobody has re-checked.

## Usage

```ts
import {
  createWebernetesProvider,
  provisionTemporaryEnvironmentStation,
} from "@hobo/provider-webernetes";

const provider = createWebernetesProvider();
provider.realize({ name: "hello-world", port: "compute" });

// Inject the host that actually serves the station. Omitting it refuses.
await provisionTemporaryEnvironmentStation({
  stationId: "st-1",
  transport: {
    async provision({ stationId }) {
      return {
        stationUrl: `http://localhost:4321/HoBo/api/anon/host/${stationId}/`,
        claimUrl: `http://localhost:4321/HoBo/api/anon/host/${stationId}/#claim`,
      };
    },
  },
});
```

## Tests

Fully offline.

```sh
pnpm --filter @hobo/provider-webernetes test
```

Gates protecting this package: TypeScript (`strict`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), two consumer-driven
contracts — `contracts/provider-webernetes-yard-boundary.pact.json` replayed
against the real provider in `test/boundary.contract.test.ts`, and
`contracts/provider-webernetes-local-station.pact.json` replayed through a faked
`LocalTempTransport` in `test/local-station.contract.test.ts` — plus the
protobuf + CUE boundary shapes in `data-models/`.
`test/endpoint-cue.test.ts` runs the actual CUE validator against loopback,
IPv6, private-network and overlay records, and rejects public locators labelled
local, mismatched authority fields and invalid IPv4 ranges. The temporary station
test also serves and probes a real loopback HTTP endpoint through the injected host.
