#!/usr/bin/env node
import { runMultiCloudShopE2eFixture } from "../src/multi-cloud-shop-gate.js";

const args = parseArgs(process.argv.slice(2));
const phase = args.phase ?? "deploy-and-assert";
const runId = args["run-id"] ?? process.env.GITHUB_RUN_ID ?? "local-run";

if (process.env.GITHUB_ACTIONS === "true") {
  assertGitHubOidcEnvironment();
}

const result = runMultiCloudShopE2eFixture({ phase, runId });
console.log(JSON.stringify(result, null, 2));

if (!result.ok) {
  process.exitCode = 1;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function assertGitHubOidcEnvironment() {
  const missing = ["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"].filter(
    (name) => !process.env[name],
  );
  if (missing.length > 0) {
    throw new Error(`GitHub OIDC token environment missing: ${missing.join(", ")}`);
  }

  const storedSecretKeys = Object.keys(process.env)
    .filter((key) => /SECRET|ACCESS_KEY|PRIVATE_KEY/i.test(key))
    .filter((key) => key !== "ACTIONS_ID_TOKEN_REQUEST_TOKEN")
    .sort();
  if (storedSecretKeys.length > 0) {
    throw new Error(`stored cloud secret environment is not allowed: ${storedSecretKeys.join(", ")}`);
  }
}
