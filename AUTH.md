# AUTH.md

**auth.md** is an [open protocol authored by WorkOS](https://workos.com/auth-md) for **agent
registration** with applications (discover flows, scopes, and how agents obtain scoped user
credentials). It is not a WorkOS product lock-in and not a HoBo-only invention — see the
[protocol / reference implementation](https://github.com/workos/auth.md).

This repository’s root `AUTH.md` currently documents **residual local coding-agent tooling**
keys and egress for humans and agents working **on the HoBo design/codebase** (gbrain, SkillOpt
backends, zero-key setup). That residual content does **not** redefine the WorkOS protocol.
Product agent-auth design for HoBo as a runtime lives in
[`docs/design/ai-native-agent-auth.md`](docs/design/ai-native-agent-auth.md) and the `hobo:auth`
ADR family; when public origins ship agent registration, they should publish auth.md per the
WorkOS format.

Full tooling narrative: [`docs/agent-tooling.md`](docs/agent-tooling.md). Agents never store
secrets: no `.env` files, no secret environment variables, no Actions secrets or variables
(the rule at the start of [`AGENTS.md`](AGENTS.md)). Credentials HoBo needs come from the
owner's store session (`choose_secret_store`, `owner://<NAME>`).

## Residual: local coding-agent keys & egress

### Default: zero keys

These need **no API keys** and stay local-first:

| Tool | Notes |
|---|---|
| Serena, headroom, RTK | Local MCP/CLI |
| improve, caveman, ponytail, superpowers skills | No keys; Superpowers may have optional telemetry (`SUPERPOWERS_DISABLE_TELEMETRY=1`) |
| tgrep, ast-grep | Local binaries |
| optimizexp review loop | Local bus + scorer; no network |

Recommended first setup:

```bash
bash scripts/setup-agent-tools.sh --help                 # usage (no install)
bash scripts/setup-agent-tools.sh --common-only --no-gbrain
pnpm run doctor                                          # includes agent-tooling checks
```

`pnpm run doctor` treats missing **gbrain** as a **warn** (exit 0 for zero-key): it prints a copy-pasteable
`bash scripts/setup-agent-tools.sh --common-only --no-gbrain` line plus this file. Decline the gbrain MCP
in your agent UI unless you intentionally opt in.

### Tools that need keys (opt-in)

Third-party tools below read keys from their own process environment. Agents never put a
key there or in a file; use each tool's zero-key mode.

| Tool | Env vars it reads | Data egress | Cost |
|---|---|---|---|
| **gbrain** | Exactly one of `OPENAI_API_KEY`, `ZEROENTROPY_API_KEY`, `VOYAGE_API_KEY` | Text embedded + queries go to that provider | Recurring embedding/API |
| **SkillOpt** live backends | Provider-specific (`ANTHROPIC_API_KEY`, Azure OpenAI, Qwen, MiniMax, …) | Prompts/code to chosen backend | Per-run |
| Product cloud providers | Per-Camp / secretless federation (see design ADRs) | Per provider | Per provider |

gbrain MCP is launched via [`scripts/agent-mcp-gbrain.sh`](scripts/agent-mcp-gbrain.sh), which **fails closed** when the binary or an initialized embedding provider is missing. Run `gbrain init --pglite` and choose local Ollama for zero-key, local embeddings, or configure one remote provider key. Remote providers receive embedding/query text; do not send them secrets or content you will not share with that third party.

### Agent rules (local residual)

1. Never store secrets: no `.env` files, secret environment variables, Actions secrets or variables, key files, or credential stores of your own (`secrets:guard`, `scripts/agent-secret-policy.mts`).
2. Never paste secret values into issues, bus entries, or skill files — reference `file:line` / env var **names** only.
3. Prefer identity federation / bound resources over stored secrets in product code ([ADR-0027](docs/design/adr/02-identity-security.md) family).
4. Decline optional MCP servers (gbrain) when you do not want egress.
5. OptimizeXP bus transcripts under `.optimizexp/` must redact secret-shaped strings.

### Per-agent config locations (local residual)

| Host | MCP | Skills |
|---|---|---|
| Claude Code | `.mcp.json` | `.claude/skills/` |
| Cursor | `.cursor/mcp.json` | `.agents/skills/` |
| Codex | `~/.codex/config.toml` (from `.codex/config.toml`) | `.agents/skills/` |

## Related

- WorkOS auth.md protocol: https://workos.com/auth-md · https://github.com/workos/auth.md
- [`docs/agent-tooling.md`](docs/agent-tooling.md) § Keys & risks
- Product agent-auth design: [`docs/design/ai-native-agent-auth.md`](docs/design/ai-native-agent-auth.md)
- OptimizeXP AX auth reference: `.agents/skills/optimizexp/references/ax/auth.md`
