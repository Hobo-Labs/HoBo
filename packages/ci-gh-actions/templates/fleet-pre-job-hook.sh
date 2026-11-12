#!/usr/bin/env bash
# Immutable pre-job hook (design §9.3). Installed outside the workspace.
# Every body field is an unverified claim: the controller authorizes only an
# assignment its own GitHub lookup confirms for RUNNER_NAME, and any curl or
# HTTP failure exits nonzero so the job never starts unfenced.
set -euo pipefail
: "${HOBO_START_FENCE_URL:?}"
: "${HOBO_SLOT_ID:?}"
: "${HOBO_CLAIM_ID:?}"
: "${HOBO_BINDING_SECRET:?}"
: "${GITHUB_REPOSITORY:?}"
: "${GITHUB_RUN_ID:?}"
: "${GITHUB_JOB:?}"
: "${GITHUB_RUN_ATTEMPT:?}"
: "${RUNNER_NAME:?}"

payload="$(node - <<'NODE'
const payload = {
  slotId: process.env.HOBO_SLOT_ID,
  claimId: process.env.HOBO_CLAIM_ID,
  bindingSecret: process.env.HOBO_BINDING_SECRET,
  accountId: process.env.HOBO_ACCOUNT_ID,
  runnerName: process.env.RUNNER_NAME,
  profileId: process.env.HOBO_PROFILE_ID,
  executionKey: JSON.parse(process.env.HOBO_EXECUTION_KEY_JSON),
};
process.stdout.write(JSON.stringify(payload));
NODE
)"

curl -fsS --max-time "${HOBO_START_FENCE_TIMEOUT_SEC:-30}" \
  -H "Content-Type: application/json" \
  -H "Cache-Control: no-store" \
  -X POST "${HOBO_START_FENCE_URL}" \
  --data "${payload}" >/dev/null
