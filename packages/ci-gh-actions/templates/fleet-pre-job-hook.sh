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
: "${HOBO_ACCOUNT_ID:?}"
: "${HOBO_PROFILE_ID:?}"
: "${HOBO_EXECUTION_KEY_JSON:?}"
: "${GITHUB_REPOSITORY:?}"
: "${GITHUB_RUN_ID:?}"
: "${GITHUB_JOB:?}"
: "${GITHUB_RUN_ATTEMPT:?}"
: "${RUNNER_NAME:?}"

payload="$(node - <<'NODE'
try {
  const payload = {
    slotId: process.env.HOBO_SLOT_ID,
    claimId: process.env.HOBO_CLAIM_ID,
    bindingSecret: process.env.HOBO_BINDING_SECRET,
    accountId: process.env.HOBO_ACCOUNT_ID,
    runnerName: process.env.RUNNER_NAME,
    profileId: process.env.HOBO_PROFILE_ID,
    executionKey: JSON.parse(process.env.HOBO_EXECUTION_KEY_JSON),
  };
  const job = payload.executionKey?.githubJob;
  const fields = ['accountId', 'engineId', 'installationId', 'repositoryId', 'runId', 'jobId'];
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(payload.executionKey) || Object.keys(payload.executionKey).length !== 1 ||
      !object(job) || Object.keys(job).length !== 8 || job.kind !== 'github-job' ||
      !fields.every((field) => typeof job[field] === 'string' && job[field].length > 0) ||
      !Number.isSafeInteger(job.runAttempt) || job.runAttempt < 1 ||
      job.accountId !== payload.accountId || job.runId !== process.env.GITHUB_RUN_ID ||
      String(job.runAttempt) !== process.env.GITHUB_RUN_ATTEMPT) process.exit(43);
  process.stdout.write(JSON.stringify(payload));
} catch {
  process.exit(43);
}
NODE
)"

receipt_file="$(mktemp "${TMPDIR:-/tmp}/hobo-start-fence.XXXXXX")"
trap 'rm -f -- "$receipt_file"' EXIT
if ! status="$(printf '%s' "$payload" | curl -fsS \
  --max-time "${HOBO_START_FENCE_TIMEOUT_SEC:-30}" --max-filesize 65536 \
  -H "Content-Type: application/json" -H "Cache-Control: no-store" \
  -X POST "${HOBO_START_FENCE_URL}" --data-binary @- \
  --output "$receipt_file" --write-out '%{http_code}')"; then
  exit 43
fi
if [[ "$status" != 200 ]]; then exit 43; fi

HOBO_FENCE_REQUEST="$payload" node - "$receipt_file" <<'NODE'
try {
  const fs = require('node:fs');
  if (fs.statSync(process.argv[2]).size > 65536) process.exit(43);
  const request = JSON.parse(process.env.HOBO_FENCE_REQUEST);
  const receipt = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const fields = ['kind', 'accountId', 'engineId', 'installationId', 'repositoryId', 'runId', 'jobId', 'runAttempt'];
  const expected = request.executionKey.githubJob;
  const actual = receipt?.executionKey?.githubJob;
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (receipt?.ok !== true || receipt.slotId !== request.slotId ||
      receipt.claimId !== request.claimId || receipt.accountId !== request.accountId ||
      receipt.profileId !== request.profileId || receipt.runnerName !== request.runnerName ||
      !object(receipt.executionKey) || Object.keys(receipt.executionKey).length !== 1 ||
      !object(actual) || Object.keys(actual).length !== fields.length ||
      !fields.every((field) => actual[field] === expected[field])) process.exit(43);
} catch {
  process.exit(43);
}
NODE
