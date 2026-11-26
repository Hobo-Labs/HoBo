# Pass 1 reductions — 20260731-ax-review

## E-1: setup --help + usage on unknown
- Finding: F-1
- Hypothesis: usage lowers friction/uncertainty for operator cold path
- Files: `scripts/setup-agent-tools.sh`
- Expected: friction 3→0, uncertainty 3→0 on help surface
- Result: **improved**

## E-2: gbrain fail-closed launcher
- Finding: F-2
- Hypothesis: AUTH remediation on missing binary/key cuts harms + uncertainty
- Files: `scripts/agent-mcp-gbrain.sh` (new), `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, setup mcp-add lines
- Expected: harms 1→0, uncertainty 3→0 on gbrain failure path
- Result: **improved** (exit 1 with AUTH.md + zero-key next steps)

## E-3: AUTH pointers in Done / docs / AGENTS / .env.example
- Finding: F-3
- Files: `scripts/setup-agent-tools.sh` Done footer, `AUTH.md`, `docs/agent-tooling.md`, `AGENTS.md`, `.env.example`
- Result: **improved**

## E-4: rewire agent-tooling-setup critical path
- Finding: F-4
- Files: `.optimizexp/features/agent-tooling-setup/feature.json`, `steps/implementations.ts`, `steps/discovery.json`
- Result: **improved** (bindings test 4/4 pass; evidence on help+gbrain+mirror)

## Verify
- `bash scripts/setup-agent-tools.sh --help` → exit 0, AUTH named
- `bash scripts/agent-mcp-gbrain.sh` → exit 1, remediation
- `pnpm run skills:mirror-check` → OK
- `pnpm run test:file .optimizexp/features/agent-tooling-setup/test/…` → 4 passed
