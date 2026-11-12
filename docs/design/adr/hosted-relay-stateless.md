---
type: Architecture Decision Record
title: "The Hosted CI Relay Keeps No Durable State"
description: "The hosted CI relay on Vercel becomes a twelve-factor process: config and secrets in a separate service, short-lived job state in a Redis-protocol cache it may lose, Vercel Queues for intake and per-lease steps, GitHub as the system of record. Its database, relay database fleet and Neon broker are removed."
tags: [hobo, design, adr, ci, relay, twelve-factor]
---

# ADR-0179 — The Hosted CI Relay Keeps No Durable State {#adr-0179}

**Status:** Accepted (design; implementation phased); amended 2026-11-11 with
[options routed by budget](#amendment-options-routed-by-budget) and 2026-11-12
with [secret store chosen at deploy, provisioned by claim](#amendment-secret-store-chosen-at-deploy-provisioned-by-claim). Implemented:
phases 2, 2b, 3, 4a, 4b, 4c (cache-fleet selection by budget), 5 (the
relay's helpers on the cache, offers as provider manifests; provider usage
pulls deferred) and 7 (the PostgreSQL path removed); not yet deployed
**Date:** 2026-11-11
**Supersedes, for the hosted relay:** the PostgreSQL store (`PostgresCiStore`)
as the relay's store, the relay database fleet and store selection, the Drizzle
relay schema and migrations, the Neon-hosted runtime-config broker, and the
plan to move the relay's database to self-hosted Postgres (increment 7 of
[CI Relay Mesh](../ci-relay-mesh.md#increments)).
**Amends:** [`packages/ci/ADR.md`](../../../packages/ci/ADR.md) and
[`packages/ci-gh-actions/ADR.md`](../../../packages/ci-gh-actions/ADR.md) (the
hosted host's store, the control API's configuration writes, and the Station
budget-signal bridge into the hosted relay).

## Context

On 2026-11-10 the hosted relay's Neon Postgres exceeded its plan quota and the
relay answered 503 to every request, GitHub's webhook deliveries included. The
work that followed made the database more available: choosing among attached
stores, a relay database fleet across providers, a Drizzle schema, and a plan
to self-host. Each made the relay operate more infrastructure; none removed
the dependency.

Most relay state does not need to outlive a job. GitHub holds the
authoritative state of every job, and the relay already re-reads it through
REST before it writes. What remains is configuration and secrets, which change
rarely and are written by operators, and counters with a natural expiry.

## Decision

The hosted relay keeps no durable state. In twelve-factor terms:

1. **Config and secrets are a separate service.** First binding: Infisical
   Cloud (free plan; open source, so it can later run on HoBo's own compute).
   *Amended 2026-11-12:* which service is chosen when the deployment runs and
   handed to the owner by claim; Infisical Cloud is attach-only
   ([amendment](#amendment-secret-store-chosen-at-deploy-provisioned-by-claim)).
   The relay authenticates with its Vercel OIDC token through Infisical OIDC
   Auth (a machine identity trusting `https://oidc.vercel.com/<team>`, bound to
   project and environment): no secret zero. CI authenticates with GitHub
   Actions OIDC to a separate admin identity. The relay reads config (accounts,
   policy, offers, control-token digests, routing preferences) and secrets (App
   private key, webhook secret, client secret, session key, cron secret,
   onboarding token) read-only and caches them in memory. Secret references use
   the existing `infisical` `SecretRef` scheme. Fallback binding: GCP Secret
   Manager through Vercel OIDC workload identity federation, same port.
2. **No database.** Short-lived per-job state lives in a Redis- or
   Valkey-protocol cache with TTL, compare-and-set and increment: the
   `@hobo/kv-redis-compatible` requirement (`ttl`, `atomicIncrement`,
   `atomicCompareAndSet`). First binding: Upstash Redis free tier through the
   Vercel Marketplace; self-hosted Valkey binds to the same port. As amended
   below, the cache is one of several backends — Upstash, Aiven for Valkey,
   Turso (libSQL), self-hosted Valkey, later Vercel Blob — chosen by budget
   policy, exactly one active at a time. Loss of the
   cache is tolerated: state is rebuilt from GitHub and Vercel by deterministic
   names. The cache command budget is a design constraint, so work is driven by
   queue messages, not polling.
3. **Vercel Queues where they fit:** webhook intake (idempotency key = GitHub
   delivery id; acknowledged to GitHub after enqueue; replaces the inbox),
   per-lease lifecycle steps as delayed messages keyed `${leaseId}:${step}:${n}`
   (replaces scans over all in-flight leases), repair ticks, and retries. Not
   for state reads, compare-and-set, counters, the MCP change feed, config or
   secrets: a queue cannot be read back.
4. **GitHub is the system of record for jobs.** Lease ids are UUIDv5 of
   `repositoryId:jobId:runAttempt` (a requeue generation appended after the
   first), so runner names, bridge run titles and Sandbox names are stable and
   rediscoverable; duplicates collapse.
5. **Mutual exclusion is per key:** a version compare-and-set per lease, a
   job-taken marker (`SET NX` with TTL), a small per-account in-flight index
   for concurrency limits, intent timestamps on the lease record for crash
   recovery, and the queue deadline from the GitHub job's `created_at`. The
   single partition row lock goes away.
6. **Sessions** are encrypted signed cookies; OAuth `state` is single-use
   through `SET NX`.
7. **Budgets** are declared caps; exposure is provider usage pulled on the
   relay's tick plus holds of in-flight leases. No accounting records; overrun
   is bounded by one pull interval. Broker budget-policy accounts stay
   unsupported on the hosted relay, as they already are.
8. **Config is read-only at runtime.** The hosted relay no longer serves the
   policy, providers, signals, observations, rate-observations, quarantine and
   repository-setup write endpoints; `hobo ci` writes config to the config
   service and acts on GitHub directly. Read endpoints stay.
9. **MCP** shows in-flight work only; `wait_for_events` reads a bounded TTL
   change ring and returns a cursor reset when the ring is gone.
10. **Sandbox egress and proxy caps** are counted authoritatively in the
    Sandbox's own proxy VM and mirrored to the cache.
11. **Deployment goes through HoBo:** the relay's Bindle, Yard and Camp declare
    the cache, queue, schedule and config-service bindings; `hobo ci deploy`
    plans from them; a workflow on `main` deploys, authenticating to Infisical
    with GitHub OIDC. No manual deploys.
12. **Pay only for what is used.** Neon and its integration, the Neon broker,
    the relay database fleet, store selection, the
    Drizzle relay schema and migrations, `PostgresCiStore` and its pg-bound
    helper stores, and the box worker's `HOBO_CI_STORE=postgres` option are
    removed. Turso, attached and unused when this was decided, stays as a
    cache-fleet option (amendment below).

Unchanged and out of scope: the compute fleet (mesh, capacity, runner routing
and balancing, NATS mesh state), `SqliteCiStore` for box workers and
`hobo ci serve`, `@hobo/data-postgres` including its fleet module, and the
Broker budget ledger library.

The full design, the table-by-table mapping, the hazards, the cost model and
the eight-phase delivery plan are in
[Hosted CI Relay Without Durable State](../hosted-relay-stateless.md).

## Amendment: options routed by budget

*2026-11-11.* Every option is supported, and HoBo's own capability matching and
budget policy choose among them; the relay dogfoods the routing it sells. Two
independent choices:

1. **Cache fleet** (the relay's state fleet, behind `EphemeralStatePort`; the
   compute fleet is untouched): Upstash Redis (500,000 commands a month free,
   then $0.20 per 100,000), Aiven for Valkey free (no command cap, single node,
   powered off when idle), Turso free (500 million rows read and 10 million
   written a month, blocked when exhausted; bound by `@hobo/provider-turso`),
   self-hosted Valkey (no provider cost), and Vercel Blob (first-party,
   OIDC, compare-and-set through ETags; not built, pricing unverified).
   Vercel Runtime Cache may sit in front as a read-through layer, never for
   exclusion. Exactly one backend is active, because compare-and-set is
   correct only within one; the choice reuses the engine-neutral parts of the
   relay database fleet's policy (`AssignmentReplica`, `resolveAssignment`,
   `decideFleet`), with the assignment log replicated across the cache
   backends through the port's compare-and-set, and those parts move to an
   engine-neutral package. Switching is safe because cache loss is
   tolerated: the new backend starts cold and the relay rebuilds by
   deterministic names.
2. **Lifecycle driver**, a `LeaseLifecycleDriver` port: Vercel Queues
   (delayed messages per lease step), then Vercel Workflows on Vercel's
   managed World (one durable run per job, exactly-once starts by hook token;
   $20 per million events on Pro, about 22 events a job, so about $49 a month
   at 3,700 jobs a day). Chosen per job at admission and sticky for that job,
   so switching never strands work. A self-hosted World is not viable on
   Vercel today (the Postgres World needs a long-lived worker; community
   Worlds do not support `workflow` 5) and stays a future option. The
   Workflows driver needs a Nitro entry or a custom builder in
   `@hobo/ci-vercel` and `workflow` 5.4.0 or later, pinnable from 2026-11-18.

Each option is a provider manifest whose billing lowers into the
`@hobo/pricing` catalog, registered by the deploy; preference is free, then
prepaid, then the cheapest pay-as-you-go; usage is metered per backend and
driver against its allowance; the relay switches before exhaustion, with
hysteresis, under budget caps declared in config. With no cache reachable the
relay keeps serving on a GitHub-only floor that looks a runner up by its
deterministic name before creating one; GitHub's duplicate-name behaviour is
unverified and is tested before the floor relies on it. One more owner action:
create an Aiven free Valkey service and store its connection URL in the config
service (an optional cache-fleet member, not a prerequisite). Details, sources, the cost table at measured volume and the phases
(2b, 4b–4e, 5): [Options routed by budget](../hosted-relay-stateless.md#options-routed-by-budget).

*Phase 4c, implemented.* The engine-neutral parts moved to
[`@hobo/backend-fleet`](../../../packages/backend-fleet/README.md), which
`@hobo/data-postgres` re-exports. The assignment log is kept in one key of
every cache backend (`ephemeralAssignmentReplica`), the active backend is
read from it by majority, a move is sealed for longer than twice the minute
an instance caches that answer before the target is activated, and the
repair tick routes by budget (`routeFleetByBudget`: switch at 90% projected,
back only below 80%). With no majority the relay refuses admissions
retryably. Details: [Exactly one cache at a time](../hosted-relay-stateless.md#exactly-one-cache-at-a-time).

*Phase 5, implemented.* The repair scanners (missed deliveries, queued jobs)
run on the cache with a lock per scanner and App, cursors and minute
windows; worker health is TTL'd evidence in the cache that reads as
"starting" when missing; OAuth state, sessions and App-installation state
are cache records named by an HMAC under the session key and, where they
hold a credential, sealed under a key derived from it (the browser keeps an
opaque cookie: the session holds a GitHub user token, which §6's signed
cookie would have put in the browser); the owner redeems the invitation in
the config service once and the relay creates no App. The proxy VM is the
authority for its meter: the Sandbox host reads it before stopping the VM,
so a lease rebuilt after a cache loss settles. Every cache backend and
lifecycle driver is a provider manifest in `packages/ci-vercel/offers/`,
lowered into the `@hobo/pricing` catalog, with the `kv.ephemeral-state/v1`
and `lifecycle.lease-driver/v1` profiles; the cache fleet's default offers
come from that catalog, and the start-up log records the driver choice
(Vercel Queues; Workflows not built and not pinnable before 2026-11-18).
**Deferred:** provider usage pulls for budgets (no client for Vercel's usage
API or GitHub's billing usage API exists in the repository), so exposure
stays configured spend plus in-flight holds; Vercel Blob and Queues prices
are unverified. Details: [Phase 5](../hosted-relay-stateless.md#phase-5).

## Amendment: secret store chosen at deploy, provisioned by claim

*2026-11-12.* Decision 1 named a config service, Infisical Cloud, that an
owner had to set up by hand: an organization, two projects, three machine
identities, a Vercel token and five repository variables. That checklist is
withdrawn. Agent authentication with a claim replaces it.

1. **The store is a capability, chosen when the deployment runs.** The relay
   needs `secrets.config-service/v1`. HoBo routes it when `hobo ci deploy` (or
   `hobo deploy` for an app whose Yard binds the capability) runs, through
   `hobo ci secret-store plan|provision`
   ([`@hobo/secret-store-claim`](../../../packages/secret-store-claim/README.md)):
   hard gates on evidence gathered at that moment, then HoBo's preference
   order. Nothing is pre-provisioned by hand. **Nothing is stored in Vercel
   environment secrets, and nothing in GitHub secrets or variables.** The
   chosen store's coordinates (origin, project ids, identity ids, Vercel team
   id; no credential) are committed as `deploy/secret-store.binding.json`, the
   `SecretStoreBinding` record, which `hobo ci deploy` and the deploy workflow
   read. The Yard's config-service row names the capability and that file and
   asks for three inputs (`INFISICAL_SITE_URL`, `INFISICAL_IDENTITY_ID`,
   `INFISICAL_PROJECT_ID`); it no longer hard-codes Infisical Cloud.
2. **Offers, in preference order** (`DEFAULT_SECRET_STORE_OFFERS`; facts read
   2026-11-12, ranking input only):

   | # | Offer | Agent auth | Owner's claim | Cost | Availability | Relay binding |
   |---|---|---|---|---|---|---|
   | 1 | Any store that publishes auth.md with anonymous agent registration | `@hobo/auth-md` anonymous registration | the store's claim page, sealed, opened by `hobo claim open` | the store's | the store's | designed |
   | 2 | *Experiment, opt-in only:* a Cloudflare temporary account, optionally holding HoBo's config-service Worker | Cloudflare temporary account (proof of work; the owner types acceptance of Cloudflare's Terms and Privacy Policy first) | Cloudflare's claim URL, sealed; **within 60 minutes or Cloudflare deletes the account** | none while temporary; the owner's Workers plan after | account creation is rate-limited; not the relay's store ([experiment](#the-cloudflare-experiment)) | designed |
   | 3 | HoBo-hosted Infisical (open source, self-hosted) on the owner's compute fleet | `POST /api/v1/admin/bootstrap` on a fresh instance | a sealed sign-in revealed once by `hobo claim open`; finalize revokes HoBo | no vendor fee; Infisical, PostgreSQL and Redis on the owner's hosts | **the relay's config availability becomes that host's** | built |
   | 4 | An Infisical Cloud organization the owner already has | none: attach-only | the owner's own `infisical login`, for one run | Infisical's free plan | Infisical Cloud's | built |

   The routing gate that passes over 1 and 2 today is the relay's runtime
   binding, not preference: the relay's loader reads Infisical, so
   `selectSecretStore` skips an offer whose binding is designed unless
   `--allow-designed` is given, and says why in the plan. *Amended the same
   day:* offer 2 is an experiment, and its gate stays shut for the relay; it
   is reached only by name (`--offer cloudflare-temporary`), which lifts the
   runtime-binding gate for that offer alone and keeps its evidence gate (an
   interactive terminal where the owner can accept the terms).
3. **Why this order, and the vendor evidence.** Infisical Cloud cannot be
   created by an agent: `infisical.com/auth.md` answers its agent 404 ("There
   is no agent-readable page"), `app.infisical.com/.well-known/*` serve the
   SPA, there is no RFC 8414 metadata and no dynamic or client-ID-metadata
   registration (`/api/.well-known/oauth-authorization-server` is 404); OAuth
   applications are registered by an admin, and delegated tokens cannot create
   organizations, machine identities or roles; every workload auth method
   (OIDC, JWT, SPIFFE, AWS/GCP/Azure/OCI/Alibaba, Kubernetes, TLS, Universal)
   authenticates an identity that already exists (all checked 2026-11-12). So
   Infisical Cloud is attach-only, and an Infisical HoBo provisions is
   self-hosted, where the
   [automated bootstrap](https://infisical.com/docs/self-hosting/guides/automated-bootstrapping)
   returns an admin user, an organization and an instance-admin machine
   identity with a Token Auth token. Cloudflare temporary accounts are
   production today and are agent authentication with a claim
   ([Claim deployments](https://developers.cloudflare.com/workers/platform/claim-deployments/));
   Cloudflare's own `auth.md` says auth.md registration is not live there and
   points to them. auth.md stays first and generic: Resend, Firecrawl and
   WorkOS publish it today; Infisical, Doppler, 1Password, Bitwarden, Akeyless,
   Upstash, Turso and Vercel do not, and a secret manager that adopts it is
   picked up by discovery with no change here. Neon's claimable Postgres
   (`neon.com/auth.md`) is agent auth with a claim too, but a database, not a
   secret manager: it is relevant only as the PostgreSQL a self-hosted
   Infisical needs.
4. **The Cloudflare offer is an experiment**, opt-in only and not the
   relay's store: [The Cloudflare experiment](#the-cloudflare-experiment),
   below.
5. **Claim, expiry and threat model** (against
   [the anonymous-claim threat model](../anonymous-claim-threat-model.md)).
   Every claim is a `@hobo/claims` bundle on the deployment's claim journal,
   driven by `hobo claim status|open|finalize`; one item, `secret-store`.
   - *Claim URL replay.* A claim URL or sign-in goes straight into the
     owner-only, encrypted one-time action store, bound to tenant, project,
     session and the item's provider, single-use, expiring at the provider's
     deadline (Cloudflare's `claim.expiresAt`; auth.md's `expires_at`; 24
     hours for a self-hosted sign-in). `provision` never prints it; the
     owner reveals it with `hobo claim open` in their own terminal; the skill
     forbids the agent to run that. Events, the plan, the binding and errors
     carry references only, and `assertNoSecrets` guards the journal.
   - *Confused deputy.* Redemption is scoped by audience: one provider's item
     cannot redeem another's action. Completion is verified through the
     provider, never by a redirect: for self-hosted Infisical, finalize deletes
     HoBo's bootstrap identity with its own token and passes only on
     Infisical's 401 for that token. A Cloudflare item is verified only by
     the experiment's Worker outliving the deadline ([below](#the-cloudflare-experiment));
     auth.md's verification is designed; finalize refuses rather than pass.
   - *Credentials HoBo must not keep.* Cloudflare's temporary token: lent
     from custody for the Worker upload only, then destroyed on every path.
     Infisical's instance-admin token: sealed under a separate audience only
     finalize redeems, and revoked there. The bootstrap admin password: sealed
     into the claim and never printed, but HoBo generated it, so the owner is
     asked to change it and turn on MFA; Infisical exposes no read of that to
     an identity HoBo keeps, so this one step is asked, not observed.
   - *Orphans and expiry.* Cloudflare deletes an unclaimed account after 60
     minutes, so the skill leads with that deadline. A self-hosted store
     whose claim expires keeps running on the owner's compute (their cost);
     cleanup on a durable timer is designed. Bundles are `best-effort-saga`,
     never called atomic.
6. <a id="the-deploy-credential"></a>**The deploy credential.** Checked
   2026-11-12 against Vercel's
   [Claim Deployments](https://vercel.com/docs/deployments/claim-deployments)
   and [deploy without logging in](https://vercel.com/docs/deployments/deploy-without-logging-in):
   `vercel deploy --temporary` always creates a new project, always targets
   production, refuses to run in CI or in a directory linked to a project, and
   its claim moves the whole project to the claimer's team; the platform flow
   (`POST /projects/:idOrName/transfer-request`, a code valid 24 hours, the
   `vercel.com/claim-deployment?code=…` page) needs a token on the source
   team. **Neither can deploy into an existing project in the owner's team.**
   So: a relay with no project yet is first deployed with `--temporary` from
   the owner's machine and its project claimed by the owner (one click); a
   relay whose project exists keeps it. For deploys from `main`, Vercel offers
   no way for an agent to obtain a token for a team it does not own, so the
   token is minted once in the owner's own `vercel login` session (a claim
   step the skill drives) and written only into the store's `hobo-ci-deploy`
   project, which the relay's identity cannot read. Designed, not built: no
   Vercel API write is made from this change, and the token-creation request
   is unverified.
7. **The GitHub App.** GitHub's manifest flow ends in one browser click by
   design. `hobo ci app create` drives it; the skill presents it as a claim
   step (what the owner approves, then wait), not a checklist item. Its
   credentials go to the chosen store.
8. **The deploy workflow** gates on the committed binding (absent: a notice,
   success), reads no repository variable about the relay, signs in to the
   store with GitHub OIDC as `hobo-ci-deploy`, and routes its runner through
   the `route` job as `hobo-ci.yml` does, so a busy fleet no longer holds it
   (its first run on `main` waited 48 minutes for a `hobo-trunk` slot).

*Implemented with this amendment:* the records (`SecretStoreOffer`,
`SecretStoreEvidence`, `SecretStoreSelection`, `SecretStoreBinding`, protobuf
and CUE with fixtures), the routing seam, the auth.md path (discovery,
anonymous registration, claim initiation, sealed link), the Cloudflare
temporary-account path (consent, proof of work, sealed claim URL), the
self-hosted Infisical path (bootstrap, project, folder, identities, OIDC
trust, sealed sign-in, finalize that revokes HoBo), the attach-only path,
`hobo ci secret-store plan|provision`, finalize's verifier for self-hosted
Infisical, `hobo ci deploy` reading the binding, the workflow gate and
routing, and the `hobo-deploy` agent skill; all against local stand-ins and
the pact mock of Infisical's admin API. *Designed only:* the config-service
Worker and the relay's loader for it, an auth.md store's runtime binding, the
Yard placing Infisical with PostgreSQL and Redis on the compute fleet (the
packs `pack-postgres-oci` and `pack-valkey-oci` exist; an Infisical image is
not pinned by digest, so no Infisical pack is added), the Vercel deploy-token
claim step, and verification of Cloudflare and auth.md claims. Details:
[Secret store chosen at deploy](../hosted-relay-stateless.md#secret-store-chosen-at-deploy).

*Added with the Cloudflare experiment (same day):* `--offer` on `hobo ci
secret-store plan|provision` (routing by name, gate shut by default), the
typed consent, the proof of work on a worker thread, the Worker upload with
a Durable Object binding and migration (`uploadTemporaryAccountWorker`),
`@hobo/config-service-worker` (the Worker, its records, its client, a pact
for its callers verified against the real handler, a workerd suite), the
experiment's pact with Cloudflare's API (consumer only), and finalize's
verification by the Worker outliving the deadline. No request to Cloudflare
has been made from this repository; the experiment is meant to be run once,
live, by the owner. Still not built: the relay's loader for the Worker (by
decision, not by gap: the relay keeps Infisical).

### The Cloudflare experiment

*Re-scoped 2026-11-12:* offer 2 is an experiment that proves HoBo can
obtain a valid Cloudflare claim link by the documented REST flow. It is
**not** the relay's store or deploy target: the relay keeps deploying to the
owner's Vercel project `hobo-ci`, and its runtime secrets go to Infisical.
Nothing about the relay changes: no binding is written, the relay's loader,
Yard and deploy workflow are untouched, and the routing gate never picks
the offer unless it is named.

*The run.* `hobo ci secret-store provision --offer cloudflare-temporary`
in an interactive terminal: the owner reads what will happen (an
experiment, not the relay's store, 60 minutes to claim, the Terms and
Privacy Policy URLs) and **types `accept`**; anything else creates
nothing. Then, through `@hobo/provider-cloudflare`'s temporary-account Yard
over an injected transport (`api.cloudflare.com` only): consent recorded,
`POST /client/v4/provisioning/previews/challenge`, the SHA-256 proof of
work on a worker thread (`solvePreviewChallengeOffThread`), `POST
/client/v4/provisioning/previews`; the API token into custody, the claim
URL into a one-time vault, then straight into HoBo's owner-only claim
store for `hobo claim open secret-store`; the token destroyed on every
path, success or failure.

*With `--experiment-worker`* (and the Vercel team, project and repository
its binding names), HoBo also uploads its config-service Worker
([`@hobo/config-service-worker`](../../../packages/config-service-worker/README.md))
with the account's token before handing the account over: one multipart
`PUT …/workers/scripts/{name}` whose metadata declares the Durable Object
binding and the migration `{ new_tag: "v1", new_sqlite_classes:
["ConfigStore"] }`, then the workers.dev route and subdomain; it checks the
Worker's health (store id and a fresh nonce) and seeds it once, empty,
which burns the bootstrap credential. A failure there is recorded on the
receipt (stage and code) and does not withhold the claim link.

*The Worker's design, and one deviation.* The relay's config document
and secrets live in a Durable Object's SQLite storage, private to the
account and reachable only through the Worker. **No root secret:** the
earlier design (values envelope-encrypted with a key in a Worker secret
binding) is dropped, because temporary accounts list no secret bindings
and a key held by the same Worker in the same account protects against no
one who could not already reach the values through it. Reads: the relay's
Vercel OIDC token, verified against the team issuer's JWKS (discovery,
`jwks_uri` on the issuer's host) with issuer, audience, `sub`, `owner_id`,
`project_id` and `environment` pinned by the deploy-time binding baked into
the Worker's plain-text variable `HOBO_CONFIG_BINDING`; it returns only the
`relay` folder. Writes: GitHub Actions OIDC, `repository` and `ref` pinned
(and `repository_id` when known), with a custom audience naming this store
(`urn:hobo:config-service:<store id>`), which may read `deploy` and write
`relay`; and, once, the bootstrap credential, held as a SHA-256 hash and
burned in the same storage write as the seed. After the claim, the owner
writes through a Cloudflare Access application they put in front of a
custom-domain route of the Worker (the workers.dev route stays for the
relay and the deploy workflow): they set `HOBO_CONFIG_OWNER_ACCESS` (Access
issuer and AUD tag) in their own dashboard, and the Worker verifies the
`Cf-Access-Jwt-Assertion` against the Access team's keys. Until then no
owner route exists; there is no unauthenticated write path, and `wrangler`
offers no Durable Object storage command to use instead. Comparisons of
the bootstrap hash are constant-time; bodies are bounded (64 KiB, 16 KiB a
value, 64 entries a folder); the audit log records names only, never
values. HoBo writing a secret manager remains the cost named before:
rotation and versioning are not built.

*Finalize.* Cloudflare documents no claim-status endpoint (read
2026-11-12), and HoBo keeps no token. The one observable is the documented
deletion of an unclaimed account at its deadline. So `hobo claim finalize
secret-store` passes only when the experiment's Worker still answers with
its store id and a fresh nonce at least 15 minutes after `claim.expiresAt`;
without the Worker it refuses and says why, and the owner checks the
dashboard.

*Verified versus assumed.* From Cloudflare's page (read 2026-11-12): the
REST endpoints and field names, the 60-minute claim, "Deploy Workers with
Durable Object bindings and migrations" among supported resources, the
upload endpoint with `main_module` and `compatibility_date`, and the
subdomain read; secret bindings and Secrets Store are not listed. Tested
locally: the uploaded modules run in workerd (Miniflare) with a
SQLite-backed Durable Object. **Assumed, for the first live run to
check:** that the temporary token accepts the binding and migration
metadata on upload, the response of the workers.dev route call
(`enabled: true`), how soon a new script answers on workers.dev, how soon
after the deadline an unclaimed account disappears (the 15-minute margin),
and that the claimed account keeps its workers.dev subdomain.

## Alternatives considered

- **Self-hosted Postgres** (the previous plan). Removes the vendor quota, keeps
  the dependency, and adds a server to run, back up and upgrade.
- **The relay database fleet.** Survives one provider's quota at the cost of a
  writer register, replication and failover, all to keep state that GitHub
  already holds.
- **NATS JetStream as the relay's store.** The compute fleet's mesh uses it;
  for a Vercel function it means hosting a quorum cluster, which is neither
  free nor infrastructure-free.
- **Vercel Edge Config (now Global Config).** Read-optimised configuration
  written through the API with a Vercel token; no runtime writes, so no
  per-job exclusion. It remains an optional configuration source.
- **Vercel Blob as the only store.** Superseded by the amendment: Blob's
  conditional writes (`ifMatch`, non-overwriting `put`) make it a feasible
  cache-fleet backend, once built and passing the conformance suite, but not
  the sole one.
- **Redis Cloud free.** 30 MB and 100 operations a second, and TLS on the free
  database unclear.
- **Valkey hosted on Vercel.** Daemons accept no inbound HTTP or TCP;
  container services are HTTP-only, autoscaled and scale to zero after five
  idle minutes; a daemon's memory alone would cost about $15.50 a month for
  1 GiB.

## Consequences

- The relay no longer fails on its own: with GitHub up and the cache empty it
  rebuilds; with the cache down it refuses new admissions and keeps no state
  that could be corrupted.
- When GitHub Actions is down nothing can run regardless. Persisted state never
  bought availability for GitHub-triggered work; the cache buys resilience to
  dropped webhooks, REST errors and restarts.
- Job history is GitHub's. The relay keeps logs and a short change ring, not a
  journal. `GET /v1/accounts/self/leases` and MCP show in-flight work only.
- Configuration changes go through `hobo ci` and the config service, with the
  config service's own versioning; the relay cannot be reconfigured over HTTP.
- Budget enforcement is approximate by one pull interval, and priced offers
  pause while the cache is being rebuilt.
- ~~Operators make three one-time moves~~ (withdrawn 2026-11-12): the owner
  makes no setup moves. They take the store by claim when the deployment runs,
  approve the GitHub App's manifest page, and sign in to Vercel once for the
  deploy token; the `hobo-deploy` skill surfaces each when it is needed
  ([amendment](#amendment-secret-store-chosen-at-deploy-provisioned-by-claim)).
- Many files and tests are deleted in phase 7 (done: the
  [itemized list](../hosted-relay-stateless.md#phase-7-removals)); the package
  READMEs' superseded sections went with them.
