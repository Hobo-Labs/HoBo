# Beta Pilot Feedback Contract

HOBO-404 defines the private beta pilot cohort and feedback intake contract.

This POC records a machine-checkable M0 contract in `src/beta-pilot-feedback.mjs`:

- cohort criteria for selecting and excluding beta pilots;
- feedback intake fields for persona, environment, workflow, severity, evidence, and customer impact;
- triage routes from beta feedback to cutline, support, product UX, docs, or capability projects;
- release-candidate exit criteria;
- scope guards against onboarding customers or building general feedback infrastructure in this slice.

Run:

```sh
npm --prefix src/draft/exp-proofs/cx/beta-pilot-feedback-contract test
pnpm exec oxlint src/draft/exp-proofs/cx/beta-pilot-feedback-contract --deny-warnings
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Beta Pilot Feedback Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
