# @hobo/provider-netlify

Netlify CloudProvider for HoBo Examples OOB yards.

- Equivalence → default Resource Definitions (`EQUIVALENCE_CLASSES` / `createNetlifyProvider`)
- Matching `satisfies` full|partial|none (no fabricated parity)
- Temporary/agent Environment Stations: `supportsAnonymousTemporaryDeploy=true`
- Temporary provision via injectable/local transport — no permanent API tokens
- **`netlify.anonymous-static-site/v1`** — a genuinely anonymous, deliberately
  narrow claimable static site. See below.

```sh
pnpm --filter @hobo/provider-netlify test
```

## `netlify.anonymous-static-site/v1`

### Genuinely anonymous, and narrow on purpose

`netlify deploy --allow-anonymous` deploys with no account, no payment method,
and no HoBo-owned tenancy. The site belongs to nobody until a human claims it,
and Netlify removes it an hour later if nobody does. That is a materially
different offer from the Vercel sponsored path in `@hobo/provider-vercel`, where
HoBo owns the account and pays the bill, and the two are never collapsed into one
"claimable hosting" bucket:

| Fact | Value |
| --- | --- |
| `bootstrap` | `anonymous-claimable` |
| `anonymousDeployment` | `true` — no account and no payer before the claim |
| `sponsorExposureMinorUnits` | `0`, and load-bearing: HoBo funds nothing here |
| `claimAtomicity` | `single-resource` — one site, one ceremony, one thing that can fail |
| `claimActionCount` | `1` (a human opening the claim URL) |
| Unclaimed behaviour | Netlify removes the project after one hour |

The definition implements **`web.static/v1` and `web.hosted/v1` only**. Netlify
Functions, Edge Functions, and SSR are real Netlify capabilities, but they are
not verified on the anonymous `--no-build` path, so a requirement that asks for
`api.http/v1`, `web.ssr/v1`, or any service profile is **rejected** rather
than quietly served by a definition that never proved it. Absent capabilities are
declared `false` rather than omitted, because an omitted key is
indistinguishable from an unread one.

The richer surface lives in a **separate** definition,
`netlify.authenticated-site/v1`, which is not anonymous and not claimable. The
temptation after shipping the anonymous path is to widen it; two definitions keep
the claim story and the capability story from contaminating each other.

### Provider / product / capability / bootstrap / claim / binding

| Provider | Product | Capability profiles | Bootstrap | Claim | Binding |
| --- | --- | --- | --- | --- | --- |
| `netlify` | `netlify.anonymous-static-site/v1` | `web.static/v1`, `web.hosted/v1` | `netlify deploy --allow-anonymous --no-build --json` through an injected `ProcessRunner`; no account, no credential | **1** human action at the claim URL; deadline **1 hour**; `single-resource`; unclaimed ⇒ provider removes the project | `binding.http/v1` (no credentialed binding — a static site produces none, so no rotation obligation is invented) |
| `netlify` | `netlify.authenticated-site/v1` (shape only — no driver, unselectable) | `web.static/v1`, `web.hosted/v1`, `web.ssr/v1`, `api.http/v1` | operator credential (`bootstrap.netlify.operator-credential/v1`) | none — the deploying team already owns the site | `binding.http/v1` |
| `netlify` | temporary Environment Station (`temporary-station.ts`) | agent/temporary station | anonymous CLI deploy | pre-existing behaviour, unchanged | n/a |

### The CLI is a pinned, argv-shaped port

The whole path is a subprocess invocation, which makes argv the attack surface.

- **`NETLIFY_CLI_VERSION = "27.1.1"`** (`NETLIFY_CLI_PACKAGE_SPEC =
  `netlify-cli@27.1.1``). Bumping it is a contract change: this adapter parses
  that release's `--json` output.
- **`ProcessRunner.run(argv: readonly string[], opts)`** — arrays only. There is
  no overload taking a command line, so there is no shell to quote for and a
  publish directory named `; rm -rf /` is one inert element. The Node adapter
  spawns with `shell: false`.
- **Argument arrays stop shell injection but not *option* injection**, so values
  are additionally checked (`assertInertArgument`): a leading `-` is refused
  (a site name of `--prod` would be read as a flag), as are null bytes, which
  `execve` truncates at. It **checks rather than sanitizes** — rewriting a
  hostile site name would deploy under a name the caller did not ask for.
- **The environment is built by allowlist**, not by deletion
  (`anonymousDeployEnv`). A `NETLIFY_AUTH_TOKEN` inherited from an ambient shell
  would make the deploy *authenticated*, quietly turning a claimable site into
  one that already belongs to whoever owns that token — and the deploy would
  still succeed, so nothing downstream would notice.

`test/process-runner.test.ts` asserts each of `; rm -rf /`, `$(id)`, backticks,
`site && curl …`, a newline, and path-traversal directories lands as exactly one
argv element that no neighbouring element even contains.

### Output parsing, and what it is honest about

Identity comes only from the `--json` document; anything unrecognized fails
closed with `PROVIDER_CONTRACT_CHANGED` rather than being guessed at, because a
wrong claim URL is worse than no deployment. The claim action has no documented
JSON field, so it is taken from the JSON when present and recovered from the
emitted text otherwise, then validated structurally against
`https://app.netlify.com/claim` — recorded here as **verified-by-shape rather
than documented**.

The **one-hour deadline is derived from the documented window**, and says so
(`expirySource: "documented-window"`). The CLI reports no expiry field; labelling
it `provider-reported` would pass a local calculation off as something Netlify
said. The deadline becomes the `ClaimItem.deadline`, the `GuestLease.claimBy`,
and the one-time action's `expiresAt`.

A non-zero exit is **`PROVIDER_OPERATION_AMBIGUOUS`**, not a failure: the CLI can
create the site and then fail while reporting it, so the caller must observe
before retrying. Re-running a completed idempotency key is refused with the
existing `siteId` marked adoptable — deploying again would leave an orphan
claimable site nothing tracks, sitting unclaimed until Netlify reaped it.

### After the claim

- **Ownership is verified against the API, never from CLI output.**
  `verifyOwnership` requires a client and compares the site's `account_id`;
  without one it refuses with `CLAIM_NOT_VERIFIED`.
- **The anonymous mutation credential must demonstrably stop working.** Netlify
  documents no endpoint that revokes an anonymous deploy session, so this is an
  injected `AnonymousAuthorityProbe` rather than an assumption;
  `anonymousAuthorityRevoked` starts `false` and the candidate declares
  `creatorAuthorityAfterClaim: "rotatable"` — not `"absent"`, because absence
  cannot be asserted from here.
- **No binding rotation obligation is invented.** A static site produces no
  credentialed binding for a workload to consume.

The claim URL is bearer authority over a live site that merely looks like a link.
It is deposited into custody the moment it is parsed and into the `@hobo/claims`
one-time action store; every record, receipt, plan, and error carries a
`SecretRef` instead. It is reusable inside its window (a human bounced to a login
needs the same link) — the hour is what bounds the exposure.

### Verified provider facts

| Fact | Source | Checked |
| --- | --- | --- |
| `netlify deploy --allow-anonymous` deploys without an account and creates a claimable project; **one hour** to claim; unclaimed projects are removed after one hour; a claimed project takes the team's default visibility | https://docs.netlify.com/api-and-cli-guides/cli-guides/get-started-with-cli/ | 2026-08-08 |
| Repeats the anonymous path and the one-hour window; confirms a manual deploy runs no build command | https://docs.netlify.com/deploy/create-deploys/ | 2026-08-08 |
| `deploy` flags: `--allow-anonymous`, `--json`, `--dir`, `--no-build`, `--site-name`, `--message`; official example `netlify deploy --allow-anonymous --dir ./public --no-build` | https://cli.netlify.com/commands/deploy/ | 2026-08-08 |
| `netlify-cli` latest is 27.1.1 (published 2026-08-07) | https://registry.npmjs.org/netlify-cli/latest | 2026-08-08 |

**Unverified / deliberately absent.** The claim URL shape is verified by
structure, not by documentation — no Netlify page documents a `claim_url` field
in `--json` output. No revocation endpoint for an anonymous deploy session is
documented, hence the injected probe. Functions, Edge Functions, and SSR are
**not** verified on the anonymous path and are declared `false` there. The
authenticated definition declares them, but this package ships **no
authenticated driver**, so its `executorRef` is empty and
`hasRegisteredDriver` is `false` — the candidate is therefore unselectable and
fails closed. It exists so the anonymous definition does not have to be widened
to cover the richer surface, not as a product Matching can pick today. These
facts are ranking input, never billing input, and no vendor signed anything.

### Errors and transport

Typed `NetlifyProviderError` with stable codes: `PROVIDER_RATE_LIMITED`,
`PROVIDER_AUTH_FAILED`, `PROVIDER_CONTRACT_CHANGED`,
`PROVIDER_OPERATION_AMBIGUOUS`, `PROVIDER_TOOL_UNAVAILABLE`,
`PROVIDER_TOOL_VERSION_UNSUPPORTED`, `CAPABILITY_NOT_SUPPORTED`,
`CLAIM_EXPIRED`, `CLAIM_NOT_VERIFIED`, `CLAIM_PARTIALLY_COMPLETED`,
`CLAIM_REPAIR_REQUIRED`, `BINDING_ROTATION_REQUIRED`,
`BOOTSTRAP_AUTHORITY_REMAINS`, `CLEANUP_FAILED`, `SPONSOR_BUDGET_EXCEEDED`,
`SECRET_CUSTODY_UNAVAILABLE`.

`redactProviderText` strips claim URLs, bearer tokens, `nfp_…` tokens, database
URLs with inline credentials, credential assignments, JWTs, and private-key
blocks, flattens control characters (CLI output is full of them and they can
forge a log record), and bounds length. Credential scanning follows each
value's JSON projection and guards shared or cyclic object graphs. A 404 from the site API maps to
`CLAIM_EXPIRED` rather than a generic not-found, because an unclaimed anonymous
project really is gone an hour after the deploy.

`createGuardedTransport` allows HTTPS only, to `api.netlify.com` only, on
allowlisted path prefixes, with no redirects and bounded response size and
timeout.

Tests are offline; fixtures live in `test/fixtures/` with obviously fake
credentials.

## Contracts and data models

- `data-models/provider_netlify.proto` — the records this package exchanges: the
  pinned CLI invocation, the facts parsed from `--json`, the anonymous site
  record, the two ownership signals and the verification they fold into, the
  single claim item and its compiled plan, and the receipt projection.
- `data-models/provider_netlify.cue` — the invariants over those records: the
  site id is exactly the plain identifier `assertSiteId` will place in a request
  path, `sponsor_exposure_minor_units` is `0` because HoBo funds nothing here, a
  `documented-window` deadline must equal the deploy instant plus one hour, a
  stored locator must be a `hobo-secret://` / `hobo-token://` URI with no query
  string, a receipt may carry only the redacted projection of one, the item owes
  bootstrap-authority revocation and no binding rotation, and a verification
  cannot be `verified` without being `transferred`.
- `contracts/provider-netlify-site-api.pact.json` — the consumer contract for
  the one REST read this path depends on, `GET /api/v1/sites/{site_id}`:
  readable-and-owned, forbidden, absent after the window closes, and the
  missing-account response that fails closed. `test/boundary.contract.test.ts`
  replays it through `createNetlifyClient`. The anonymous deploy itself never
  appears in it, because it has no credential to call the API with.

Neither the proto nor the CUE is compiled at runtime: this package declares no
`data-models/buf.yaml` and imports no generated `*_pb.ts`. Where a TypeScript
declaration shares a name with a message, the declaration carries a
`parallel-type-allowed:` note saying why.

## Architecture evidence

**Parse, don't validate.** CLI output and REST bodies cross one boundary and
become parsed derived types, or they fail closed:
`parseAnonymousDeployOutput` refuses output it does not recognize
(`PROVIDER_CONTRACT_CHANGED`) and validates the claim action against
`https://app.netlify.com/claim` before anyone can be handed it, `parseSite`
refuses a site with no owning account, `assertInertArgument` checks rather than
rewrites every value that reaches argv, and `depositSecret` re-parses what
custody returns so an implementation that echoes plaintext fails at the deposit.
From there the code passes those derived domain types — `AnonymousSiteRecord`,
`AnonymousClaimPlan`, `SiteOwnershipVerification` — never the raw strings.

## Event architecture

This package owns strategy and effects; the lifecycle lives in `@hobo/claims`.
One anonymous deploy produces one site, and its facts travel like this:

- **Commands.** `anonymousBootstrapCommands` and `anonymousSiteClaimCommands`
  compile the deploy and the verification into claim **commands** —
  `CompileDeploymentOffer`, `AcceptDeploymentOffer`, `ReserveGuestLease`,
  `StartGuestDeployment`, `RecordProvisionedSubject`, then `BeginClaimItem`,
  `ObserveClaimItem`, `VerifyOwnership`. The driver never mutates claim state
  itself; these commands are the whole interface.
- **Actor.** The shared `reduce` is the pure core of the claim coordinator
  **actor**. It holds the invariant this path most needs: a Netlify-reported
  claim is only an observation, and the item advances only on independent
  verification.
- **Events.** The reducer emits the **events** the host appends —
  `GuestLeaseReserved` (expiring on Netlify's hour, not a local TTL),
  `ProviderSubjectProvisioned`, `ClaimStatusObserved`, `OwnershipVerified`,
  `BootstrapAuthorityRevoked`, `ClaimItemCompleted`, and `GuestLeaseExpired`
  when nobody claimed the site and Netlify reaped it. `assertNoSecrets` rejects a
  payload containing a claim URL, which is why the URL is deposited into custody
  and the one-time action store the moment it is parsed.
- **Event store.** Those events land in HoBo's durable **event store** (SQLite
  behind the `@hobo/core` ports by default, ADR-0135). The CLI deploy happens
  outside that transaction and is not idempotent, so the attempt key is recorded
  first and a replay refuses to deploy again rather than orphaning a second
  claimable site.
- **Projection and materialized view.** Folding the claim stream produces the
  claim-bundle **projection** — the **materialized view** of what is claimed,
  what is outstanding, and when the hour runs out. `toAnonymousSiteReceipt` is
  this package's receipt-safe slice of the same facts, built by listing what may
  appear rather than by removing what may not.
- **Snapshot and read store.** Periodic **snapshots** back the **read store**
  `hobo claim` queries for current status, so asking whether the site changed
  hands reads a projection rather than re-running the CLI — and the answer
  carries a redacted custody locator, never the claim URL.

### Receipt scanner regression coverage

The receipt scanner follows custom `toJSON` projections and tracks visited
objects. It scans the returned projection for supported `toJSON` objects and
avoids revisiting cyclic or shared objects. This is a credential-shape scanner,
not a full JSON serializer or proof that arbitrary secrets cannot escape.
Custom serializers that depend on the JSON property key are not modeled. `test/custody-scanner-transport.test.ts`
pins safe locators, leaking projections, cycles, and shared references.
This changes no wire records; existing receipt Protobuf/CUE models and provider
contract tests remain the serialization gates. The package TypeScript check
covers the scanner implementation.

### Production resolver and anonymous isolation

`netlifyResolverRegistry({accountId, accountSlug, resolveCredential,
mutationJournal})` registers the authenticated site definition and
`netlify.static-deploy/v1`. Site creation independently verifies that the native
account ID and account slug identify the same account. A site read must report
that account ID; a deployment read must report the approved site and immutable
operation title. Native POSTs require a durable CAS mutation journal. Lost
acknowledgements are observed through bounded account/site deployment discovery;
a pending upload resumes only its idempotent file PUTs. A missing pinned resource
is never silently recreated.

Static desired properties are `siteId`, `operationId`, and `files`, a map of
absolute safe paths to UTF-8 content. `artifactDigest` is the SHA-256 digest of
independently fetched bytes from the immutable `deploy_ssl_url`; the expected
file map and metadata title are not accepted as content evidence. Native ready
state is not an application health or billing-final assertion. Deletion can use
native scoped identity even when the public artifact is unhealthy. Independent
absence and final usage remain necessary before budget release.

Both anonymous entry points use the pinned `netlify-cli@27.1.1`, `--no-build`,
`--allow-anonymous`, and no production flag. They copy a bounded regular-file-only
artifact into a private directory, reject symlinks and credential/build
configuration, and give the child a private HOME and XDG directories. Neither an
ambient API token nor a saved Netlify login can silently authenticate this path.
Timeouts kill the process group, aggregate stdout/stderr bytes are capped, and
truncated output leaves the external outcome ambiguous. Parsing requires the
observed deployment identity and real ownership claim URL; a hostname cannot
stand in for either. The one-hour deadline is conservatively measured from the
start of the attempt and labeled a documented window, not confirmed retirement.

`observeNetlifyAnonymousSite({stationUrl, claimUrl, expectedMarker})` validates
the data plane without claiming the site. Drop uses an HTML password form and an
origin-scoped session cookie, so HTTP Basic authentication is insufficient. The
helper uses bounded requests, posts the password only to the exact deployment
origin, inspects redirects without following them, keeps the cookie in memory,
and returns only status and marker evidence. Real anonymous acceptance on
2026-10-30 returned HTTP 200 and the expected deployed marker through this
shipped helper. This is evidence for anonymous static hosting; it does not verify
paid account APIs or provider-confirmed cleanup.

The compute capability manifest publishes the explicit
`netlify.static-deploy/v1` product ID and static/hosted profiles. The matching
`createNetlifyStaticDeployDefinition()` is included in `NETLIFY_DEFINITIONS` and
has a registered static executor; it claims neither SSR nor functions.
`staticDeployment({siteId})` and `NETLIFY_DEFAULT_BINDINGS` bind the same product
for Yard selection. A site-only control-plane record cannot stand in for this
hosting artifact.

`data-models/anonymous_health.proto` owns the new credential-free health record;
its runtime type derives generated output. `anonymous_health.cue` and the real
CUE positive/negative fixture tests require HTTP 200 for a successful marker
observation and exclude cookie material. The package now opts into scoped
Protobuf generation via `data-models/buf.yaml`; generated drift is checked by
`@hobo/schema-tools`.

A scoped ready immutable deployment read publishes `servingEndpoint` from the
validated root `deploy_ssl_url` origin after fetching artifact bytes. Foreign
hosts, userinfo, paths, queries and fragments are refused. Site control records
and pending deployments provide no serving endpoint proof; mutable primary site
URLs are not accepted as immutable deployment bindings.
