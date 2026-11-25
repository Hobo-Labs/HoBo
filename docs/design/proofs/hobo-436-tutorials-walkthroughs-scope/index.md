# HOBO-436 Tutorials & Walkthroughs M0 Scope Proof

HOBO-436 is proven by the focused M0 contract at
[`src/draft/exp-proofs/dx/tutorials-walkthroughs-scope-acceptance`](../../../../src/draft/exp-proofs/dx/tutorials-walkthroughs-scope-acceptance/README.md)
and the durable scope record at [tutorials-walkthroughs.md](../../tutorials-walkthroughs.md).

## Acceptance Evidence

- User and business goal is explicit for launch-safe tutorials and walkthroughs.
- Primary personas cover first-time app developer, coding agent, platform engineer evaluator, docs
  maintainer, and support operator.
- Scope in, scope out, non-goals, and service/UX/security/support boundaries are recorded.
- Dependencies map to the role walkthrough, worked example, DX command surface, Example Apps,
  Workspace & Onboarding UX, and ADR-0064.
- Owning initiative dependencies map Tutorials & Walkthroughs, Docs Portal, Example Apps, Workspace
  & Onboarding UX, Customer Onboarding, Support Workflow, launch assets, and release cutline without
  taking their scope.
- M1 evidence is listed as tutorial map, persona walkthrough scenarios, command transcripts,
  agent-run fixtures, accessibility/localization notes, and support handoff fixtures.
- Follow-up M1-M4 work is blocked until M0 acceptance is recorded.

## Negative Coverage

- Scope validation rejects docs-portal, launch-marketing, provider-credential, real-customer-data,
  and implementation creep inside M0.
- Evidence validation rejects user-visible tutorial claims without a proof mode.
- Follow-up gating refuses M1-M4 issue creation while M0 is not accepted.

## Verification

```powershell
pnpm --prefix src\draft\exp-proofs\tutorials-walkthroughs-scope-acceptance test
```
