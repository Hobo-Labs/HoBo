---
type: Architecture Decision Record
title: "The Hosted CI Relay Keeps No Durable State"
description: "The hosted CI relay on Vercel becomes a twelve-factor process: config and secrets in a separate service, short-lived job state in a Redis-protocol cache it may lose, Vercel Queues for intake and per-lease steps, GitHub as the system of record. Its database, relay database fleet and Neon broker are removed."
tags: [hobo, design, adr, ci, relay, twelve-factor]
---

# ADR-0179 — The Hosted CI Relay Keeps No Durable State {#adr-0179}

**Status:** Accepted (design; implementation phased)
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
   Vercel Marketplace; self-hosted Valkey binds to the same port. Loss of the
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
    Turso (attached, unused), the relay database fleet, store selection, the
    Drizzle relay schema and migrations, `PostgresCiStore` and its pg-bound
    helper stores, and the box worker's `HOBO_CI_STORE=postgres` option are
    removed.

Unchanged and out of scope: the compute fleet (mesh, capacity, runner routing
and balancing, NATS mesh state), `SqliteCiStore` for box workers and
`hobo ci serve`, `@hobo/data-postgres` including its fleet module, and the
Broker budget ledger library.

The full design, the table-by-table mapping, the hazards, the cost model and
the eight-phase delivery plan are in
[Hosted CI Relay Without Durable State](../hosted-relay-stateless.md).

## Alternatives considered

- **Self-hosted Postgres** (the previous plan). Removes the vendor quota, keeps
  the dependency, and adds a server to run, back up and upgrade.
- **The relay database fleet.** Survives one provider's quota at the cost of a
  writer register, replication and failover, all to keep state that GitHub
  already holds.
- **NATS JetStream as the relay's store.** The compute fleet's mesh uses it;
  for a Vercel function it means hosting a quorum cluster, which is neither
  free nor infrastructure-free.
- **Vercel Blob or Edge Config.** No compare-and-set with TTL suited to
  per-job exclusion.

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
- Operators make three one-time moves: create the Infisical organization and
  admin identity, store a Vercel deploy token there, and re-create the GitHub
  App through the CLI.
- Many files and tests are deleted in phase 7; until then the superseded
  sections of the package READMEs carry a banner pointing here.
