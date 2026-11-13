# Conformance suites (L29)

The seven suites every adapter of a fleet port runs against itself, exported
from `@hobo/fleet/testing` (design §7.3). Each `run*` function registers one
vitest `describe` with one `it` per named assertion; call it at the top level
of the adapter's test file.

| Suite | Port | Run by |
|---|---|---|
| `runBusConformance(make)` | `AuthorityBus` | `@hobo/fleet-nats` (O3–O5) |
| `runTransportConformance(make)` | `FleetTransport` pair | `@hobo/fleet-p2p`, `@hobo/connectivity`, `@hobo/fleet-nats` relay (O12) |
| `runSandboxConformance(make)` | `SandboxDriver`, logic only | `@hobo/fleet-agent` |
| `runSandboxIsolationProbe(make, options)` | `SandboxDriver`, real sandboxes | `@hobo/fleet-agent` isolation test (O10) |
| `runKeyStoreConformance(make)` | `KeyStore` | `@hobo/fleet` keys, `@hobo/fleet-agent` (O36) |
| `runReplicaConformance(make)` | `AssignmentReplica` | `@hobo/fleet` assignment, `@hobo/data-postgres` (O15) |
| `runJournalConformance(make)` | `FleetEventStore` | `@hobo/fleet-nats` journal (O11) |

## What `make` must answer

- **Bus**: a connected `AuthorityBus`. The suite publishes a witnessed trust
  record naming a suite-made Ed25519 authority key with `publisher.putTrust`
  and signs every registry record with that key; a verifying view must pin
  that trust record. Ids are random, so a server shared between runs is fine.
- **Transport**: two transports that can reach one another. The suite starts
  each with suite-made device keys, accepts on the second and dials from the
  first with grants signed by a suite authority key; its own `authorise`
  checks signature, expiry and both parties.
- **Sandbox (logic)**: a driver whose `create` works for `busybox:1.37`.
- **Isolation probe**: a driver of real sandboxes, a busybox `probeImage`, an
  `allowedHost` that answers HTTPS, and the egress proxy factory. The driver
  must set `http_proxy`/`https_proxy` inside the sandbox from
  `egressProxyUrl`; the proxy refuses with 403 (or 407) or by closing.
- **Key store**: a fresh store with no keys on each call.
- **Replica**: a replica over a fresh, empty log on each call.
- **Journal**: a store; streams are named with random ids and `readAll` is
  filtered to them, so a shared journal is fine.

## Architecture placement

Test kit only: no commands, events, actors, projections or read stores. The
suites hold no decisions of the fleet; they state the port contracts of §7.3
as named assertions. `test/testing/suites.test.ts` proves O39: the in-memory
adapters pass, and for each assertion a double broken in exactly that way
fails exactly that assertion.
