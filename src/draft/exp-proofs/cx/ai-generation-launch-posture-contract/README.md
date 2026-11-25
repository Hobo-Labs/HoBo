# AI Generation Launch Posture Contract

Independent POC for HOBO-510. It pins the M0 customer-facing launch posture for AI
generation: what inputs are supported, what is refused, which safety controls must be
named, how findings route to launch owners, and which public claims are allowed.

## Contract Surface

- `AI_GENERATION_LAUNCH_POSTURE` is versioned as
  `hobo.ai-generation-launch-posture/v1`.
- Supported inputs cover app intent, WIT/conformance contracts, provider docs,
  recorded traces, and design/UI intent.
- Prohibited uses cover malware or credential theft, policy bypass, unsafe regulated
  advice, privacy-invasive generation, impersonation, and unapproved live infra change.
- Required safety controls cover material sanitization, no-egress validation,
  guardrail policy gates, generated-code review/SBOM, human approval, and red-team
  regression evidence.
- Findings route to security verification, legal/privacy, support, and release cutline
  owners before any beta or GA claim can stand.
- Public claims must match reviewed wording and carry architecture evidence, proof
  evidence, known limitation text, and a review owner.

## Scope Boundaries

Included:

- Deterministic launch-posture fixture and validator.
- Beta vs GA evidence and blocker posture.
- Customer-facing limitation and support routing map.
- Public-claim review guard.
- Scope guard for implementation creep.

Excluded:

- Guardrail engine implementation.
- Live model provider integration.
- Responsible-AI attestation program.
- Legal terms or privacy-policy text.
- Production red-team service.
- Generation runtime or Registry implementation.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\cx\ai-generation-launch-posture-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Ai Generation Launch Posture Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
