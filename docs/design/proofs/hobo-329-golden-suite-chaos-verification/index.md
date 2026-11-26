# HOBO-329 Golden Suite Chaos Verification Proof

This proof pins the Golden-suite and chaos verification tier from
[Plan 05](../../reliability-observability-cost.md#plan-05), the generated-stack verification
surface from [Plan 09](../../generated-stack.md#plan-09), the chaos policy budget from
[Plan 29](../../contracts-policy-flags.md#plan-29), SLO-as-code gating from
[ADR-0045](../../adr/02-identity-security.md#adr-0045), bounded chaos from
[ADR-0047](../../adr/02-identity-security.md#adr-0047), and Golden Suites from
[ADR-0082](../../adr/02-identity-security.md#adr-0082).

Executable proof:

- package: `src/draft/technical-proofs/golden-suite-chaos-verification-contract`
- test command: `npm.cmd --prefix src\draft\technical-proofs\golden-suite-chaos-verification-contract test`

Acceptance coverage:

- a node-loss chaos experiment checks a deploy-resume SLO invariant and aborts on breach.
- a Golden-suite failure plus SLO budget burn emits `rollout.AutoRollbackRequired`.
- CI coverage fails unless the Golden suite ran against both `runtime-local` and Camp.
- prod chaos is denied before fault injection when policy budget or blast radius would be exceeded.

Adversarial coverage:

- observed blast-radius leaks hard-abort the experiment.
- an unarmed abort condition dead-man aborts before fault injection.
- flaky Golden-suite failures quarantine instead of causing spurious rollback.
- budget-aware policy denies continuous prod chaos that would spend the monitored error budget.
- injector cleanup failure fails closed and is replayable from emitted events.

Scope boundary:

- SLO computation, multi-window burn-rate math, and saga compensation are reused as inputs.
- fault primitives and external chaos engines remain adapter work.
- Harness rollout adapters, dashboards, and the SRE operator stay out of this branch.
