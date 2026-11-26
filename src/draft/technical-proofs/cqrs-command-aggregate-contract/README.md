# HOBO-69 CQRS Command Aggregate Contract

This draft package proves the M1 write path from command to aggregate write-model fold to
domain event.

## Contract Surface

- `command(type, { key, initialState, fold }, handler)` defines a typed command boundary.
- `createCommandRuntime().execute(...)` runs the handler against the aggregate write-model fold.
- `ctx.state` is the folded write model for the command's aggregate stream.
- `ctx.emit(...)` records domain events under the aggregate's optimistic `expectedSeq` and returns
  the appended `seq`.
- `runtime.emit(...)` is the naked domain-event path for facts that do not need an aggregate.
- `runtime.acquireFence(...)` is a minimal ActorHost-compatible fence token stand-in so stale
  writers can be rejected without implementing HOBO-21's lease/passivation runtime again.

## Acceptance Evidence

- Invariants are checked against the folded aggregate state before append.
- A duplicate open command rejects and leaves the event stream unchanged.
- Two same-aggregate writers that observed the same `seq` produce one committed event and one stale
  `expectedSeq` rejection.
- Command execution returns the emitted `seq`.
- Naked emit appends without aggregate state.
- Command handlers that try `step` or external writes fail closed before append.
- Stale fence tokens cannot append.
- Implicit command execution cannot bypass a live aggregate fence.

## Scope Boundary

This package does not reimplement the ActorHost lease runtime from HOBO-21, projection/read-model
folds, reads-your-writes advancement, sagas, or lane-aware fork-on-touch. It is a branch-local proof
of the CQRS write-path contract.

## Verification

```sh
pnpm --filter @hobo-draft/cqrs-command-aggregate-contract test
```

The suite runs on Vitest and is followed by a `tsc --noEmit` type-test pass
(`tsconfig.types.json`) that exercises the exported `CommandContext`,
`CommandDefinition`, and `CommandResult` types, including the strongly typed
`emitted` envelope stream returned from a command.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Cqrs Command Aggregate Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
