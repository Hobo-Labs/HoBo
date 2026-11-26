# AX pass 1 findings — 20260731-ax-review

Pre-reduce baseline metric_max=3. Surfaces: setup script, gbrain MCP, skill mirrors.

### F-1: setup-agent-tools.sh has no --help / usage
- Metrics (judged pre-reduce): friction=3, uncertainty=3
- Personas: product-agent-operator, product-coding-agent
- Evidence: live probe `bash scripts/setup-agent-tools.sh --help` → `unknown option: --help` exit 2
- Smallest reduction: add `-h|--help` usage() and print usage on unknown options
- Effort: **S**
- Status: **applied** (E-1)

### F-2: gbrain MCP bare command fails without remediation
- Metrics (judged pre-reduce): harms=1, friction=2, uncertainty=3
- Personas: product-coding-agent, product-agent-operator
- Evidence: gbrain not on PATH; bare host error; AUTH not named in failure path
- Smallest reduction: shared `scripts/agent-mcp-gbrain.sh` fail-closed + AUTH remediation; wire `.mcp.json` / `.cursor/mcp.json` / `.codex/config.toml` + setup `mcp add`
- Effort: **S**
- Status: **applied** (E-2)

### F-3: Done footer / Cursor MCP comment weak AUTH pointer
- Metrics: uncertainty=2
- Personas: product-agent-operator
- Smallest reduction: Done footer + Cursor `$comment` + AUTH.md / docs / AGENTS table updates
- Effort: **S**
- Status: **applied** (E-3)

### F-4: agent-tooling-setup primaryCommand only skills:mirror-check
- Metrics: friction=2 (wrong journey measured)
- Personas: product-coding-agent
- Smallest reduction: rewire primary to `bash scripts/setup-agent-tools.sh --help`; discovery + implementations
- Effort: **S**
- Status: **applied** (E-4)

### Residual (not implementable S/M for these cells)
- Full `setup-agent-tools.sh` install is still long when tools already present (L — idempotent quiet mode)
- Codex still requires global `~/.codex/config.toml` paste (external host constraint; project template documents it)
- gbrain remains listed in MCP configs so hosts may prompt — intentional opt-in with fail-closed (decline for zero-key)
