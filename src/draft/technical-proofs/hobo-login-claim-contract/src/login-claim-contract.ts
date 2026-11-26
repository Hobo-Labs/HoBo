import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";

import {
  createIdentityEvent,
  validateIdentityEvent,
} from "../../identity-event-contract/src/identity-event-contract.js";
import { parseJwtSvidCompact } from "../../hobo-jwt-svid-contract/src/jwt-svid.js";

const CREDENTIAL_NAME = "hobo.dev-svid";
const DEFAULT_LOGIN_TTL_MS = 15 * 60 * 1000;
const DEFAULT_SUBJECT = "spiffe://yard/acme/agent/dev-cli";
const PROJECT_MARKERS = ["hobo.bindle.json", "bindle.ts", "bindle.js", ".hobo"];

export function createInMemoryCredentialStore({ kind = "os-keychain", mode = null } = {}) {
  const records = new Map();
  const writes = [];

  return Object.freeze({
    kind,
    mode,
    async write(name, credential) {
      const stored = clone(credential);
      records.set(name, stored);
      writes.push({ name, storage: stored.storage, kind: stored.kind });
    },
    async read(name) {
      return records.has(name) ? clone(records.get(name)) : null;
    },
    async delete(name) {
      records.delete(name);
    },
    audit() {
      return clone({ writes });
    },
  });
}

export function createFileCredentialStore({ mode }) {
  if ((mode & 0o077) !== 0) {
    throw new Error("credential file mode must not be readable by group or world");
  }
  return createInMemoryCredentialStore({ kind: "file", mode });
}

export function createDeploymentRegistry(initialDeployments = []) {
  const deployments = new Map(
    initialDeployments.map((deployment) => [deployment.id, clone(deployment)]),
  );

  return Object.freeze({
    get(id) {
      return deployments.has(id) ? clone(deployments.get(id)) : null;
    },
    claim(id, owner) {
      const deployment = deployments.get(id);
      if (!deployment) {
        return { ok: false, code: "HOBO_CLAIM_NOT_FOUND", message: `Deployment ${id} was not found.` };
      }

      if (deployment.owner && deployment.owner.subject !== owner.subject) {
        return {
          ok: false,
          code: "HOBO_CLAIM_OWNED",
          message: `Deployment ${id} is already claimed by another account.`,
        };
      }

      deployment.owner = clone(owner);
      deployments.set(id, deployment);
      return { ok: true, deployment: clone(deployment) };
    },
  });
}

export function createLoginClaimCommands(options) {
  const issuer = requireIssuer(options.issuer);
  const credentialStore = requireCredentialStore(options.credentialStore);
  const deployments = options.deployments ?? createDeploymentRegistry();
  const now = options.now ?? (() => new Date());
  const loginTtlMs = options.loginTtlMs ?? DEFAULT_LOGIN_TTL_MS;
  const authorize = options.authorize ?? defaultAuthorize;
  const eventSink = options.eventSink ?? (() => {});

  async function login() {
    try {
      const grant = await authorize();
      const issuedAt = now();
      const expiresAt = new Date(issuedAt.getTime() + loginTtlMs);
      const subject = grant.subject ?? DEFAULT_SUBJECT;
      const tenant = grant.tenant ?? "acme";
      const parentPrincipal = grant.parentPrincipal ?? { kind: "user", id: "dev" };
      const scope = grant.scope ?? [
        { port: "hobo:deploy/deployment", resource: "anonymous-preview", verbs: ["claim"] },
      ];
      const claims = {
        sub: subject,
        aud: "hobo-cli",
        iat: Math.floor(issuedAt.getTime() / 1000),
        nbf: Math.floor(issuedAt.getTime() / 1000),
        exp: Math.floor(expiresAt.getTime() / 1000),
        tenant,
        parentPrincipal,
        codeVersion: {
          digest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
        scope,
      };
      const token = await issuer.signJwtSvid(claims);
      parseJwtSvidCompact(token, { now: Math.floor(issuedAt.getTime() / 1000) });

      const credential = {
        kind: "jwt-svid",
        storage: credentialStore.kind,
        svidRef: `${credentialStore.kind === "os-keychain" ? "keychain" : "file"}://${CREDENTIAL_NAME}`,
        token,
        expiresAt: expiresAt.toISOString(),
      };
      await credentialStore.write(CREDENTIAL_NAME, credential);
      emit(eventSink, createIssuedEvent({ subject, tenant, credential, claims, now: issuedAt }));

      return {
        ok: true,
        status: "authenticated",
        code: "HOBO_LOGIN_OK",
        message: "Dev SVID stored in OS credential store.",
        data: {
          credential: publicCredentialSummary(credential),
          identity: {
            subject,
            tenant,
            svidRef: credential.svidRef,
            expiresAt: credential.expiresAt,
          },
        },
      };
    } catch (error) {
      await credentialStore.delete(CREDENTIAL_NAME);
      return {
        ok: false,
        status: "login_interrupted",
        code: "HOBO_LOGIN_INTERRUPTED",
        message: `${error.message}. No credential was written.`,
        data: {},
      };
    }
  }

  async function claim({ args }) {
    const deploymentId = args?.[0];
    if (!deploymentId) {
      return {
        ok: false,
        status: "usage_error",
        code: "HOBO_CLAIM_USAGE",
        message: "Usage: hobo claim <deployment>",
        data: {},
      };
    }

    const identity = await readCurrentIdentity({ credentialStore, now, required: true });
    const claim = deployments.claim(deploymentId, {
      subject: identity.subject,
      tenant: identity.tenant,
      svidRef: identity.svidRef,
    });
    if (!claim.ok) {
      return { ...claim, status: "claim_denied", data: {} };
    }

    emit(eventSink, createDeploymentClaimedEvent({
      deployment: claim.deployment,
      identity,
      now: now(),
    }));

    return {
      ok: true,
      status: "claimed",
      code: "HOBO_CLAIM_OK",
      message: `Deployment ${deploymentId} claimed.`,
      data: { deployment: claim.deployment },
    };
  }

  async function logout() {
    await credentialStore.delete(CREDENTIAL_NAME);
    return {
      ok: true,
      status: "logged_out",
      code: "HOBO_LOGOUT_OK",
      message: "Local HoBo credential removed.",
      data: {},
    };
  }

  async function contextFactory(request) {
    const projectDir = await findProjectDir(request.cwd);
    if (request.requiresProject && !projectDir) {
      throw new Error(`No Bindle here: ${request.cwd}`);
    }

    const identity = request.verb === "login"
      ? null
      : await readCurrentIdentity({
          credentialStore,
          now,
          required: !["login"].includes(request.verb),
        });

    return {
      cwd: request.cwd,
      projectDir,
      identity,
      clients: {
        readApi: "stub",
        runtime: "stub",
      },
    };
  }

  return Object.freeze({
    login: { run: login },
    claim: { run: claim },
    logout: { run: logout },
    contextFactory,
    currentIdentity() {
      return readCurrentIdentity({ credentialStore, now, required: true });
    },
  });
}

export function createAuthSessionCli(commands) {
  return Object.freeze({
    async run(argv) {
      const json = argv.includes("--json");
      const verb = argv.find((token) => !token.startsWith("-"));
      if (verb !== "logout") {
        return { exitCode: 2, stdout: "", stderr: "Usage: hobo logout\n" };
      }
      const result = await commands.logout.run({ args: [], flags: { json } });
      return {
        exitCode: result.ok === false ? 1 : 0,
        stdout: json ? `${JSON.stringify(result)}\n` : `${result.message}\n`,
        stderr: "",
      };
    },
  });
}

async function readCurrentIdentity({ credentialStore, now, required }) {
  const credential = await credentialStore.read(CREDENTIAL_NAME);
  if (!credential) {
    if (!required) {
      return null;
    }
    throw new Error('No HoBo dev SVID is available. Run "hobo login" and retry.');
  }

  let parsed;
  try {
    parsed = parseJwtSvidCompact(credential.token, {
      now: Math.floor(now().getTime() / 1000),
    });
  } catch (error) {
    await credentialStore.delete(CREDENTIAL_NAME);
    if (/expired/.test(error.message)) {
      throw new Error('SVID expired. Run "hobo login" and retry.');
    }
    throw new Error(`Stored SVID is invalid. Run "hobo login" and retry.`);
  }

  return {
    subject: parsed.claims.sub,
    tenant: parsed.claims.tenant,
    svidRef: credential.svidRef,
    expiresAt: new Date(parsed.claims.exp * 1000).toISOString(),
    storage: credential.storage,
  };
}

function createIssuedEvent({ subject: _subject, tenant, credential, claims, now }) {
  const event = createIdentityEvent(
    "identity.Issued",
    {
      identityId: `dev-svid-${tenant}`,
      subject: {
        kind: "agent",
        id: "agent:dev-cli",
        delegatedBy: claims.parentPrincipal,
      },
      svidRef: credential.svidRef,
      scope: claims.scope.map((entry) => ({
        port: entry.port,
        resource: entry.resource,
        actions: entry.verbs,
      })),
      expiresAt: credential.expiresAt,
    },
    {
      id: "evt-dev-svid-issued",
      tenant,
      actor: { kind: "user", id: "user:dev" },
      time: now.toISOString(),
      correlationId: "login-dev-svid",
      causationId: "cmd-hobo-login",
    },
  );
  const validation = validateIdentityEvent(event);
  if (!validation.ok) {
    throw new Error(`invalid identity.Issued event: ${validation.errors.join("; ")}`);
  }
  return event;
}

function createDeploymentClaimedEvent({ deployment, identity, now }) {
  return deepFreeze({
    id: `evt-${deployment.id}-claimed`,
    type: "deployment.Claimed",
    schemaVersion: "hobo.login-claim/v1",
    time: now.toISOString(),
    tenant: identity.tenant,
    actor: {
      kind: "agent",
      id: identity.subject,
    },
    data: {
      deploymentId: deployment.id,
      url: deployment.url,
      stateDigest: stableDigest(deployment.state),
      owner: {
        subject: identity.subject,
        svidRef: identity.svidRef,
      },
    },
  });
}

function publicCredentialSummary(credential) {
  return {
    kind: credential.kind,
    storage: credential.storage,
    svidRef: credential.svidRef,
    expiresAt: credential.expiresAt,
    containsStaticCloudKey: false,
  };
}

function defaultAuthorize() {
  return {};
}

function requireIssuer(issuer) {
  if (!issuer || !isFunction(issuer.signJwtSvid)) {
    throw new Error("login contract requires a Yard Identity issuer");
  }
  return issuer;
}

function requireCredentialStore(store) {
  if (!store || !isFunction(store.write) || !isFunction(store.read)) {
    throw new Error("login contract requires a credential store");
  }
  return store;
}

async function findProjectDir(startDir) {
  if (!startDir) {
    return null;
  }
  let current = path.resolve(startDir);
  while (true) {
    for (const marker of PROJECT_MARKERS) {
      if (await exists(path.join(current, marker))) {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function emit(eventSink, event) {
  eventSink(event);
}

function stableDigest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex")}`;
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}

function isPlainObject(value) {
  return (
    value !== null &&
    Object.prototype.toString.call(value) === "[object Object]" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!isObjectLike(value) || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function isFunction(value) {
  return ["[object Function]", "[object AsyncFunction]", "[object GeneratorFunction]"].includes(
    Object.prototype.toString.call(value),
  );
}

function isObjectLike(value) {
  return value !== null && (Array.isArray(value) || Object.prototype.toString.call(value) === "[object Object]");
}
