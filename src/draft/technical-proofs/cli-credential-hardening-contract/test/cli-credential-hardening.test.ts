import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createCliCredentialHardeningHarness,
  redactCredentialMaterial
} from "../src/cli-credential-hardening.js";

const jwtSvid = "eyJhbGciOiJSUzI1NiJ9.svid-secret-signature";
const brokerToken = "provider-token-secret-abc123";
const staticKey = "AKIASTATICCLOUDKEY";

test("login stores the SVID only in the OS secret store and never in argv or plaintext files", () => {
  const harness = createCliCredentialHardeningHarness();

  const result = harness.loginWithSvid({
    principal: "spiffe://acme.yard/acme/dev/alice",
    jwtSvid,
    ttlSeconds: 900
  });

  assert.equal(result.status, "stored");
  assert.equal(result.storage.kind, "os-secret-store");
  assert.equal(result.storage.worldReadable, false);
  assert.deepEqual(result.plaintextCredentialFiles, []);
  assert.deepEqual(result.shellHistoryVisibleArgs, []);
  assert.equal(JSON.stringify(result).includes(jwtSvid), false);
});

test("verbose, crash, json, and child-process env output are scrubbed of secret material", () => {
  const harness = createCliCredentialHardeningHarness();
  harness.loginWithSvid({
    principal: "spiffe://acme.yard/acme/agent/ops",
    jwtSvid,
    ttlSeconds: 900
  });

  const rendered = harness.renderFailureReport({
    command: "hobo up --verbose --json",
    error: new Error(`provider rejected ${brokerToken}`),
    env: {
      HOBO_TOKEN: brokerToken,
      AWS_SESSION_TOKEN: brokerToken,
      SAFE_VALUE: "region-us"
    },
    json: {
      credential: brokerToken,
      nested: { token: jwtSvid },
      safe: "plan denied"
    }
  });

  assert.equal(rendered.verbose.includes(brokerToken), false);
  assert.equal(rendered.crashDump.includes(jwtSvid), false);
  assert.equal(rendered.childProcessEnv.includes(brokerToken), false);
  assert.equal(JSON.stringify(rendered.json).includes(jwtSvid), false);
  assert.equal(rendered.json.credential, "<redacted:credential>");
  assert.equal(rendered.json.nested.token, "<redacted:token>");
  assert.match(rendered.verbose, /<redacted:credential>/);
});

test("revoked SVID stops a running command before mutation and audits the denial", () => {
  const harness = createCliCredentialHardeningHarness();
  const session = harness.loginWithSvid({
    principal: "spiffe://acme.yard/acme/dev/alice",
    jwtSvid,
    ttlSeconds: 900
  });

  harness.revokeSvid(session.credentialRef, "user-logout");
  const result = harness.runCredentialedCommand({
    credentialRef: session.credentialRef,
    command: "hobo up",
    mutates: true
  });

  assert.equal(result.status, "denied");
  assert.equal(result.reason, "svid-revoked");
  assert.equal(result.mutationApplied, false);
  assert.deepEqual(harness.auditEvents().map((event) => event.type), [
    "identity.Issued",
    "token.Revoked",
    "token.Denied"
  ]);
});

test("static cloud keys are rejected and hobo doctor reports the insecure state", () => {
  const harness = createCliCredentialHardeningHarness();

  const result = harness.acceptCredential({
    source: "env",
    type: "aws-static-access-key",
    value: staticKey
  });

  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "static-cloud-key-not-accepted");
  assert.deepEqual(result.storedRefs, []);
  assert.deepEqual(harness.doctor().findings, [
    {
      severity: "error",
      code: "static-cloud-key-present",
      message: "Static cloud keys are refused; use brokered short-lived SVID credentials."
    }
  ]);
});

test("CI dry-run uses OIDC and leaves zero persisted secrets", () => {
  const harness = createCliCredentialHardeningHarness();

  const result = harness.runCiDryRun({
    oidcAssertion: "github-actions-oidc-assertion",
    brokeredToken: brokerToken,
    command: "hobo plan --camp staging"
  });

  assert.equal(result.status, "planned");
  assert.equal(result.persistedSecrets.length, 0);
  assert.equal(result.storedCredentials.length, 0);
  assert.deepEqual(result.audit.map((event) => event.type), [
    "token.Granted",
    "token.Used",
    "token.Revoked"
  ]);
  assert.equal(JSON.stringify(result).includes(brokerToken), false);
});

test("stale plaintext credentials and rogue HOBO issuer env fail closed", () => {
  const harness = createCliCredentialHardeningHarness({
    trustedIssuer: "https://identity.acme.yard"
  });

  const result = harness.loadLegacyCredentialState({
    files: [{ path: ".hobo/credential.json", contents: jwtSvid, mode: "0644" }],
    env: { HOBO_ISSUER_URL: "https://evil.example" }
  });

  assert.equal(result.status, "denied");
  assert.deepEqual(result.reasons, [
    "legacy-plaintext-credential",
    "untrusted-hobo-issuer-env"
  ]);
  assert.equal(result.trusted, false);
});

test("concurrent commands share the secret-store ref without duplicating or leaking credentials", () => {
  const harness = createCliCredentialHardeningHarness();
  const session = harness.loginWithSvid({
    principal: "spiffe://acme.yard/acme/dev/alice",
    jwtSvid,
    ttlSeconds: 900
  });

  const result = harness.runConcurrentCredentialedCommands({
    credentialRef: session.credentialRef,
    commands: ["hobo plan", "hobo up"]
  });

  assert.equal(result.status, "serialized");
  assert.deepEqual(result.results.map((command) => command.status), ["succeeded", "succeeded"]);
  assert.equal(result.secretStoreWrites, 1);
  assert.deepEqual(result.leakedCredentials, []);
  assert.equal(JSON.stringify(result).includes(jwtSvid), false);
});

test("redaction helper recursively replaces credential-shaped fields without mutating safe fields", () => {
  const output = redactCredentialMaterial({
    token: brokerToken,
    authorization: `Bearer ${brokerToken}`,
    safe: "region-us",
    nested: [{ svid: jwtSvid }]
  });

  assert.deepEqual(output, {
    token: "<redacted:token>",
    authorization: "<redacted:authorization>",
    safe: "region-us",
    nested: [{ svid: "<redacted:svid>" }]
  });
});
