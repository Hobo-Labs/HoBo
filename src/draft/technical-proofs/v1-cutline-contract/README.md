# V1 Cutline Contract

HOBO-401 defines the launch cutline that separates v1 blockers from post-v1 growth.
HOBO-454 extends that cutline with the M1 dogfood/alpha evidence gate.
HOBO-461 extends it again with the M2 private-beta release-program evidence gate.
HOBO-468 extends it with the M3 release-candidate release-program evidence gate.
HOBO-475 extends it with the M4 release-program GA handoff evidence gate.

This POC records a machine-checkable cutline in `src/v1-cutline.ts`:

- `inScope` lists the v1 work classes that can block launch.
- `outOfScope` lists work that must not be implemented in the cutline issue.
- `blockerCategories` maps each launch blocker class to an owning project or initiative.
- `followUpTaskPolicy` prevents M1-M4 execution fan-out before M0 acceptance.
- `v1CutlineDogfoodAlphaEvidence` records the M1 required evidence, blocker delta,
  accepted-risk register, cross-project handoffs, missing-evidence follow-ups, and parent
  release-readiness sync rule.
- `v1CutlinePrivateBetaEvidence` records the M2 private-beta required evidence, blockers,
  accepted risks, cross-project dependencies, existing follow-up issues for missing owner evidence,
  and parent release-readiness sync rule.
- `v1CutlineReleaseCandidateEvidence` records the M3 release-candidate required evidence,
  blocker delta, accepted-risk register, cross-project owner handoffs, the existing GA handoff
  follow-up, parent release-readiness sync, and public-claim guards.
- `v1CutlineGaHandoffEvidence` records the M4 GA handoff required evidence, open dependent M4
  blocker handoffs, accepted-risk register, cross-project owner dependencies, existing follow-ups
  for missing Dogfood Yard and Beta Pilot GA evidence, parent release-readiness sync, and
  public-claim guards.

The required readiness domains are reference architecture, productization, support, legal/privacy, documentation, and operations readiness. Scope-out entries cite the current design docs or ADR anchors so the public v1 boundary can be audited without inventing capability work in this slice.

The M1 gate is accepted only when required evidence is `accepted`, blockers and accepted risks are
recorded, follow-ups point to missing evidence, and parent launch-readiness status is updated when
launch risk changes.

The M2 private-beta gate follows the same guard: required release-program evidence must be
`accepted`, blockers and accepted risks must be recorded, follow-ups may only point to missing
evidence owned by existing private-beta issues, and parent launch-readiness status must be synced
when launch risk changes.

The M3 release-candidate gate keeps the same contract shape and adds a GA-claim guard: required
release-program evidence must be `accepted`, blockers and accepted risks must be recorded,
cross-project owner evidence must stay reflected in the cutline, follow-ups may only point to
missing evidence, parent launch-readiness status must be synced when launch risk changes, and
release-candidate evidence cannot publish GA readiness claims.

The M4 GA handoff gate keeps the same contract shape for the release-program owner lane: required
release-program evidence must be `accepted`, blockers and accepted risks must be recorded,
cross-project owner evidence must stay reflected in the cutline, follow-ups may only point to
missing evidence, parent launch-readiness status must be synced when launch risk changes, and GA
publication stays held while the Dogfood Yard and Beta Pilot M4 handoffs remain open.

Run:

```powershell
pnpm.cmd --prefix src\draft\technical-proofs\v1-cutline-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for V1 Cutline Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
