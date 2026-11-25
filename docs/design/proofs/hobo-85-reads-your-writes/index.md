# HOBO-85 Reads-Your-Writes Proof

This proof backs [PLAN-32](../../data-plane.md#plan-32) and
[ADR-0050](../../adr/03-data-plane.md#adr-0050).

The executable POC in
[`src/draft/technical-proofs/reads-your-writes-contract`](../../../../src/draft/technical-proofs/reads-your-writes-contract)
proves the M2 reads-your-writes contract:

- a command ack is held until native log-backed subscriptions advance to the emitted event seq;
- subscription positions are per-stream seq vectors, not a scalar global position;
- an ack before advance fails closed through an explicit guard;
- client-observed pushes cannot regress a stream seq;
- change-feed sink reads are labeled bounded-staleness rather than strict reads-your-writes.

Scope kept out: change-feed adapter implementation, strong/bounded-staleness runtime tuning,
cross-Camp subscriptions, GraphQL facade generation, and Reactor backpressure scheduling.

Verification:

```powershell
npm.cmd --prefix src\draft\technical-proofs\reads-your-writes-contract test
```
