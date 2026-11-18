# OptimizeXP run summary: `hobo-code`

> **Historical record:** The `packages/code` product was removed. This summary is preserved as a
> historical record, not evidence of a current capability. The later
> [re-certification](../20260803-hobo-code-recert/summary.md) found that its
> iteration scores were not committed and its purported TTY capture used the
> non-TTY path, so the completeness claims below cannot be audited.

Run: `20260801-hobo-code-optimizexp`  
Product: `hobo-code` (`packages/code`, project id `code`)  
Experiences: DX, UX  
Stop reason: `pareto-equilibrium`

## What changed

Empty non-TTY invocation now fails closed before dispatch. It returns the stable
`HOBO_CODE_INTERACTIVE_REQUIRED` code and actionable `hobo-code help` /
`hobo-code "describe the change"` remediation. JSON callers receive
`interactiveRequired: true` and a `remediation[]` contract. The package README
documents the TTY/non-TTY entry contract.

## Evidence and validation

- Replayable TUI evidence (cast + self-contained HTML replay):
  `packages/code/.optimizexp/features/hobo-code-default-entry/evidence/cold-start-bare-tty-shows-product-discoverability-for-protocol-native-coding-agent/REPLAY.html`
- Evidence review is accepted with complete full-journey claim coverage and
  matching hashes (`review.json`).
- The `@hobo/code` suite passed: 117 passed, 4 skipped.
- Harm scores reduced from 11 to 2, then remained flat for two independent
  measurements; no implementable S/M harm findings remain.
- Delight scores are 4/5 for excitement, ease of use, and perceived optimality;
  cognitive thresholds have no breaches.
- Three write-ahead expect → act → outcome triples validate the persona feedback
  and the implemented reduction/uplift.

The run is complete only after `assert-complete` succeeds and `mark-complete`
records this stop reason.
