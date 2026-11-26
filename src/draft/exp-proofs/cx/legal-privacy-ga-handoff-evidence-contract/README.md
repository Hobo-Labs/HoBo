# Legal Privacy GA Handoff Evidence Contract

Executable M4 proof for HOBO-478, proving V1 Legal, Privacy & Terms Readiness
GA handoff evidence without drafting legal text, implementing legal workflow
software, enabling billing, or publishing unsupported compliance claims.

## Focused Gate

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\cx\legal-privacy-ga-handoff-evidence-contract test
```

## Proof Surface

- `legalPrivacyGaHandoffEvidence` records the M4 evidence set, owners,
  blockers, accepted risks, release-cutline dependencies, follow-up boundaries,
  parent release-readiness sync, and scope guards.
- `validateLegalPrivacyGaHandoffEvidence` fails closed on malformed evidence,
  missing owner mappings, unknown blocker evidence, weak release-cutline
  categories, speculative follow-up issues, unsynced parent readiness updates,
  final legal drafting, legal workflow implementation, billing/paid-launch
  enablement, and unsupported public legal/privacy claims.

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Required evidence for this phase is listed and mapped to owning projects. | Tests assert at least seven M4 legal/privacy evidence records with owner/source/acceptance mappings. |
| Blockers and accepted risks are recorded. | Tests assert GA blockers and accepted risks are present and tied back to known evidence. |
| Cross-project dependencies are reflected in the release cutline. | Tests assert legal, privacy, customer-assurance, security, and release-cutline domains use `v1-blocker.*` categories. |
| Follow-up execution issues are created only where evidence is missing. | Tests assert the GA gate has no missing evidence or speculative follow-ups and rejects follow-ups against accepted evidence. |
| Parent HoBo v1 Release Readiness status updates if this gate changes launch risk. | Tests assert parent readiness sync and a source-backed update when launch risk changes. |

## Scope Guards

This proof deliberately does not draft final customer terms, privacy policy, DPA,
regional legal notices, or legal advice text. It does not implement legal
workflow, contract lifecycle, billing, paid-launch mechanics, commercial terms,
or compliance certification claims.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for the GA handoff
  evidence record.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
