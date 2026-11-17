---
name: verify-hobo-local-work-binding
description: Verify that HoBo's local placement and worker execute the exact project bytes whose digest placement approved.
---

# HoBo local work binding

**Property:** Local placement and execution use a content-addressed copy whose exact selected bytes and read/execute modes hash to the digest the Yard approved. The persistent worker verifies that copy before serving. A failure can authorize one Bindle and execute another after a working-tree edit or stale module-cache read.

**Review baseline:** commit `fcb3f335f037aa2c0097d50e8741a972947734d1`. PASS for the bounded model, symbolic abstraction, generated tests, lifecycle tests and implementation mutations below.

## Covered code

- `packages/hobo/src/local-deployment-fingerprint.ts` selects project inputs, hashes their path, bytes and read/execute mode, creates the content-addressed execution copy, checks the copy's digest and removes write bits from copied files on filesystems that enforce them.
- `packages/cli/src/cloud/loader.ts` accepts an explicit importer so a verified TypeScript copy created after process startup is loaded deliberately; `runtime-created-loader.test.ts` checks that path and fail-closed importer errors.
- `packages/hobo/src/broker-up-command.ts` captures the initial digest before importing the Bindle, materializes and loads the execution copy, binds its digest into placement, and rechecks source and copied inputs around placement and startup.
- `packages/hobo/src/broker-runtime.ts` puts a supplied project digest in the Yard request and returns that binding with the resolved placement.
- `packages/hobo/src/local-deployment.ts` snapshots caller options, verifies the expected source digest, materializes the approved copy and starts the worker in that copy.
- `packages/hobo/src/local-deployment-worker.ts` derives and verifies the content-addressed copy before loading or serving it.
- `packages/hobo/src/local-yard-serve.ts`, `multi-host-serve.ts` and `wasm-host.ts` accept the definition loaded from the verified copy, so placement and in-process serving share one approved module instance.
- `packages/hobo/test/local-work-binding.test.ts` checks digest propagation, budget and input races, exact-copy materialization, read-only files, module-cache separation, caller-option capture, worker corruption refusal and execution after the working source changes. It compares 20 generated phase cases to the reference expectations with seed 614533. `persistent-local-deployment.test.ts` exercises the real CLI and worker lifecycle; `local-budget-fallback.test.ts` checks the adjacent financial gate.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-hobo-local-work-binding
```

The shared runner checks the pinned TLC 1.7.4 jar and Z3 4.15.4. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to existing installations or let the runner obtain them. Java 11+, Python, Node, pnpm, Vitest, fast-check and installed workspace dependencies are required. Use `/statechart` on the model and view to inspect transitions and counterexamples.

## Scope and evidence

`LocalWorkBinding` explores 48 states for source edits, exact-copy materialization, placement, in-process startup, persistent startup and a corrupted worker copy. It checks eight invariants: an input digest exists, the execution copy and placement proof bind it, observed source changes are refused, the worker verifies its copy, and started work matches the approved digest. Its 13-state projection has 21 arrows, hides 27 same-label steps and suppresses 15 repeated edit steps.

Eight weakened model guards and eight weakened Z3 premises yield counterexamples. The old mutable-source behavior reaches: capture the digest, copy and approve work, check the working files, edit them, then start different work. With the execution-copy guard enabled, the same edit still starts the approved copy. Nine optional real implementation mutations run with `python3 .agents/skills/verify-hobo-local-work-binding/mutations/runtime.py`; each requires a passing control and an assertion failure, including mutations that execute the working tree, accept a corrupted worker copy, break content addressing or copy different bytes.

The model treats SHA-256 collision resistance, exact filesystem reads and writes, and the content-addressed tree after its final check as trusted. The snapshot intentionally excludes `node_modules`, temporary and local control files, the configured HoBo home, and dependencies or data reached through absolute or dynamic file reads. Symlinks are copied as the bytes they resolve to rather than preserving link identity. A caller-supplied digest still needs trustworthy provenance. Same-user tampering with `.hobo`, malicious imported code that changes permissions, remote provider effects, arbitrary runtime reads, full liveness and a machine-checked refinement from TypeScript to TLA+ remain outside this skill.

For the mandatory broken-code check, copy `packages/hobo` to a scratch package with linked `node_modules`, set `HOBO_LOCAL_WORK_VERIFY_PACKAGE_ROOT`, and change the worker to serve `launch.projectDir` instead of the derived execution copy. The real worker test must fail on an assertion rather than a suite-load error. Restore the source and rerun the unmodified skill.

## Keep in sync

Read every change to the covered code since the baseline. Update the model from the implementation before running it, preserve the stated property unless product evidence deliberately changes it, replay every counterexample against real code, and exercise a broken scratch implementation before advancing the baseline. Use `/maintain-formal-verification-skill`.
