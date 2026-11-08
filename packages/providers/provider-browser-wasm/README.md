# @hobo/provider-browser-wasm

Browser WebAssembly CloudProvider for HoBo: an equivalence map from the
`compute`, `kv` and `queue` ports onto in-browser component-model guests, a
host-origin driver that fetches and verifies a guest bundle before anything
runs it, and the temporary/agent Environment Station contract.

```sh
pnpm --filter @hobo/provider-browser-wasm test
```

## What this package does

- **Equivalence → default Resource Definitions** (`EQUIVALENCE_CLASSES` /
  `createBrowserWasmProvider`), with Matching's `satisfies` answering
  full/partial/none rather than fabricating parity.
- **Placement in a browsing context.** `parseGuestPlacement` refines an authored
  option bag; `createHostAssetClient` reads the host's capability report and the
  guest manifest, fetches the component and verifies its digest;
  `provisionGuest` decides whether the context can actually support the
  placement and only then hands the bytes to a `GuestRuntimePort`.
- **Honest persistence.** `negotiatePersistence` downgrades visibly and never
  upgrades: a receipt records both what was asked for and what was obtained.
- **Release that says what is left behind.** `releaseGuest` reports `released`
  only when the worker stopped and the partition went, `retained` with a reason
  when the partition is deliberately kept, and `orphanedGuest` is what a closed
  tab leaves for the next run to reconcile.

## What it does not do

- **No control plane and no account.** The only thing on the far side of the
  wire is the host page's own asset origin. There is nothing to authenticate to
  and no API key anywhere in this package.
- **No cross-origin bundles.** A component fetched from another origin is code
  from somewhere else running with every capability the host grants its guests.
  The transport guard refuses it, and refuses a redirect, which is how a
  same-origin fetch quietly becomes a cross-origin one.
- **No engine.** Instantiation happens behind `GuestRuntimePort`. Outside a
  browser the default is `createUnavailableRuntime`, which fails closed —
  a stand-in that "ran" the guest would make every receipt downstream a claim
  about an instantiation that never happened.
- **No capability it can grant itself.** Cross-origin isolation and OPFS come
  from the document and the browser. This package reads them and refuses
  placements they cannot support.

## Parse, don't validate

Nothing in this package re-checks a value it already accepted. Untrusted input
crosses one parser and comes out as a **derived domain type** that cannot hold
the bad case:

- `parseGuestPlacement` turns the untrusted
  `.with(browserWasm.placement(...))` option bag into a `GuestPlacement`: a
  DNS-1123 guest id (it becomes a label in the station URL), a port paired with
  its own resource class by construction, a memory limit that is a whole number
  of 64 KiB WebAssembly pages, and a bounded epoch deadline. `unavailable` is
  not accepted as a request, because it is an outcome the host reports.
- `parseHostCapabilities` turns the host's capability document into a
  `HostCapabilities`. It rejects the one internally inconsistent answer —
  durable OPFS without dedicated workers — because OPFS sync access handles are
  worker-only, so that host is describing something it cannot do.
- `parseGuestManifest` yields a `GuestManifest` whose `componentPath` is a
  same-origin `.wasm` path under the guest's own bundle directory, whose digest
  is `sha256-<hex>`, and whose id is the id that was asked for. A manifest
  served under one guest's path describing another is how the wrong component
  gets instantiated.
- `verifyComponentArtifact` is where the manifest's claim about the bytes is
  settled: media type, declared length, digest, and the component-model
  preamble. Everything downstream may treat the bundle as "the component the
  manifest described" *because* this ran and agreed. The three ways it says no
  are all real — a static host answering a missing `.wasm` with its
  single-page-app document, bytes that do not match the digest, and a core
  module with a perfectly correct digest.
- `parseHostFault` reads the origin's own error envelope, so a `GUEST_NOT_FOUND`
  is distinguishable from a transport failure.

`data-models/provider_browser_wasm.proto` is the design-time wire view of these
shapes and `data-models/provider_browser_wasm.cue` carries the invariants the
parsers enforce (page-aligned memory limits, digest form, a receipt whose
artifact digest equals its manifest digest, shared memory implying a
cross-origin-isolated host, `released` requiring both halves of the teardown).
The parsed types above are the executable view of that pair.

## Why the asset guard is this package's own

Eight provider transports in this repo delegate to `guardTransport` in
`@hobo/core`. This one cannot, and the blocker is structural rather than a
policy gap: `TransportResponse.body` in core is a `string`, and this transport's
is a `Uint8Array` because one of its two routes returns WebAssembly.

Routing bundle bytes through a string-bodied guard is not a typing
inconvenience, it is corruption. The three bytes `ff fe 80` decode under UTF-8
to three U+FFFD replacement characters and re-encode as nine — an 11-byte
preamble becomes 17 — and `guardTransport`'s byte cap would then be measuring
the corrupted length rather than the bundle's.

Same-origin is a second difference, but a smaller one: it is an *additional*
constraint on top of an allowlist, not a replacement for one, and it comes with
a dev-server escape (`http://localhost:3000`) that core refuses on the port as
well as the scheme.

What is shared is the rule that actually drifted: `encodesPathSeparator` comes
from `@hobo/core`, so the percent-encoded-separator refusal has one definition
across every transport in the repo.

## Contracts

`contracts/provider-browser-wasm-host-origin.pact.json` is the consumer-driven
contract for the host origin's `/_hobo/` routes; `test/contract.test.ts` replays
every interaction through the real client, digesting the pact's real bytes with
real Web Crypto. See [`contracts/README.md`](contracts/README.md).

## Event architecture

This package is a strategy leaf: it holds no reducer, no stream, and no store.
Its job is to turn one host interaction into facts a durable plane can record,
and that machinery lives in the deploy plane and — for a guest's own state — in
`@hobo/runtime-browser`'s OPFS journal, not here.

The flow for one guest:

1. A **command** from the deploy family — `PlaceGuest`, `ReleaseGuest`,
   `ReconcileOrphanedGuest` — is what a caller issues. `provisionGuest`,
   `releaseGuest` and `orphanedGuest` are the effectful halves those commands
   invoke.
2. Each returns an observation, not a durable fact: a `ProvisionReceipt`, a
   `CleanupOutcome`. The deploy coordinator **actor** is what turns them into
   the **events** `GuestPlaced`, `BundleVerified`, `PersistenceDowngraded`,
   `GuestReleased` and `GuestOrphaned`.
3. That actor appends the command and its events to the durable **event store**
   on the `deploy:<guestId>` stream under an optimistic `expectedSeq`. The
   records here are designed to be appendable: digests, origins, worker and
   partition names, instants — never bytes and never a session token from the
   page's URL.
4. Folding that journal back yields a **snapshot** of the guest: the digest last
   verified, the persistence actually obtained, and whether the last release
   completed. That snapshot is what makes the next run reconcile an orphan
   instead of leaving a second partition behind.
5. The guest **projection** over that snapshot is the **materialized view** the
   station page renders, and it is the **read store** for the guest URL, phase
   and effective persistence. It cannot report a guest durable when the last
   `PersistenceDowngraded` said otherwise, and it cannot retire a guest whose
   last cleanup raised `CLEANUP_INCOMPLETE`.

Two distinctions keep step 5 honest, and both are why the records are shaped the
way they are: **requested** persistence is a separate field from **effective**
persistence, and `released` is a stronger claim than `retained` or `orphaned`.

## Error codes

`BrowserWasmProviderError.code` is one of `HOST_UNSUPPORTED`,
`BUNDLE_UNAVAILABLE`, `BUNDLE_DIGEST_MISMATCH`, `BUNDLE_NOT_A_COMPONENT`,
`PROVIDER_CONTRACT_CHANGED`, `PLACEMENT_REJECTED`, `PERSISTENCE_UNAVAILABLE`,
`GUEST_INSTANTIATION_FAILED`, `CLEANUP_INCOMPLETE`.

Every message and detail passes `redactHostText`. In a browser the string most
likely to carry a secret is a URL, so `access_token=…`-shaped query parameters
and bearer tokens never reach a console line or a receipt.

## Validation

```bash
pnpm --filter @hobo/provider-browser-wasm run test
```

## Hosting budget execution

A browser worker's placeholder price is marked `pricingStatus: "unknown"`; absence of
a provider invoice does not establish the cost of its hosting origin, networking or
persistent storage. Durable placement continues to require real dedicated workers and
OPFS; the Node-only unavailable runtime refuses to fabricate instantiation.

The shipped `provisionGuest` / `releaseGuest` path requires a real `GuestRuntimePort`.
A closed tab is an orphan requiring reconciliation. Released state requires actual
worker termination and, unless explicitly retained, partition removal. Stateful moves
require the app's write-ownership and transfer evidence in addition to those host facts.
