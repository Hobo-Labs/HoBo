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
  const runId = required("GITHUB_RUN_ID");
  const runAttempt = Number(required("GITHUB_RUN_ATTEMPT"));
  const repository = required("GITHUB_REPOSITORY");
  required("GITHUB_JOB");
  const identityFields = [
    "accountId", "engineId", "installationId", "repositoryId", "runId", "jobId",
  ];
  if (!/^[1-9]\d*$/.test(runId) || !Number.isSafeInteger(Number(runId)) ||
      !Number.isSafeInteger(runAttempt) || runAttempt < 1) throw new Error("Invalid runner context");
  const payload = {
    slotId: required("HOBO_SLOT_ID"),
    bindingSecret: required("HOBO_BINDING_SECRET"),
    accountId: required("HOBO_ACCOUNT_ID"),
    runnerName: required("RUNNER_NAME"),
    profileId: required("HOBO_PROFILE_ID"),
  };
  if (payload.runnerName !== `hobo-${payload.slotId}`) throw new Error("Runner identity mismatch");
  const encodedKey = process.env.HOBO_EXECUTION_KEY_JSON;
  let job;
  if (encodedKey) {
    payload.executionKey = JSON.parse(encodedKey);
    job = payload.executionKey?.githubJob;
    payload.claimId = required("HOBO_CLAIM_ID");
    if (!job || job.kind !== "github-job" || job.accountId !== payload.accountId ||
        !identityFields.every((field) => typeof job[field] === "string" && job[field].length > 0) ||
        job.runId !== runId || job.runAttempt !== runAttempt) {
      throw new Error("Runner job does not match the execution key");
    }
  } else {
    const repositoryId = required("GITHUB_REPOSITORY_ID");
    if (!/^[1-9]\d*$/.test(repositoryId) || !Number.isSafeInteger(Number(repositoryId))) {
      throw new Error("Invalid repository identity");
    }
    payload.githubContext = { repository, repositoryId, runId, runAttempt };
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
  const validJob = actual && actual.kind === "github-job" &&
    identityFields.every((field) => typeof actual[field] === "string" && actual[field].length > 0);
  const matchesJob = job
    ? ["kind", ...identityFields, "runAttempt"].every((field) => actual?.[field] === job[field]) &&
      receipt?.claimId === payload.claimId
    : validJob && actual.accountId === payload.accountId &&
      actual.repositoryId === payload.githubContext.repositoryId &&
      actual.runId === runId && actual.runAttempt === runAttempt &&
      /^[1-9]\d*$/.test(actual.jobId) && /^github-[a-f0-9]{64}$/.test(receipt?.claimId ?? "");
  if (
    receipt?.authorized !== true || receipt.slotId !== payload.slotId ||
    receipt.runnerName !== payload.runnerName || !validJob || !matchesJob
  ) {
    throw new Error("Start-fence receipt does not match the job");
  }
};

authorize().catch(() => {
  process.stderr.write("Start-fence authorization failed\n");
  process.exitCode = 43;
});
NODE
