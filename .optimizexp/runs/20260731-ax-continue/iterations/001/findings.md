# AX continue pass 1 — findings

### F-1: setup re-installs present tools (noisy pip)
- Metrics (pre): friction=3, uncertainty=1
- Personas: product-agent-operator
- Evidence: re-run dumped pip “Requirement already satisfied” for headroom; uv reinstall serena
- Smallest reduction: skip reinstall when `have serena` / `have headroom` (match rtk/tgrep pattern)
- Effort: **S** → **applied** (E-1)

### F-2: serena/headroom MCP lack fail-closed remediation
- Metrics (pre): friction=2, uncertainty=2
- Personas: product-coding-agent
- Smallest reduction: `agent-mcp-serena.sh` + `agent-mcp-headroom.sh` fail-closed; wire MCP configs
- Effort: **S** → **applied** (E-2)

### F-3: feature failure scenario soft-failed on --help success
- Metrics: uncertainty=1 for measurement fidelity
- Smallest reduction: `observeFailure` runs `agent-mcp-gbrain.sh`
- Effort: **S** → **applied** (E-3)

### Residual
- Codex global config paste (host constraint)
- Hosts may still prompt to enable gbrain MCP (intentional opt-in)
- Full first-time install still network-bound (external)
