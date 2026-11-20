#!/usr/bin/env bash
# Set up agent tooling in layers:
#   1. common, harness-agnostic runtimes (Serena, headroom, RTK, SkillOpt, optional gbrain)
#   2. selected supported-agent shims (Claude Code, Cursor, Codex, Copilot)
#
# Examples:
#   bash scripts/setup-agent-tools.sh                       # common + all supported shims
#   bash scripts/setup-agent-tools.sh --common-only         # devcontainer/default safe layer
#   bash scripts/setup-agent-tools.sh --agent codex         # common + Codex shims only
#   bash scripts/setup-agent-tools.sh --agents codex,cursor # common + selected shims
#   bash scripts/setup-agent-tools.sh --no-gbrain           # skip key/egress memory tool
#   bash scripts/setup-agent-tools.sh --no-skillopt         # skip microsoft/SkillOpt install
#   bash scripts/setup-agent-tools.sh --help                # usage (no install)
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

usage() {
  cat <<'EOF'
Usage: bash scripts/setup-agent-tools.sh [options]

Install/configure coding-agent tools for this repo (progressive layers).

Options:
  --common-only          Common/devcontainer-safe layer only (no agent CLI shims)
  --agent NAME           One agent: claude-code | cursor | codex | copilot
  --agents a,b           Comma-separated agent list
  --no-gbrain            Skip gbrain (zero-key path; recommended first run)
  --no-skillopt          Skip microsoft/SkillOpt install
  -h, --help             Show this help and exit 0 (no install)

Examples:
  bash scripts/setup-agent-tools.sh --common-only --no-gbrain
  bash scripts/setup-agent-tools.sh --agent codex --no-gbrain

Keys / egress: AUTH.md
Narrative:     docs/agent-tooling.md
At-a-glance:   AGENTS.md
MCP launchers (fail-closed): scripts/agent-mcp-{serena,headroom,gbrain}.sh
Verify:        pnpm run doctor  (includes agent-tooling checks)
EOF
}

WANT_GBRAIN=1
WANT_SKILLOPT=1
COMMON_ONLY=0
AGENT_FILTER="claude-code,cursor,codex,copilot"
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --no-gbrain) WANT_GBRAIN=0 ;;
    --no-skillopt) WANT_SKILLOPT=0 ;;
    --common-only) COMMON_ONLY=1; AGENT_FILTER="" ;;
    --agent|--agents)
      opt="$1"
      shift
      [ "$#" -gt 0 ] || { echo "missing value for $opt" >&2; usage >&2; exit 2; }
      AGENT_FILTER="$1"
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
want_agent() { case ",$AGENT_FILTER," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
# `skills`/`npx`-based tools choke on a tsx-injecting NODE_OPTIONS; strip it.
NPX() { env -u NODE_OPTIONS npx "$@"; }

say "Probing runtimes"
for c in node npx pnpm python3 pip3 uv cargo gh curl tar brew serena headroom rtk tgrep skillopt-train skillopt-sleep bun claude codex copilot; do
  if have "$c"; then echo "  ok   $c"; else echo "  MISS $c"; fi
done

# Common layer: agent/harness-agnostic binaries and shared repo launchers.

say "Search tools (microsoft/tgrep + ast-grep) -> common/devcontainer layer"
if have tgrep; then
  echo "  tgrep present ($(tgrep --version 2>/dev/null || echo '?'))"
elif have gh && have tar; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) TGREP_TARGET="x86_64-unknown-linux-musl" ;;
    Linux-aarch64|Linux-arm64) TGREP_TARGET="aarch64-unknown-linux-musl" ;;
    Darwin-x86_64) TGREP_TARGET="x86_64-apple-darwin" ;;
    Darwin-arm64) TGREP_TARGET="aarch64-apple-darwin" ;;
    *) TGREP_TARGET="" ;;
  esac
  if [ -n "$TGREP_TARGET" ]; then
    mkdir -p "$HOME/.local/bin" /tmp/tgrep-dl
    rm -f /tmp/tgrep-dl/tgrep-*.tar.gz
    gh release download --repo microsoft/tgrep --pattern "*${TGREP_TARGET}*.tar.gz" -D /tmp/tgrep-dl \
      && tar -xzf /tmp/tgrep-dl/tgrep-*.tar.gz -C "$HOME/.local/bin" \
      && echo "  installed tgrep release to $HOME/.local/bin" || echo "  tgrep release install FAILED"
  else
    echo "  SKIP: unsupported tgrep release platform $(uname -s)-$(uname -m)"
  fi
elif have cargo; then
  cargo install --git https://github.com/microsoft/tgrep.git --locked tgrep-cli \
    && echo "  installed tgrep via cargo" || echo "  tgrep install FAILED"
elif have curl && have python3 && have tar; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) TGREP_TARGET="x86_64-unknown-linux-musl" ;;
    Linux-aarch64|Linux-arm64) TGREP_TARGET="aarch64-unknown-linux-musl" ;;
    Darwin-x86_64) TGREP_TARGET="x86_64-apple-darwin" ;;
    Darwin-arm64) TGREP_TARGET="aarch64-apple-darwin" ;;
    *) TGREP_TARGET="" ;;
  esac
  if [ -n "$TGREP_TARGET" ]; then
    mkdir -p "$HOME/.local/bin" /tmp/tgrep-dl
    TGREP_URL="$(
      python3 - "$TGREP_TARGET" <<'PY'
import json
import sys
import urllib.request

needle = sys.argv[1]
with urllib.request.urlopen("https://api.github.com/repos/microsoft/tgrep/releases/latest", timeout=20) as response:
    data = json.load(response)
print(next((asset["browser_download_url"] for asset in data.get("assets", []) if needle in asset.get("name", "") and asset.get("name", "").endswith(".tar.gz")), ""))
PY
    )"
    if [ -n "$TGREP_URL" ]; then
      curl -fsSL "$TGREP_URL" -o /tmp/tgrep-dl/tgrep.tar.gz \
        && tar -xzf /tmp/tgrep-dl/tgrep.tar.gz -C "$HOME/.local/bin" \
        && echo "  installed tgrep release to $HOME/.local/bin" || echo "  tgrep release install FAILED"
    else echo "  tgrep release not found for $TGREP_TARGET"; fi
  else
    echo "  SKIP: unsupported tgrep release platform $(uname -s)-$(uname -m)"
  fi
else echo "  SKIP: gh/tar, cargo, or curl/python/tar missing for tgrep"; fi
if have pnpm; then
  pnpm exec ast-grep --version >/dev/null 2>&1 && echo "  ast-grep verified via pnpm" || echo "  ast-grep unavailable; run pnpm install"
else echo "  SKIP: pnpm missing for ast-grep verification"; fi


say "GitHub Stacked PRs (github/gh-stack) -> gh CLI extension"
if have gh; then
  if gh extension list 2>/dev/null | grep -qE '[[:space:]]stack[[:space:]]|gh stack|github/gh-stack'; then
    gh extension upgrade stack 2>/dev/null \
      && echo "  gh-stack present/upgraded ($(gh stack --version 2>/dev/null || echo '?'))" \
      || echo "  gh-stack present (upgrade skipped)"
  else
    gh extension install github/gh-stack \
      && echo "  installed github/gh-stack" \
      || echo "  gh-stack install FAILED"
  fi
  # Agent-safe local git defaults when run inside a checkout (fail-open outside a repo).
  if [ -e .git ] || git rev-parse --git-dir >/dev/null 2>&1; then
    if git config --local rerere.enabled true 2>/dev/null; then
      echo "  local rerere.enabled=true"
    fi
    if git config --local remote.pushDefault origin 2>/dev/null; then
      echo "  local remote.pushDefault=origin"
    fi
  fi
  echo "  Docs: https://gh.io/stacks  | agent skill: .agents/skills/gh-stack + sdlc stacked-prs"
else
  echo "  SKIP: gh missing — install GitHub CLI then re-run"
fi

say "RTK (rtk-ai/rtk) -> token-compressing command proxy"
if have rtk; then
  echo "  rtk present ($(rtk --version 2>/dev/null || echo '?'))"
elif have brew; then
  brew install rtk && echo "  installed ($(rtk --version 2>/dev/null || echo '?'))" || echo "  rtk brew install FAILED"
elif have cargo; then
  cargo install --git https://github.com/rtk-ai/rtk \
    && echo "  installed rtk via cargo" || echo "  rtk cargo install FAILED"
elif have curl; then
  curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh \
    && echo "  installed rtk to $HOME/.local/bin" || echo "  rtk install script FAILED"
else echo "  SKIP: brew, cargo, or curl missing for rtk"; fi

say "Serena (oraios/serena) -> uv tool + shared MCP wrapper"
if have serena; then
  echo "  serena present ($(serena --version 2>/dev/null || echo '?')) — skip reinstall"
  serena init >/dev/null 2>&1 && echo "  initialized / already initialized" || echo "  init FAILED"
elif have uv; then
  uv tool install -p 3.13 serena-agent \
    && echo "  installed ($(command -v serena >/dev/null && serena --version 2>/dev/null || echo '?'))" || echo "  FAILED"
  SERENA_BIN="$(command -v serena || printf '%s/.local/bin/serena' "$HOME")"
  "$SERENA_BIN" init 2>/dev/null && echo "  initialized" || echo "  init skipped / already initialized"
elif have python3; then
  python3 -m pip install --user uv 2>/dev/null \
    || python3 -m pip install --user --break-system-packages uv
  "$HOME/.local/bin/uv" tool install -p 3.13 serena-agent \
    && echo "  installed ($(command -v serena >/dev/null && serena --version 2>/dev/null || echo '?'))" || echo "  FAILED"
  SERENA_BIN="$(command -v serena || printf '%s/.local/bin/serena' "$HOME")"
  "$SERENA_BIN" init 2>/dev/null && echo "  initialized" || echo "  init skipped / already initialized"
else echo "  SKIP: uv/python3 missing"; fi

say "headroom (chopratejas/headroom) -> pip + MCP server"
if have headroom; then
  echo "  headroom present ($(headroom --version 2>/dev/null || echo '?')) — skip reinstall"
elif have python3; then
  python3 -m pip install --user "headroom-ai[mcp]" 2>/dev/null \
    || python3 -m pip install --user --break-system-packages "headroom-ai[mcp]" \
    && echo "  installed ($(headroom --version 2>/dev/null || echo '?'))" || echo "  FAILED"
else echo "  SKIP: python3 missing"; fi

if [ "$WANT_SKILLOPT" = "1" ]; then
  say "SkillOpt (microsoft/SkillOpt) -> install CLI/runtime"
  SKILLOPT_SPEC="${SKILLOPT_SPEC:-git+https://github.com/microsoft/SkillOpt.git}"
  if have python3; then
    python3 -m pip install --user "$SKILLOPT_SPEC" 2>/dev/null \
      || python3 -m pip install --user --break-system-packages "$SKILLOPT_SPEC" \
      && echo "  installed skillopt" || echo "  FAILED"
    skillopt-train --help >/dev/null 2>&1 && echo "  verified skillopt-train" || echo "  skillopt-train not on PATH; add $HOME/.local/bin"
    skillopt-sleep --help >/dev/null 2>&1 && echo "  verified skillopt-sleep" || echo "  skillopt-sleep not on PATH; add $HOME/.local/bin"
  else echo "  SKIP: python3 missing"; fi
else
  say "SkillOpt — skipped (--no-skillopt)"
fi

if [ "$WANT_GBRAIN" = "1" ]; then
  say "gbrain (garrytan/gbrain) -> bun install"
  if have bun; then
    bun install -g github:garrytan/gbrain && echo "  installed ($(gbrain --version 2>/dev/null || echo '?'))" || echo "  FAILED"
    echo "  NEXT (manual): run 'gbrain init --pglite'; choose local Ollama or an API-key provider."
    echo "  NOTE: API-key providers receive embedding/query text (cost + egress); local Ollama does not."
  else echo "  SKIP: bun missing — install Bun first or rerun with --no-gbrain"; fi
else
  say "gbrain — skipped (--no-gbrain)"
fi

say "Shared MCP config"
echo "  Claude Code: ./.mcp.json (auto-discovered)."
echo "  Cursor:      ./.cursor/mcp.json."
echo "  Codex:       copy ./.codex/config.toml into ~/.codex/config.toml or use codex mcp add."

if [ "$COMMON_ONLY" = "1" ]; then
  say "Agent-specific setup skipped (--common-only)"
  echo "  Next: rerun with --agent claude-code|cursor|codex|copilot when you know which client to configure."
  say "Done"
  echo "Ensure these are on PATH: $HOME/.local/bin (rtk/headroom/uv/serena/skillopt), $HOME/.bun/bin (gbrain)."
  echo "Keys / egress: AUTH.md  |  narrative: docs/agent-tooling.md  |  table: AGENTS.md"
  exit 0
fi

# Agent-specific layer: only for the supported agents selected by --agent/--agents.
say "skills CLI installs -> selected Claude Code/Cursor/Codex skill dirs"
if have npx; then
  for spec in "DietrichGebert/ponytail" "mattpocock/skills"; do
    for ag in claude-code cursor codex; do
      want_agent "$ag" || continue
      NPX --yes skills add "$spec" --project --copy -a "$ag" -s '*' -y \
        && echo "  $spec installed for $ag" || echo "  $spec FAILED for $ag"
    done
  done
  echo "  NEXT (optional): run /setup-matt-pocock-skills in your agent for issue-tracker/domain-doc layout."
else echo "  SKIP: npx missing"; fi

say "caveman (JuliusBrussee/caveman) -> selected repo rule files"
if have npx; then
  CAVEMAN_ARGS=()
  want_agent claude-code && CAVEMAN_ARGS+=(--only claude)
  want_agent codex && CAVEMAN_ARGS+=(--only codex)
  want_agent cursor && CAVEMAN_ARGS+=(--only cursor)
  if [ "${#CAVEMAN_ARGS[@]}" -gt 0 ]; then
    NPX -y "github:JuliusBrussee/caveman" "${CAVEMAN_ARGS[@]}" --with-init --no-hooks \
      && echo "  installed" || echo "  FAILED"
    rm -rf .windsurf .clinerules .opencode
    if ! git ls-files --error-unmatch .github/copilot-instructions.md >/dev/null 2>&1; then
      rm -f .github/copilot-instructions.md
      rmdir .github 2>/dev/null || true
    fi
  else echo "  SKIP: no selected caveman-capable agent"; fi
else echo "  SKIP: npx missing"; fi

say "Register MCP servers in selected CLIs when present"
if want_agent claude-code && have claude; then
  claude mcp add serena -- bash scripts/agent-mcp-serena.sh 2>/dev/null && echo "  claude: added serena" || echo "  claude: serena already present / skipped"
  claude mcp add headroom -- bash scripts/agent-mcp-headroom.sh 2>/dev/null && echo "  claude: added headroom" || echo "  claude: headroom already present / skipped"
  [ "$WANT_GBRAIN" = "1" ] && { claude mcp add gbrain -- bash scripts/agent-mcp-gbrain.sh 2>/dev/null && echo "  claude: added gbrain" || echo "  claude: gbrain already present / skipped"; }
fi
if want_agent codex; then
  if have codex; then
    codex mcp add serena -- bash scripts/agent-mcp-serena.sh 2>/dev/null && echo "  codex: added serena" || echo "  codex: serena skipped"
    codex mcp add headroom -- bash scripts/agent-mcp-headroom.sh 2>/dev/null && echo "  codex: added headroom" || echo "  codex: skipped"
    [ "$WANT_GBRAIN" = "1" ] && { codex mcp add gbrain -- bash scripts/agent-mcp-gbrain.sh 2>/dev/null && echo "  codex: added gbrain" || echo "  codex: skipped"; }
  else
    echo "  Codex: CLI not found — use .codex/config.toml as the progressive setup reference."
  fi
fi


say "RTK hooks -> selected coding agents"
if have rtk; then
  mkdir -p "$HOME/.claude" "$HOME/.cursor"
  want_agent claude-code && { rtk init -g --auto-patch 2>/dev/null && echo "  claude-code: initialized" || echo "  claude-code: skipped / already initialized"; }
  want_agent codex && { rtk init -g --codex 2>/dev/null && echo "  codex: initialized" || echo "  codex: skipped / already initialized"; }
  want_agent cursor && { rtk init -g --agent cursor --auto-patch 2>/dev/null && echo "  cursor: initialized" || echo "  cursor: skipped / already initialized"; }
  want_agent copilot && { rtk init -g --auto-patch 2>/dev/null && echo "  copilot: initialized via default hook" || echo "  copilot: skipped / already initialized"; }
else echo "  SKIP: rtk missing; rerun common layer after installing it"; fi

say "superpowers (obra/Superpowers) -> selected plugin marketplaces"
for pair in "claude-code:claude" "codex:codex" "copilot:copilot"; do
  ag="${pair%%:*}"; cli="${pair##*:}"
  want_agent "$ag" || continue
  if have "$cli"; then
    "$cli" plugin marketplace add obra/superpowers-marketplace 2>/dev/null \
      && "$cli" plugin install superpowers@superpowers-marketplace 2>/dev/null \
      && echo "  $cli: installed superpowers" || echo "  $cli: skipped / already present"
  else echo "  $cli: CLI not found — install superpowers via its /plugin marketplace when available."; fi
done
echo "  NOTE: superpowers skills load at SESSION START — open a fresh session to use them."

say "Done"
echo "Ensure these are on PATH: $HOME/.local/bin (rtk/headroom/uv/serena/skillopt), $HOME/.bun/bin (gbrain)."
echo "Keys / egress: AUTH.md  |  narrative: docs/agent-tooling.md  |  table: AGENTS.md"
echo "Optional gbrain MCP uses scripts/agent-mcp-gbrain.sh (fails closed with remediation when binary/key missing)."
