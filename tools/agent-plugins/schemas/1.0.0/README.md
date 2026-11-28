# Vendored Agent Plugins 1.0.0 schemas

Verbatim copies of the Agent Plugins 1.0.0 JSON Schemas that gate
`plugins/hobo` (`pnpm run agent-plugin:check`):

- `plugin.schema.json` — <https://agent-plugins.org/schemas/1.0.0/plugin.schema.json>
- `mcp.schema.json` — <https://agent-plugins.org/schemas/1.0.0/mcp.schema.json>

`plugin.json` `version` must exactly equal the fixed alpha train value derived
from `version.json` (`versionHeightOffset` included) and nbgv: a height that is
stale, ahead, or otherwise differs fails on every event path. On pull-request
CI the gate verifies the branch tip from `HEAD^2`, `GITHUB_SHA^2`, the GitHub
event payload, and `GITHUB_HEAD_SHA`; disagreeing or unverifiable sources fail
closed. A squashed single-parent merge-group commit is measured at `HEAD`, the
commit that lands. Shallow checkouts fail closed because nbgv height needs full history.
During a staged commit the gate validates the staged `plugin.json` blob and
expects the next height. Version computation failures fail closed;
`HOBO_AGENT_PLUGIN_SKIP_RELEASE_TRAIN=1` is an explicit local-only skip. The
gate rejects that skip under any recognized CI signal, including TeamCity,
GitLab, CircleCI, Buildkite, and CodeBuild, even when version computation would
otherwise succeed; Turbo's `HOBO_*` passthrough does not weaken the CI
requirement.

`mcp.json` is parsed against `mcp.schema.json` and then semantically validated:
stdio executables must resolve as a PATH command or a contained
plugin-rooted path, and HTTP/SSE endpoints must use `https` with a public DNS
hostname (no IP, credential, expansion, or traversal). Vendored schema bytes
are pinned by `MANIFEST.sha256` and checked before those gates run.

Source: agent-plugins.org, checked 2026-11-20. If the upstream schemas
change, re-vendor both files in the same change and update this date.
