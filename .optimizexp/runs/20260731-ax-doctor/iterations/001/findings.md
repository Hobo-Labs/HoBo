# AX doctor pass 1

### F-1: doctor silent on agent tooling
- Metrics (pre): friction=2, uncertainty=3
- Personas: product-agent-operator, product-coding-agent
- Evidence: pre-reduce doctor only Node/pnpm/tsx/AGENTS
- Smallest reduction: extend `scripts/doctor.ts` with AUTH/MCP/setup --help/launchers + optional PATH warns
- Effort: **S** → **applied** (E-1)

### Residual
- Codex still needs global config paste (host)
- First-time network install (external)
- gbrain warn when absent is intentional zero-key
