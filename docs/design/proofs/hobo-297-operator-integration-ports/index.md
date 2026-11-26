# HOBO-297 Operator Integration Ports Proof

This proof pins the operator integration-port seam from
[Plan 40](../../operators-sre.md#plan-40), the operator-facing control-plane
seams from [Plan 04](../../control-plane.md#plan-04), the receiver-style port
pattern from [ADR-0059](../../adr/03-data-plane.md#adr-0059), and the
swappable integration-port decision from
[ADR-0073](../../adr/07-portability-extensibility.md#adr-0073).

Executable proof:

- package: `src/draft/technical-proofs/operator-integration-ports-contract`
- test command: `npm.cmd --prefix src\draft\technical-proofs\operator-integration-ports-contract test`

Acceptance coverage:

- an Incident sync produces a linked ticket through the configured
  `issue-tracker` port.
- a postmortem publish rides `policy.Decided` plus `crew.ActionApplied`
  through the configured `knowledge` port.
- switching issue-tracker and knowledge providers is config-only via
  registered adapter ids.

Adversarial coverage:

- a failed ticket write keeps the Incident link pending and retries with the
  same idempotency key.
- an internal-only postmortem cannot publish to a public knowledge space when
  policy denies the write; the adapter is not called and the audit emits
  `crew.ActionDenied`.

Scope boundary:

- concrete provider adapters are out of scope.
- adapter generation and conformance matrices are out of scope.
- the proof records the operator-port contract only; it does not implement the
  full SRE planner, policy engine, or credential broker.
