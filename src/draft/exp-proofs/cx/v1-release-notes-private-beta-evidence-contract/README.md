# V1 Release Notes Private Beta Evidence Contract

HOBO-466 proves the M2 private-beta evidence gate for the V1 Release Notes & Upgrade Guide project.

This focused proof records:

- required private-beta release-note and upgrade-guide evidence mapped to owning projects;
- blocker and accepted-risk records with owners and M3 revisit gates;
- release-cutline dependencies for every evidence owner;
- a follow-up guard that permits execution issues only when evidence is missing;
- a parent HoBo v1 Release Readiness status-update requirement when launch risk changes.

## Boundary

This package does not publish final release notes, write launch copy, implement an upgrade runner,
change support workflows, or create speculative follow-up work. It records the private-beta evidence
gate and fails closed when evidence, cutline, risk, or status-update facts are missing.
Malformed nested payloads and unsupported evidence statuses are reported as parser errors instead of
throwing before the gate can make a decision.

## Verification

```powershell
npm.cmd --prefix src\draft\v1-release-notes-private-beta-evidence-contract test
```

The root `pnpm-lock.yaml` registers this dependency-free workspace package so install and routed
agent gates include the proof in fresh worktrees.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for the evidence record.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ARCHITECTURE.md` — parse-don't-validate and event-architecture evidence.
