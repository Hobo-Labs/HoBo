# `@hobo/convex`

The Convex web-app primitive for Bindles: `b.web(convexApp(root))`.

It is deliberately small. `convexApp(root)` stamps a marker — a framework tag
and a repo-relative root — and `discoverConvexEnv` probes that root for the
`convex/` directory and `convex/auth.config.ts`, returning the environment
dependencies a ship actually needs. Nothing here calls Convex, mints a
credential, or decides where the backend runs; a Bindle asks for a backend with
`b.data()` and Matching decides who serves it.

```ts
import { bindle } from "@hobo/bindles";
import { convexApp, discoverConvexEnv } from "@hobo/convex";

const definition = bindle((b) => {
  const backend = b.data();
  const auth = b.external({ endpoints: { workos: "https://api.workos.com" } });
  const web = b.web(convexApp("examples/convex-swaghaus")).dependsOn(backend, auth);
  return { backend, auth, web };
});

const discovered = await discoverConvexEnv(repoRoot, "examples/convex-swaghaus");
```

## What the discovery reports

| Key | Bindle primitive | Supplied by |
|---|---|---|
| `CONVEX_DEPLOY_KEY` | `env` | a broker-minted deploy key, never Bindle config |
| `VITE_CONVEX_URL` | `data` | the binding Matching realized for `b.data()` |
| `VITE_WORKOS_*`, `WORKOS_*` | `external` | `b.external()` WorkOS AuthKit or a Camp `secretRef` |

The WorkOS keys are dropped when `convex/auth.config.ts` does not mention
WorkOS, because a dependency nobody needs is a dependency somebody has to
explain away later.

## Parse, don't validate

Both entry points are parse boundaries producing derived domain types:

| Raw input | Parser | Derived type | Impossible afterwards |
|---|---|---|---|
| `root: string` | `convexApp` | a frozen `ConvexWebAppMeta` | an empty or untrimmed root becoming a marker |
| repo root + relative root | `resolveConvexRoot` | a checked absolute path | a root escaping the repo through `..` |
| an app tree | `discoverConvexEnv` | a frozen `DiscoveredConvexEnv` | a claimed auth config without the `convex/` directory that holds it |
| annotations | `convexRootFromAnnotations` | the root string | a web resource being treated as Convex without the marker |

Downstream code takes the parsed value, so `resolveConvexRoot` is the only place
that can refuse an escaping path and there is nowhere that re-checks it. The
protobuf records in `data-models/convex_app.proto` are the wire projection of
those parsed types; `convex_app.cue` carries the invariants over them — a
repo-relative root with no `..` segment, uppercase variable names, an absolute
path that ends in its own root, an auth config that implies its directory, every
discovered key bucketed exactly once, and WorkOS keys that can only arrive
through an `external` bucket.

No record holds a value. Every field names an environment variable; the deploy
key itself is a locator the broker mints.

## Event architecture

This package holds no state and appends nothing — it stamps an annotation and
reads a directory. Its records become durable through the deployment plane:

- **Commands** — the discovery record is the payload of the `CompileDeploymentOffer`
  and `StartGuestDeployment` **commands** in `@hobo/claims`; a later claim of the
  realized backend drives `BeginClaimItem`, `VerifyOwnership`, and
  `RotateCapabilityBinding` on the same aggregate.
- **Events** — the claim coordinator **actor** (`reduce` in `@hobo/claims`) emits
  `DeploymentOfferCompiled`, `GuestDeploymentStarted`,
  `ProviderSubjectProvisioned`, and `CapabilityBindingRotated`. A
  `ConvexAppDiscoveryRecord` is safe in those bodies precisely because it names
  keys rather than holding them.
- **Event store** — the host appends those events to the durable SQLite-backed
  **event store** under per-stream OCC and a fencing token. The `convex deploy`
  effect happens outside that transaction, keyed by the offer's idempotency key,
  so a retried deploy does not create a second deployment.
- **Projections / materialized views** — the stream folds into the
  **materialized views** the CLI and the try-site read: which web resources are
  Convex apps, the env keys each one still needs bound, and the current
  deployment URL.
- **Snapshots / read store** — periodic **snapshots** of the deployment aggregate
  back the **read store** that answers `hobo status`; historical snapshots keep
  the app root and env set a deployment was compiled from auditable after the
  app tree moves on.

## Contracts

- `data-models/convex_app.proto` / `.cue` — the marker, the dependency bucket,
  and the discovery record, plus the invariants above.
- `contracts/pacts/convex-app-deployment-plan.pact.json` — the boundary these
  records cross into a deployment plan: a planned app answers with locators, an
  escaping root is refused, plaintext deploy-key material is rejected rather than
  stored, and a root with no `convex/` directory is not planned as a Convex app.

## Tests

```bash
pnpm --filter @hobo/convex run test
```

Offline: the discovery lane probes this repo's own `examples/convex-swaghaus`
tree, and nothing contacts Convex or WorkOS.
