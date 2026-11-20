# Vendored Agent Plugins 1.0.0 schemas

Verbatim copies of the Agent Plugins 1.0.0 JSON Schemas that gate
`plugins/hobo` (`pnpm run agent-plugin:check`):

- `plugin.schema.json` — <https://agent-plugins.org/schemas/1.0.0/plugin.schema.json>
- `mcp.schema.json` — <https://agent-plugins.org/schemas/1.0.0/mcp.schema.json>

`plugin.json` `version` is checked against the fixed alpha train (`version.json` +
nbgv). On pull-request CI the gate pins to `GITHUB_HEAD_SHA` or, when that is
unset, `git rev-parse HEAD^2` so merge ref checkouts do not inflate the
expected height; during a staged commit the gate expects the next height when
`plugin.json` is in the index.

Source: agent-plugins.org, checked 2026-11-20. If the upstream schemas
change, re-vendor both files in the same change and update this date.
