---
type: State machine verification reference
title: "HoBo state machines and verification"
description: "Reviewed state-machine slices, executable checks, bounded models, and open verification work."
tags: [hobo, state-machines, verification]
---

# HoBo state machines and verification

This is a **partial** verification record, not a claim that the framework is fully modeled or proved. Each skill below identifies the covered code, review baseline, executable checks, formal properties, assumptions, and known gaps.

| Subsystem | Maintained verification | Main checked properties |
| --- | --- | --- |
| Shared budget policy | [verify-shared-budget-policy](../.agents/skills/verify-shared-budget-policy/SKILL.md) | Scope, windows, monetary and metric limits, native-bound labels, and policy constraint shapes. |
| Dispatcher budget-policy routing | [verify-budget-policy-routing](../.agents/skills/verify-budget-policy-routing/SKILL.md) | Admission and settlement preserve modeled available budget, subject to overrun and evidence assumptions. |
| Broker budget authority | [verify-broker-budget-authority](../.agents/skills/verify-broker-budget-authority/SKILL.md) | Holds account for liabilities; claimed work retains funding; signed settlement requires bound receiver and finance evidence. |
| SQLite queue and outbox | [verify-outbox-lease](../.agents/skills/verify-outbox-lease/SKILL.md) | A stale delivery attempt cannot acknowledge a later attempt, even when lease IDs and fences repeat. |
| Provider connections | [verify-connection-lifecycle](../.agents/skills/verify-connection-lifecycle/SKILL.md) | Revocation is terminal across commands and replay. |
| Durable workflows | [verify-workflow-replay](../.agents/skills/verify-workflow-replay/SKILL.md) | Fresh runs claim identities; each execution serializes journal writes and stops after an append error; resume checks recorded commands, deadlines and terminal results. |
| CI fleet capacity admission | [verify-ci-capacity](../.agents/skills/verify-ci-capacity/SKILL.md) | Stale capacity revisions are refused; revision exhaustion cannot wrap the wire counter. |
| CI uncertain-runner capacity | [verify-ci-uncertain-capacity](../.agents/skills/verify-ci-uncertain-capacity/SKILL.md) | Uncertain slots retain capacity; confirmed recovery releases it once, under trusted teardown evidence. |
| CI fleet effect delivery | [verify-ci-fleet-delivery](../.agents/skills/verify-ci-fleet-delivery/SKILL.md) | Fresh bounded delivery fences reject stale workers and ambiguous dispatch is not reissued. |
| CI fleet start binding | [verify-ci-start-binding](../.agents/skills/verify-ci-start-binding/SKILL.md) | Transactional claims and retries preserve unique job/slot bindings, subject to trusted assignment evidence. |
| CI shared-budget window | [verify-ci-budget-window](../.agents/skills/verify-ci-budget-window/SKILL.md) | Work duration is rechecked after durable reservations and claims; post-commit refusals keep their holds. |
| CI budget routing | [verify-ci-budget-routing](../.agents/skills/verify-ci-budget-routing/SKILL.md) | Routing counts unobserved usage, conservatively aggregates provider-account observations, and refuses duplicate reports containing free allocation. |
| CD fan-out | [verify-cd-fanout](../.agents/skills/verify-cd-fanout/SKILL.md) | Halt and mandatory-failure gates stop new starts; mandatory-pilot gates apply during normal and catch-up scheduling; missing slots remain pending. |
| CD promotion and rollback | [verify-promotion-verification](../.agents/skills/verify-promotion-verification/SKILL.md) | Qualification requires passing verification; request identities bind retries and rollback claims. |

The package READMEs include selected user-flow projections produced from the checked models. A projection hides internal transitions and is not a production trace. Each skill states its model bounds, projection limits, and the number of hidden steps. Workflow verification includes SQLite close-and-reopen tests and bounded models for sleep deadlines and ambiguous append outcomes.

## Run and maintain

With workspace dependencies installed, run every listed verification skill or select individual skills:

```sh
pnpm run verify:state-machines
pnpm run verify:state-machines -- verify-budget-policy-routing verify-broker-budget-authority
```

The runner checks the pinned TLC jar and reuses a version-checked Z3 4.15.4 solver or installs its hash-pinned wheel in a temporary directory. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to existing pinned installations for offline runs. Unsupported platforms or mismatched pre-provisioned solvers fail closed. Java 11+, Python, Node, and the dependencies listed by each skill are required. The aggregate command reports all selected results and fails if any fails.

The required PR and merge-queue gate runs the aggregate verifier in four deterministic shards, including its executable checks, bounded models, and proof obligations. A failed, skipped, or cancelled shard blocks the gate; a signed local attestation does not substitute for this job. Each shard builds the packages used by the registered skills before verification; update its build filters when a new skill needs a package outside that dependency cone. Each verification step has a 20-minute limit. Run `pnpm run verify:state-machines -- --list --shard=0/4` to inspect a shard, or omit `--list` to execute it.

When covered behavior changes, review the code and its intended policy, update the implementation tests and model, replay counterexamples against code, exercise deliberately broken variants, regenerate affected charts, run the skill, and update its baseline. Keep `.agents/skills/` and `.claude/skills/` byte-for-byte mirrored. Pstack's `/maintain-formal-verification-skill` and `/statechart` describe that workflow.

## Open work and proof boundaries

- The historical candidate queue covers only selected source languages and paths and has not been fully classified. CI, CD, cloud providers, stores, examples, integrations, and additional stateful subsystems need further source review and their own checks.
- Fleet capacity revisions stop at the uint32 wire limit; further changes, including releases, require a future format migration and reconciliation. Delivery fences and observation sequences have the same finite wire limit.
- Fleet teardown confirmations are trusted controller assertions; provider evidence is not independently checked or recorded by the strict store.
- Older versions may already have released reservations for uncertain slots. Quarantine and reconcile those slots before enabling admission after upgrade.
- Strict CI starts remain unavailable in production: the GitHub assignment lookup and hook endpoint are not wired, and the hook does not derive the actual assigned job on its own.
- Concurrent workflow resumes are not fenced. A crash between an external effect and its completion fact can repeat that effect. Journal sequences fail closed at the JavaScript safe-integer limit and require a format migration to continue. Legacy workflow records can lack identifying context. Sleep deadlines survive an explicit resume, but no host automatically discovers or wakes stopped runs; accurate clocks and a functioning waiter remain necessary. Old completed sleeps that returned immediately cannot be corrected retroactively. Journals do not identify commands nested inside a memoized step, so replay and resume can conservatively reject those histories; arbitrary effects outside recorded steps are not checked.
- Promotion and rollback binding assumes atomic journal claims and preserved metadata. Concurrent retries of the same operation and Rail effects that do not change the current Set still require fencing and reconciliation. Older records can be refused when their original request cannot be reconstructed.
- The delivery checks assume the storage transaction and its persisted attempt counter are durable. Callers must pass the attempt returned by each claim. They do not establish exactly-once external delivery.
- Budget proofs assume the recorded observations and evidence are accurate, and the relevant atomic storage operations work as specified. An authority's typed admission denial must mean it refused before writing; post-commit callback denials are converted to reconciliation errors. Provider charges can exceed a reservation; the ledger records the overrun. PostgreSQL and other provider integrations require their own exercised environments.
- TLC explores each finite configuration. The Z3 obligations prove mathematical abstractions for their stated assumptions. Neither alone proves that the TypeScript implementation refines the model, proves liveness, or establishes external provider behavior.

Lauren Tan's [statechart discussion](https://x.com/poteto/status/2118416074601545968), its [accessible mirror](https://potibo.dev/en/post/2118416074601545968), and [Pstack's verification guide](https://github.com/cursor/plugins/blob/main/pstack/docs/guide/06-verify-and-ship.md) motivate pairing human-readable charts, model checking, executable tests, and scoped proofs to reduce model drift.
