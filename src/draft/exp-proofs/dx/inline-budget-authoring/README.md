# Inline budget authoring proof (HOBO-693)

Independent exp-proof for REM-028 / GAP-020. Pins the Plan 21 inline FinOps
declaration surface and `hobo plan` budget surfacing without implementing the
policy engine, MeteringView projection, or runtime degradation levers.

## Contract surface

- `normalizeCampPolicy(input)` — parse-don't-validate for inline `budget` and
  `costAvailabilityProfile` declarations authored on a Camp policy block.
- `surfacePlanBudget({ campName, period, projectedMonthlyUsd, policy, metering })`
  — builds the human **Cost & budget** block and the machine `budget` envelope
  fields that `hobo plan` / `hobo plan --json` surface at plan time.

## Scope boundaries

Included:

- Budget soft/hard headroom and warn vs would-deny annotations at plan time.
- Cost-availability tier preview when spend velocity would cross a tier before
  period end (warn-only; mirrors policy-plane `allow-degraded` semantics).
- JSON envelope carries `cost` estimate plus structured `budget` facts.

Excluded:

- Policy-engine evaluation, synchronous quota reservations, runtime shedding.
- MeteringView projection implementation and `spend.*` event production.
- Changes to the production `hobo plan` CLI (this proof is the contract).

## Verification

```bash
pnpm --prefix src/draft/exp-proofs/dx/inline-budget-authoring test
```

Design source: [Plan 21 FinOps inline budget](../../../../../docs/design/authoring-resources-wiring.md#finops--inline-budget--cost-availability).
