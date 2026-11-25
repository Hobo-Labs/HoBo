# S4-01 Stage Gate Acceptance Record

Executable proof for **HOBO-645** (S4-09): Stage-4 closure on
`examples/multi-cloud-shop`.

## Scope

Stage-4 gate drill proving OBJ-1 and `requirements.md` Stage 4 acceptance:

1. Same unedited Bindle on AWS and Azure via mapping rules.
2. Cross-cloud SVID-keyed mTLS between services.
3. Unsatisfied `require` → `deployment.PlanRejected` with precise reason.
4. J3 provider switch changes only Camp mapping.
5. Installed Resource Pack participates in Matching resolution.

## Executable Proof

Package: `src/draft/technical-proofs/s4-stage-gate-multi-cloud-contract/`

```bash
pnpm --prefix src/draft/technical-proofs/s4-stage-gate-multi-cloud-contract test
node --import tsx src/draft/technical-proofs/s4-stage-gate-multi-cloud-contract/scripts/run-s4-stage-gate-drill.ts --phase deploy-and-assert --run-id local
```

CI lane: `.github/workflows/hobo-ci.yml` job `s4-stage-gate-drill` (label `hobo/s4-drill`).

## Maintenance

HOBO-645 owns this acceptance record. Blockers S4-07/S4-08 may extend production
lanes; this draft POC remains the independent gate contract until those merge.

Architecture evidence (parse-don't-validate, event flow) lives in
`src/draft/technical-proofs/s4-stage-gate-multi-cloud-contract/ADR.md`.
