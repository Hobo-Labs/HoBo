# HOBO-375 Experiment Guardrails Proof

This proof connects the OpenExperiment peeking, p-hacking, multiplicity, and
under-power guardrails to:

- [contracts-policy-flags.md](../../contracts-policy-flags.md#plan-29)
- [reliability-observability-cost.md](../../reliability-observability-cost.md#plan-05)
- [ADR-0083](../../adr/02-identity-security.md#adr-0083)

Executable artifact:

- [`src/draft/technical-proofs/experiment-statistical-analysis-contract`](../../../../src/draft/technical-proofs/experiment-statistical-analysis-contract)

Acceptance evidence:

- Locked look schedules return `inconclusive` before the scheduled analysis
  point, even when the mid-experiment sample would look favorable.
- Missing locked schedules fail closed instead of allowing the legacy default
  winner path.
- Bonferroni correction is applied across the pre-registered metric family,
  raising the effective confidence threshold for many-metric analyses.
- Pre-registered segment families contribute to the Bonferroni family size, so
  a segment-specific conclusion is not an uncorrected free win.
- Required sample-size power floors prevent tiny favorable samples from
  declaring `winner` or `no-difference`.
- The primary metric must match the pre-registered primary metric.
- The A/A calibration corpus runs repeated looks across neutral experiments:
  early looks remain `inconclusive`, the locked final look reaches
  `no-difference`, and no run produces a spurious `winner`.

Adversarial evidence:

- Analysis-plan opt-outs for peeking or multiplicity are rejected.
- A post-hoc primary metric swap fails closed with
  `post-hoc-primary-metric`.
- A post-hoc segment cherry-pick fails closed with `post-hoc-segment` instead
  of treating the segment as an uncorrected free win.

Scope boundary:

- Assignment and exposure collection remain in HOBO-349.
- The base statistical-analysis engine remains HOBO-353.
- Provider adapters and ML/training-engine integration remain out of scope.

Verification:

```powershell
npm.cmd --prefix src\draft\technical-proofs\experiment-statistical-analysis-contract test
```
