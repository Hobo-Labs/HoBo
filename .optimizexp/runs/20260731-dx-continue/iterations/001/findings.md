# Findings — iteration 001

## Experiments applied
- **E-1** `pnpm install --frozen-lockfile` — unlock happy path (anti-stall)
- **E-2** dx-preflight strip lone `--` from pnpm args
- **E-3** README install-first + doctor/agent:check ladder

## Residual implementable (must continue)
- R-1 konsistent packages/adapters container
- R-2 cli-docs: trails missing, deploy dual, messaging mention
- R-3 ADR-0131 wrong design index link
- R-4 traceability ADR-0129–0138 missing
- R-5 biome format debt (245 files) blocked lint:code when selected
