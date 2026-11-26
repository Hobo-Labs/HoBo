import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";

import { createHoboCli } from "../../hobo-cli-shell-contract/src/cli-shell.js";
import {
  bootstrapIdentityIssuer,
  createInMemoryKms,
  verifyJwtWithJwks,
} from "../../yard-identity-issuer-contract/src/issuer.js";
import {
  createAuthSessionCli,
  createDeploymentRegistry,
  createFileCredentialStore,
  createInMemoryCredentialStore,
  createLoginClaimCommands,
} from "../src/login-claim-contract.js";

const NOW = new Date("2026-06-26T03:00:00.000Z");

test("hobo login stores a usable dev SVID in the OS credential store and later commands present it", async () => {
  const fixture = createFixture();
  const projectDir = await createProjectDir();
  const cli = createHoboCli({
    commands: {
      login: fixture.commands.login,
      plan: {
        async run({ context }) {
          return {
            ok: true,
            status: "planned",
            data: {
              identity: context.identity,
            },
          };
        },
      },
    },
    contextFactory: fixture.commands.contextFactory,
  });

  const login = await cli.run(["login", "--json"], { cwd: projectDir });

  assert.equal(login.exitCode, 0);
  const loginJson = JSON.parse(login.stdout);
  assert.equal(loginJson.data.credential.storage, "os-keychain");
  assert.equal(loginJson.data.credential.containsStaticCloudKey, false);
  assert.equal(loginJson.data.credential.token, undefined);

  const stored = await fixture.credentialStore.read("hobo.dev-svid");
  assert.equal(stored.storage, "os-keychain");
  assert.equal(stored.kind, "jwt-svid");
  const verified = await verifyJwtWithJwks(stored.token, fixture.issuer.jwks(), {
    issuer: fixture.issuer.issuerUrl,
    audience: "hobo-cli",
    now: Math.floor(NOW.getTime() / 1000),
  });
  assert.equal(verified.claims.sub, "spiffe://yard/acme/agent/dev-cli");

  const plan = await cli.run(["plan", "--json"], { cwd: projectDir });
  assert.equal(plan.exitCode, 0);
  const planJson = JSON.parse(plan.stdout);
  assert.equal(planJson.data.identity.subject, "spiffe://yard/acme/agent/dev-cli");
  assert.equal(planJson.data.identity.svidRef, "keychain://hobo.dev-svid");
});

test("hobo claim binds an anonymous deployment without changing its URL or state and emits audit evidence", async () => {
  const fixture = createFixture({
    deployments: [
      {
        id: "deploy-anon",
        url: "https://snapshop.preview.hobo.test",
        state: { revision: "rev-7", resources: ["web", "db"] },
        owner: null,
      },
    ],
  });
  const projectDir = await createProjectDir();
  const cli = createHoboCli({
    commands: {
      login: fixture.commands.login,
      claim: fixture.commands.claim,
    },
    contextFactory: fixture.commands.contextFactory,
  });

  assert.equal((await cli.run(["login", "--json"], { cwd: projectDir })).exitCode, 0);
  const claim = await cli.run(["claim", "deploy-anon", "--json"], { cwd: projectDir });

  assert.equal(claim.exitCode, 0);
  const claimJson = JSON.parse(claim.stdout);
  assert.equal(claimJson.data.deployment.url, "https://snapshop.preview.hobo.test");
  assert.deepEqual(claimJson.data.deployment.state, { revision: "rev-7", resources: ["web", "db"] });
  assert.equal(claimJson.data.deployment.owner.subject, "spiffe://yard/acme/agent/dev-cli");
  const claimEvent = fixture.events.find((event) => event.type === "deployment.Claimed");
  assert.match(claimEvent.data.stateDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(claimEvent.data.stateDigest.includes("rev-7"), false);
  assert.equal(JSON.stringify(fixture.events).includes("eyJ"), false);
});

test("expired or logged-out SVIDs force re-login instead of falling back to stale credentials", async () => {
  const fixture = createFixture();
  const auth = createAuthSessionCli(fixture.commands);
  const projectDir = await createProjectDir();
  const cli = createHoboCli({
    commands: {
      login: fixture.commands.login,
      plan: {
        async run({ context }) {
          return { ok: true, status: "planned", data: { identity: context.identity } };
        },
      },
    },
    contextFactory: fixture.commands.contextFactory,
  });

  await cli.run(["login", "--json"], { cwd: projectDir });
  assert.equal((await auth.run(["logout", "--json"])).exitCode, 0);

  const afterLogout = await fixture.commands.contextFactory({
    cwd: projectDir,
    flags: {},
    verb: "plan",
    args: [],
    requiresProject: true,
  }).catch((error) => error);
  assert.match(afterLogout.message, /Run "hobo login"/);

  const expired = createFixture({ loginTtlMs: 1000 });
  await expired.commands.login.run({ args: [], flags: { json: true } });
  expired.setNow(new Date("2026-06-26T04:00:00.000Z"));
  const expiredContext = await expired.commands.contextFactory({
    cwd: projectDir,
    flags: {},
    verb: "plan",
    args: [],
    requiresProject: true,
  }).catch((error) => error);
  assert.match(expiredContext.message, /SVID expired.*Run "hobo login"/);
});

test("claim refuses another account's deployment", async () => {
  const fixture = createFixture({
    deployments: [
      {
        id: "deploy-owned",
        url: "https://owned.preview.hobo.test",
        state: { revision: "rev-owned" },
        owner: { subject: "spiffe://yard/acme/agent/other" },
      },
    ],
  });
  await fixture.commands.login.run({ args: [], flags: { json: true } });

  const result = await fixture.commands.claim.run({
    args: ["deploy-owned"],
    flags: { json: true },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "HOBO_CLAIM_OWNED");
  assert.equal(fixture.events.some((event) => event.type === "deployment.Claimed"), false);
});

test("credential files cannot be created world-readable", async () => {
  assert.throws(
    () => createFileCredentialStore({ mode: 0o644 }),
    /credential file mode must not be readable by group or world/,
  );
  assert.doesNotThrow(() => createFileCredentialStore({ mode: 0o600 }));
});

test("interrupted OIDC flow leaves no partial credential", async () => {
  const fixture = createFixture({
    authorize: async () => {
      throw new Error("OIDC flow interrupted");
    },
  });

  const result = await fixture.commands.login.run({ args: [], flags: { json: true } });

  assert.equal(result.ok, false);
  assert.equal(result.code, "HOBO_LOGIN_INTERRUPTED");
  assert.equal(await fixture.credentialStore.read("hobo.dev-svid"), null);
});

function createFixture(options = {}) {
  const kms = createInMemoryKms();
  const issuer = bootstrapIdentityIssuer({
    issuerUrl: "https://yard.example.test",
    kms,
    genesisKeyId: "genesis",
    seedCredential: { canGenerateGenesisKey: true },
  });
  const credentialStore = createInMemoryCredentialStore({ kind: "os-keychain" });
  const deployments = createDeploymentRegistry(options.deployments ?? []);
  const events = [];
  let nowDate = options.now ?? NOW;
  const commands = createLoginClaimCommands({
    issuer,
    credentialStore,
    deployments,
    now: () => nowDate,
    loginTtlMs: options.loginTtlMs,
    authorize: options.authorize,
    eventSink: (event) => events.push(event),
  });

  return {
    commands,
    credentialStore,
    deployments,
    events,
    issuer,
    setNow(value) {
      nowDate = value;
    },
  };
}

async function createProjectDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hobo-login-claim-"));
  await writeFile(path.join(dir, "hobo.bindle.json"), "{}");
  return dir;
}
