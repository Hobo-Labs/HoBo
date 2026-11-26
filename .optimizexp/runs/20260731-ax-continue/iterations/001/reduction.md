# Pass 1 reductions — 20260731-ax-continue

## E-1: skip reinstall when tools present
- Files: `scripts/setup-agent-tools.sh` (serena, headroom)
- Result: **improved** — re-run ~1.55s, “skip reinstall”, no pip dump

## E-2: fail-closed MCP launchers for serena + headroom
- Files: `scripts/agent-mcp-serena.sh`, `scripts/agent-mcp-headroom.sh` (new),
  `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, setup `mcp add` lines,
  `docs/agent-tooling.md`, `AGENTS.md`
- Result: **improved** — missing binary → exit 1 + setup remediation

## E-3: feature failure path uses gbrain fail-closed
- Files: `.optimizexp/features/agent-tooling-setup/steps/implementations.ts`, `feature.json`
- Result: **improved** — bindings 4/4; failure evidence captures AUTH remediation
