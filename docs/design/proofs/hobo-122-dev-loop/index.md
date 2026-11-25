# HOBO-122 Dev Loop Proof

HOBO-122 is proven by the focused POC at
[`src/draft/technical-proofs/hobo-dev-loop-contract`](../../../../src/draft/technical-proofs/hobo-dev-loop-contract).

## Acceptance Coverage

- `hobo new x && hobo dev` serves locally under one minute with no cloud account:
  `boots a hobo new project on localhost in under a minute with no cloud account`.
- Handler edits hot-reload without losing run state:
  `hot-reloads handler edits without losing run state`.
- Restart replay preserves local state from `.hobo/`:
  `restarts from .hobo state and replays to the same local state`.
- Zod/schema edits regenerate checked-in generated clients in-loop:
  `regenerates checked-in generated code after a Zod source edit and debounces concurrent saves`.
- Fidelity labels are surfaced per capability:
  the boot test asserts `real`, `simulated`, `mocked`, and `camp-only` labels.

## Adversarial Coverage

- Syntax errors return `HOBO_DEV_RELOAD_ERROR` without crashing the daemon or dropping state.
- Incompatible `.hobo/dev-state.json` returns `HOBO_DEV_STATE_VERSION_UNSUPPORTED` and leaves the file unchanged.
- `--fork` lane writes are isolated from the shared environment baseline.
- Concurrent source saves debounce to one codegen run.

## Scope Guard

The POC explicitly does not implement production runtime backends, inspect/logs views, real file
watching, provider credentials, or sandbox/test auto-mocking.
