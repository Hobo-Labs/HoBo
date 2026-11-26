# HOBO-26 Wire-Version Negotiation Proof

This proof backs [PLAN-20](../../wasm-runtime-wit.md#plan-20),
[ADR-0069](../../adr/01-architecture-core.md#adr-0069),
[ADR-0085](../../adr/01-architecture-core.md#adr-0085), and ADR-0024's
pin-and-gate version policy.

The branch adds `src/draft/technical-proofs/wire-version-negotiation-contract`, an independent
POC for the M3 membrane version-negotiation slice.

Acceptance evidence:

- `caller@N and provider@N+1 negotiate the highest shared minor before establishing the link`
- `a shared minor below the declared floor rejects the link with version-incompatible`
- `mismatched wire versions fail at link time instead of being discovered by a first call`
- `report records HOBO-26 scope and excludes floor policy, upcasters, and lattice transport`

Scope boundary:

- Included: highest shared minor negotiation, typed `version-incompatible`
  rejection, negotiated wire minor in `link.Established`, and manifest-IR link
  evidence.
- Excluded: compatibility floor policy, preview/experimental upcasters,
  NATS/JetStream lattice transport, deadline propagation, backpressure, and
  partial/ambiguous failure taxonomy.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\wire-version-negotiation-contract test
```
