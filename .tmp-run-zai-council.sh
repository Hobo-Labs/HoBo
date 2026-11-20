#!/usr/bin/env bash
set -euo pipefail
cd /agent/repos/HoBo
git fetch origin codex/wasp-admin-settings
node /tmp/council-run.mjs chunked '{"agent":"zai","pr":2067,"headRef":"HEAD","baseRef":"origin/codex/wasp-admin-settings","baseLabel":"origin/codex/wasp-admin-settings","headShort":"ec1f38a32"}' > /opt/cursor/artifacts/zai-council-2067.log 2>&1
echo $? > /opt/cursor/artifacts/zai-council-2067.exit