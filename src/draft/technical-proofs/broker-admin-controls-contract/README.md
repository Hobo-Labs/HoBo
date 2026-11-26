# Broker Admin Controls Contract

Source issue: HOBO-527.

This independent proof package defines the minimum M2 contract for broker environment proposal,
approval, revocation, audit evidence, and receipt immutability controls.

## Proves

- Admin proposal and approval fixtures produce auditable Broker Environment state transitions.
- Admin controls create new Broker Environment snapshots instead of mutating issued Resolution
  Receipts.
- Unsupported or unauthorized admin actions fail closed.
- Malformed commands, cross-environment approval attempts, self-approval, post-receipt mutation, and
  approval without audit evidence are rejected.

## Scope Boundary

This package does not build full Admin Console navigation, React UI, hosted broker runtime, Yard
planner behavior, provider adapters, Gatekeeper policy changes, or live service persistence.

## Evidence

- TypeScript contract and tests: [`src/`](./src) and [`test/`](./test)
- Protobuf: [`architecture/broker_admin_controls.proto`](./architecture/broker_admin_controls.proto)
- CUE: [`architecture/broker_admin_controls.cue`](./architecture/broker_admin_controls.cue)
- Pact fixture: [`architecture/pacts/broker_admin_controls.pact.json`](./architecture/pacts/broker_admin_controls.pact.json)
- Architecture note: [`ARCHITECTURE.md`](./ARCHITECTURE.md)

Run:

```bash
pnpm --prefix src/draft/technical-proofs/broker-admin-controls-contract test
```
