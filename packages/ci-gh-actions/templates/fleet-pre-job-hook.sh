#!/usr/bin/env bash
set -euo pipefail

node <<'NODE'
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const readReceipt = async (response) => {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing receipt");
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16384) {
      await reader.cancel();
      throw new Error("Receipt too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
};

const authorize = async () => {
  const url = new URL(required("HOBO_START_FENCE_URL"));
  if (
    url.protocol !== "https:" ||
    url.username || url.password || url.search || url.hash
  ) {
    throw new Error("Invalid start-fence URL");
  }
  const timeoutSeconds = Number(
    process.env.HOBO_START_FENCE_TIMEOUT_SEC ?? "30",
  );
  if (
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0 || timeoutSeconds > 60
  ) {
    throw new Error("Invalid start-fence timeout");
  }
  const executionKey = JSON.parse(required("HOBO_EXECUTION_KEY_JSON"));
  const job = executionKey?.githubJob;
  const runId = required("GITHUB_RUN_ID");
  const runAttempt = Number(required("GITHUB_RUN_ATTEMPT"));
  const identityFields = [
    "accountId", "engineId", "installationId", "repositoryId", "runId", "jobId",
  ];
  if (
    !job || job.kind !== "github-job" ||
    !identityFields.every((field) => typeof job[field] === "string" && job[field].length > 0) ||
    !Number.isSafeInteger(runAttempt) || runAttempt < 1 ||
    job.runId !== runId || job.runAttempt !== runAttempt
  ) {
    throw new Error("Runner job does not match the execution key");
  }
  required("GITHUB_REPOSITORY");
  required("GITHUB_JOB");
  const payload = {
    slotId: required("HOBO_SLOT_ID"),
    claimId: required("HOBO_CLAIM_ID"),
    bindingSecret: required("HOBO_BINDING_SECRET"),
    accountId: required("HOBO_ACCOUNT_ID"),
    runnerName: required("RUNNER_NAME"),
    profileId: required("HOBO_PROFILE_ID"),
    executionKey,
  };
  if (
    job.accountId !== payload.accountId ||
    payload.runnerName !== `hobo-${payload.slotId}`
  ) {
    throw new Error("Runner identity does not match the execution key");
  }
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(Math.ceil(timeoutSeconds * 1000)),
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
    body: JSON.stringify(payload),
  });
  const contentType = response.headers.get("content-type")?.split(";")[0]
    .trim().toLowerCase();
  if (response.status !== 200 || contentType !== "application/json") {
    throw new Error("Start fence did not authorize the job");
  }
  const receipt = await readReceipt(response);
  const actual = receipt?.executionKey?.githubJob;
  const fields = ["kind", ...identityFields, "runAttempt"];
  if (
    receipt?.authorized !== true || receipt.slotId !== payload.slotId ||
    receipt.claimId !== payload.claimId || receipt.runnerName !== payload.runnerName ||
    !actual || !fields.every((field) => actual[field] === job[field])
  ) {
    throw new Error("Start-fence receipt does not match the job");
  }
};

authorize().catch(() => {
  process.stderr.write("Start-fence authorization failed\n");
  process.exitCode = 43;
});
NODE
