# Acceptance (L26)

Behaviour and acceptance for HoBo Fleet (ADR-0183): the cucumber features
under `features/fleet/`, their steps under `features/steps/fleet/`, the O2
integration test, and the O20 soak (`pnpm run fleet:soak`). Nothing here is
exported by the package; the modules are test support.

| File | What |
|---|---|
| `world.ts` | The acceptance world: the real authority (`assembleAuthority` behind `createAuthorityHandler`, no network) over a bus the caller picks, the real audit chain and witness, `createFleetAgent` devices, and a trust anchor the world holds itself (one authority and one witness key) so agents verify every record they are answered |
| `memory-connector.ts`, `audit-log.ts`, `live-bus.ts` | The memory bus as devices see it (each connection presents a ticket; the suite can take the bus down), an `AuditLog` the witness co-signs through, and a bus view that follows the agent's reconnects |
| `nats.ts` | The world's bus on a real `nats-server`: operator mode, JetStream, TLS, `provisionTopology`, `connectAuthorityBus`, `startCalloutResponder`, `createNatsBusConnector`; and `operatorConf` for a server deployed from the ceremony's seed |
| `flows.ts`, `claims.ts`, `one-active.ts`, `ephemeral-state.ts` | The O2 flows (enrollment by token, browser approval or workload identity; sign-in through the routes; an own `oci-command` job to its receipt), signed offers and claims, key bundles, a copied key store, an in-memory stream pair, and a local one-active fleet |
| `enroll-and-run.integration.test.ts` | O2's integration half: `nats-server`, the authority and the real `S1` driver; the token and browser-approval flows each reach `SUCCEEDED` |
| `soak.ts` | The O20 soak `scripts/fleet-soak.mts` runs (design §10.1 "Soak output") |
| `index.ts` | What the root behaviour steps import (the root workspace has no dependency on the fleet packages) |

## Behaviour (`pnpm run test:behavior`)

Every `@fleet` scenario gets a fresh world on the in-memory bus. Sign-in runs
the authority's HTTP routes (loopback and device code); enrollment runs
through the agent; work runs end to end with the fake sandbox driver, and the
trust class and tier are read off the device's own receipt. The world's clock
is the wall clock plus an offset, so agent loops run on real timers while the
audit checkpoint interval can be passed.

The world imports the memory plumbing of `@hobo/fleet/testing` by path: that
barrel also loads the conformance suites, which import vitest, and cucumber
cannot load vitest.

## O2 integration

`pnpm exec vitest run packages/fleet-authority/acceptance/enroll-and-run.integration.test.ts`.
It needs `nats-server` (`HOBO_FLEET_NATS_SERVER_BIN` or on PATH), `openssl`,
and a host where the `S1` self-test passes (D58: the agent provisions gVisor
`runsc` into `HOBO_FLEET_SANDBOX_CACHE`, default `/var/lib/hobo-fleet` as
root). O2 takes no fallback, so the test never skips: without either it
fails and says which. `@hobo/fleet-agent` is reached by path because it is
not a dependency of this package.

## O20 soak

`pnpm run fleet:soak` copies `deploy/fleet` to a scratch directory, adds an
override with an OpenBao dev server (JWT auth, one role per workload) and a
route to the soak's own OpenID Connect issuer, runs the ceremony into
OpenBao and writes `operator.conf` from it, brings up the high-availability
profile and the provisioning job, signs in, defines the fleet `soak`, enrolls
three agents and a probe member, submits `oci-command` work every 5 s for
`HOBO_FLEET_SOAK_DURATION_S` (600), kills `nats-2` at 180 s and
`authority-1` at 360 s, and writes `fleet-soak.json`. It needs Docker Compose
with a running daemon and the `:candidate` images (or `HOBO_FLEET_VERSION`);
without Docker it fails.

How each figure is measured:

| Field | Source |
|---|---|
| `callout_p99_ms` | `decision_ms` on the responders' callout log events (`hobo_fleet_bus_status` with `component: callout`, `hobo_fleet_callout_refused`); none logged fails the soak |
| `first_claim_p95_ms` | First offer publish to the accepted claim, per digest, on the agents' own connections |
| `events_expected` | Offers and accepted claims (one per digest), orders and receipts the soak's agents published |
| `events_recorded` | Events in `fleet-work-<digest>` streams of `FLEET_JOURNAL`, once the count holds still for 15 s |
| `recovery_s` | From killing `authority-1` to every working agent's next successful refresh and the journal count settling |
| `new_connection_failures` | While the authority is down, a fresh connection every 5 s, retried once with a new ticket |
| `availability_*` | `slo.Measured` events in `slo-fleet-enrollment-api` and `slo-fleet-nats-callout`, two per finished minute since the authorities started |
