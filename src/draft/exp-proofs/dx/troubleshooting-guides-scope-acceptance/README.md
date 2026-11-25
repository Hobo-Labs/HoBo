# Troubleshooting Guides Scope Acceptance POC

HOBO-437 proof for Troubleshooting Guides M0 scope and acceptance.

## What This Proves

- Troubleshooting Guides has an explicit user/business goal and five primary personas.
- Scope in, scope out, non-goals, and service/UX/security/support boundaries are machine-checkable.
- The scope record depends on developer experience, role walkthroughs, launch support, support SLA channels, incident communications, public status-page boundaries, and ADR-0064.
- Owning initiative dependencies are mapped without moving docs portal, support workflow, incident communications, public status page, or release cutline work into this issue.
- M1 evidence requirements are listed with owner, proof mode, and what each item proves.
- Follow-up M1-M4 work remains gated until M0 acceptance is recorded.

## Boundary

This package validates the M0 scope record. It does not build final troubleshooting content, docs portal IA, support queues, status-page publishing, incident communications, runtime remediation, provider repair, or downstream implementation issues.

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\troubleshooting-guides-scope-acceptance test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by `scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for Troubleshooting Guides Scope Acceptance.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
