# Meta-cloud Broker Scope Contract

Executable M0 productization contract for HOBO-521.

This draft package records the accepted scope boundary for the Meta-cloud Broker before M1 design
or implementation issues fan out. It is intentionally not a hosted broker runtime, Yard planner,
provider adapter, admin UI, Gatekeeper policy change, token broker replacement, Contract IR
replacement, or provider Capability Manifest replacement.

## What It Proves

- The user/business goal and primary personas are explicit.
- Scope in, scope out, and non-goals are machine-checkable.
- Broker, Yard control plane, UX admin controls, and Gatekeeper authority boundaries are named.
- Core artifacts are listed with owners and minimum M1 proof expectations.
- Owning initiative dependencies are mapped to the nearest downstream owner.
- M1 evidence is listed before follow-up implementation issues can start.
- Scope creep into broker runtime, Yard planner, provider adapters, admin UI, Gatekeeper changes,
  or proofless public broker claims is rejected.
- Architecture guard evidence exists for the future broker boundary: PACT, protobuf, CUE,
  parse-derived domain types, and event architecture vocabulary.

## Architecture Evidence

- `ADR.md` records the parse, don't validate boundary, derived domain types, commands,
  events, actor, event-store, materialized view/projection, snapshot, and read store.
- `contracts/pacts/meta-cloud-broker-resolution.pact.json` records the executable PACT contract
  for receipt and rejection outcomes.
- `proto/meta_cloud_broker.proto` and `cue/meta_cloud_broker.cue` pin the M0 broker artifact shapes
  and constraints before M1 schema work expands them.

## Verification

Run the focused proof:

```powershell
npm.cmd --prefix src\draft\exp-proofs\meta-cloud-broker-scope-contract test
```

Run the base-aware architecture guard used by CI:

```powershell
npm.cmd run architecture:guard -- --base=origin/main
```

The proof is also referenced by the design record:

- [Meta-cloud Broker design record](../../../../../docs/design/meta-cloud-broker.md)
- [HOBO-521 proof record](../../../../../docs/design/proofs/hobo-521-meta-cloud-broker/README.md)
