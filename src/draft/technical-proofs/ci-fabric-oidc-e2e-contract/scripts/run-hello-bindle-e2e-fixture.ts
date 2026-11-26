#!/usr/bin/env node
import {
  createHoboCiFabricContract,
  simulateHelloBindleE2e,
} from "../src/ci-fabric-contract.js";

const args = parseArgs(process.argv.slice(2));
const phase = args.phase ?? "deploy-and-assert";
const runId = args["run-id"] ?? process.env.GITHUB_RUN_ID ?? "local-run";

if (process.env.GITHUB_ACTIONS === "true") {
  assertGitHubOidcEnvironment();
}

if (phase === "deploy-and-assert") {
  const run = simulateHelloBindleE2e(createHoboCiFabricContract(), {
    githubRunId: runId,
  });
  console.log(JSON.stringify(run, null, 2));
} else if (phase === "teardown") {
  console.log(JSON.stringify({ ok: true, phase, fixture: "examples/hello-bindle", runId }, null, 2));
} else if (phase === "sweep-orphans") {
  console.log(
    JSON.stringify(
      {
        ok: true,
        phase,
        selector: "hobo.dev/fixture=hello-bindle",
        maxAgeMinutes: 60,
      },
      null,
      2,
    ),
  );
} else {
  console.error(`unknown phase: ${phase}`);
  process.exitCode = 1;
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
