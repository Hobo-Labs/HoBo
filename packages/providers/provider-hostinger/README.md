# @hobo/provider-hostinger

The Hostinger `CloudProvider`: the Hostinger row of the cross-cloud equivalence
table, a full allocatable Yard catalog, and bearer-token `ResourceResolver`s
that **adopt and converge** what you already bought.

```sh
pnpm --filter @hobo/provider-hostinger test
```

## Read this first: on Hostinger, allocation is a purchase

Every other provider in this repo allocates a resource with an API call.
Hostinger sells *hosting plans*: a VPS, a hosting plan and the MySQL database
that comes with it are all obtained by placing a billing order, and the public
API manages instances you already own.

This package is built around that rather than papering over it:

- `reconcile()` finds the instance you bought, converges its mutable state, and
  reports what it found. `adopt` is the normal outcome here, not an edge case.
- When there is nothing to adopt, it refuses with remediation naming the
  purchase — it does not place the order.
- The refusal is enforced by the **transport**, not just by the code: the guard
  allowlists `/api/vps/v1/` and `/api/dns/v1/` and deliberately not
  `/api/billing/v1/`. A later edit cannot quietly start spending the account's
  money without widening a policy a reviewer sees.
- `delete()` on a VPS refuses too: destroying one means cancelling a paid plan.
  Cancel it in hPanel; a later reconcile will then report the resource absent.

## What this package ships

- **Equivalence → default Resource Definitions** (`EQUIVALENCE_CLASSES` /
  `createHostingerProvider`), with Matching's `satisfies` answering
  full/partial/none rather than fabricating parity.
- **`realize()` → `hobo.iac-program/v1`** for the primary Pulumi lane, with
  bind edges resolving as `${resources.<dep>.outputs.binding}`.
- **A typed authoring surface**: `hostinger.with.vps(…)` and friends, plus slot
  factories (`vps()`, `webHosting()`, `staticSite()`, `mysql()`, `dnsZone()`)
  that each own one `(slot, profile, productId)` triple.
- **A default Yard catalog** (`hostingerYardSpec()`), as canonical rows
  `@hobo/yards` parses.
- **Adopt-and-converge resolvers** (`hostingerResolvers()`) against
  `developers.hostinger.com` over an injected, guarded transport.
- **The published Capability Manifest**, with declared cost facts and a
  credential-locator auth posture that stores no material.

## Honest scope

- **Two equivalence classes, not six.** Hostinger sells no object store, no
  managed cache and no managed queue, so `bucket`, `kv`, `queue`, `topic` and
  `secretRef` carry no rows and the equivalence table has two entries. An app
  that needs an S3 bucket gets a truthful `none` from this provider.
- **No live deploy is proven here.** The resolvers are exercised against an
  *injected fake* transport modelling a Hostinger account. A real deploy
  additionally needs a real token, real network egress, and an account with
  plans already purchased.
- **All 5 catalogued products have resolvers**
  (`HOSTINGER_RESOLVED_PRODUCT_IDS`): the VPS and the DNS zone on
  `/api/vps/v1/` and `/api/dns/v1/`, and web hosting, static sites and MySQL on
  `/api/hosting/v1/`. An earlier revision excluded the last three on the grounds
  that hPanel was the only way to reach them; that was wrong — `/api/hosting/v1/`
  carries `GET|POST /websites`, `DELETE /websites/{domain}`, and the same shape
  for `accounts/{username}/databases`. `HOSTINGER_UNRESOLVED_PRODUCT_IDS` is now
  empty, and stays exported so that stops being true loudly rather than quietly.
- **Widening the guard to `/api/hosting/v1/` did not make this provider able to
  buy anything.** That namespace fills a plan; it does not order one. A website
  create requires `desired.orderId` — a plan the account already owns — and
  refuses without it, and `/api/billing/v1/` is still not allowlisted.
- **The MySQL user password comes from the host's custody**, through the
  injected `resolveDatabasePassword(logicalId)`. It cannot travel in `desired`:
  core refuses credential-shaped keys in a property bag, because `desired` is
  recorded in the event log. The published `endpoint` output is a locator, not a
  DSN, for the same reason.
- **No Resource Definitions are registered** for the `hostinger.*` product ids,
  so a deploy against this Yard still fails closed at resolution
  (`YARD_BINDING_PRODUCT_UNKNOWN`).
- **Endpoint paths and field names are transcribed** from Hostinger's published
  API reference, not replayed against the running service.
- **Cost facts are `declared-provider`.** The VPS price is a monthly plan price
  divided by 730 so it compares with the hourly providers; the multi-year
  discount Hostinger advertises is a real saving it does not model, so it
  over-states rather than under-states. The MySQL price is a genuine zero — the
  database is included with the plan — and `included: 730` is what carries that
  meaning.

## No inline secrets, on a surface that offers one

Hostinger's VPS setup call accepts a root password. This resolver refuses one:
a `ResolveRequest` is recorded in the event log, so a password in it is a
password in the log, permanently. `desired.password`, `rootPassword`,
`privateKey` and `sshPrivateKey` are rejected before a call is made, and setup
is expressed with `desired.publicKeyId` — the id of an SSH key already uploaded
to the account, which is a reference rather than a secret.

## Convergence, and what it costs

Pinned VPS identities use a direct physical-ID read. A renamed purchased VPS cannot
be replaced by another machine with its old hostname; a missing pinned identity is
not permission to adopt or create a replacement. Name-addressed hosting products
require the pinned domain/database identity to match before any provider call.

Read outputs report `ready` and `operationConfirmed` only from explicit running,
enabled or usable provider state. Mutating acknowledgements remain unconfirmed until
observation. VPS removal still refuses billing cancellation and retains the purchased
resource; a routing change or cancellation refusal does not prove its bill ended.
The financial authority must retain that term's liability through settlement.

The VPS API does not expose a trustworthy application artifact digest. This adapter
does not invent one: production execution needs an independent authenticated
application observation bound to the provider-observed machine/address. A running OS
alone does not establish an app deployment.

Catalog positive rates are `pricingStatus: "estimate"`; a database included in an
already-purchased plan is `"unknown"` until the parent plan and entitlement are
authoritatively bound. It is not an independently free hosting product. Lifecycle
regressions and actual `#CostFact` CUE fixtures cover these boundaries.

1. **A hostname that matches twice is a refusal, not a coin flip.** Hostinger
   does not enforce hostname uniqueness, and picking one by listing order would
   make the managed resource depend on the order the API answered in.
2. **Setup never re-runs on a provisioned machine.** Re-running it wipes the
   disk, so a machine adopted by id that already has an OS has its hostname
   converged and everything else reported.
3. **The DNS zone PUT is a full replace.** Hostinger drops any record the body
   omits, so the whole authored record set is sent every time and
   `desired.records` is passed through rather than rebuilt field by field.
4. **`"replace"` is never emitted** and nothing here polls; asynchronous state
   lands in `diagnostics` as *accepted, not confirmed*.

## Parse, don't validate

Every untrusted value crosses a parse boundary that returns a derived parsed
type or a typed refusal: `parsePublishedManifest` for the published well-known
documents, `expectRecord`/`expectList` for an API response body (Hostinger
answers some collections bare and some wrapped in `{data}`, and both are parsed
rather than coerced), `resolveToken` for a `credentialRef`, and `slotBinding()`
in `@hobo/core` for every catalog row.

## Event architecture

The provider holds no state. Its manifest snapshot enters the event store as a
registry fact; Matching folds the registry materialized view and records
`match.Decided`; the single-writer ResourceActor dispatches realization; and
`normalizeHostingerYardSignal` folds native VPS and DNS signals into `yard.*`
events. Read stores rebuild from the log, so no snapshot here is load-bearing.
See [`ADR.md`](./ADR.md) for the full command/event walk.

## API surface reached

| Product | Endpoint |
|---|---|
| `hostinger.vps/v1` | `GET /api/vps/v1/virtual-machines`, `GET/POST …/{id}/setup`, `PUT …/{id}/hostname` |
| `hostinger.dns-zone/v1` | `GET/PUT/DELETE /api/dns/v1/zones/{domain}` |

`/api/billing/v1/` is **not** reachable from this package, by policy.
