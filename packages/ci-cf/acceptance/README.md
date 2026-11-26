# Local native acceptance and proof

`pnpm --filter @hobo/ci-cf test:proof` exhaustively explores the **production**
controller's complete finite reachable state graph: 278 states and 3,224 edges.
It has no depth bound or iteration budget. It asserts that exit zero requires
successful checks, native Workflow completion and confirmed shutdown; uncertainty,
cancellation and deadline stops cannot reopen admission; terminal states are immutable.
Conflicting pipeline results fail closed. A reachable successful state prevents
an always-failing implementation from satisfying the proof vacuously.

This is a formal finite-state safety proof under the controller's typed event
assumptions. It does not prove the implementation of Cloudflare, Docker, the
kernel, arbitrary commands, liveness under hardware failure, or exactly-once
external effects. Runtime observations are checked separately by executable
native acceptance. Crash recovery deliberately reports uncertainty and never
replays an interrupted command automatically.

`pnpm --filter @hobo/ci-cf test:acceptance` runs actual Wrangler/workerd, native
Workflows, SDK 0.2.0, Sandbox 0.12.1 containers and local R2 on Linux with a local
Docker daemon. It needs no cloud account or paid resources. The fixture installs
a local file dependency offline, not a substitute SDK or simulated executor.
It exercises:

- Immutable prepared Worker assets: rebuild the shared CI package during native
  execution and require no hot reload or interrupted Workflow.
- Committed source selection, exclusion of uncommitted/secret host files, dependency
  install and restoration, tracked-file mutation/deletion across native snapshots.
- Distinct native command/artifact journal identities, 120 KB stdout, separate
  stderr, a one MiB binary artifact transferred in eight chunks, SHA-256 verification
  and actual exported-file verification.
- Exit 23 with both streams preserved and no subsequent command admission.
- Host-enforced timeout and SIGINT, including actual owned container/proxy cleanup.
- Forced controller SIGKILL after an externally observed HTTP side effect; recovery
  observes the side effect exactly once, refuses replay and confirms shutdown.
- Authentication and Origin rejection on the private local API; mandatory native
  TPROXY rules present and invalid iptables rules still fail through compatibility.
- Output overflow persisted as an explicit command failure, without silent truncation.
- Revalidation of a finished receipt under a deliberately changed Docker context,
  without starting another native execution; concurrent-controller rejection and
  refusal of a fresh admission until interrupted execution is explicitly reconciled.

The suite retains protobuf JSON receipts, exported artifacts, the native journal,
local R2 state and runtime logs in its printed evidence directory. Set
`HOBO_CI_ACCEPTANCE_ROOT` to a new empty directory to select that location. An
acceptance assertion failure stops managed child processes before returning.
[The recorded native run](last-run.md) contains Workflow identities, outcomes,
exit statuses and the binary digest. The repository stores this small report;
large logs/artifacts remain in the local evidence directory.

Unit/contract coverage independently tests source preparation with dirty pinned
Git submodules, LFS refusal, prepared-input mutation, output/resource bounds,
malformed envelopes, symlink artifacts and unconfirmed provider termination.
These tests complement the native run; they do not replace it.
