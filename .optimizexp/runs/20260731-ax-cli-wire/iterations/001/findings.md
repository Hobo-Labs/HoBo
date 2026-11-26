# AX pass — cli-help-and-doctor rewire

### F-1: feature primaryCommand was eval:agent:live
- Metrics (pre): harms=1, friction=4, uncertainty=3
- Personas: product-coding-agent, product-agent-operator
- Evidence: feature.json + implementations.ts pointed at live eval
- Seed: offline help/doctor without cloud credentials
- Smallest reduction: rewire to `pnpm run doctor` (+ setup --help surface); fix discovery.json
- Effort: **S** → **applied** (E-1)

### F-2: doctor warn only on stderr
- Metrics: uncertainty=1 for stdout-only captures
- Smallest reduction: `warn` via console.log with `warn ` prefix
- Effort: **S** → **applied** (E-2)

### F-3: no regression test for doctor agent-tooling lines
- Smallest reduction: `test/doctor-agent-tooling.test.ts`
- Effort: **S** → **applied** (E-3)

### Residual
- Codex global config paste (host)
- First-time network install (external)
