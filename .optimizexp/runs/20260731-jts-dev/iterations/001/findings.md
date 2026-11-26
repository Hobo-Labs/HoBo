### F-1: agent:check unusable without node_modules/tsx
- Metrics (judged): friction=4, uncertainty=3 (Δ expect +2 friction, +2 uncertainty)
- Persona: junior-typescript-developer
- Evidence: .optimizexp/features/agent-check-staged/evidence/staged-agent-check-is-narrow-and-actionable-after-a-skill-edit-works-for-junior-typescript-developer/primary.txt , bus 2026-07-31T03:28:20Z-0003
- Smallest reduction: Document zero-install failure as `pnpm install` first in agent:check / doctor; make --help work without full deps if possible; fix evidence harness exit codes for pipelines
- Effort: M
