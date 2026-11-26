import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "vitest";

import {
  AUTH_JSON_SCHEMA_ID,
  ID_JAG_DRAFT_VERSION,
  buildSignedAuthManifestEnvelope,
  parseAuthJson,
  parseResourceIndicators,
  selectPreferredAuthFlow,
  verifySignedAuthManifestEnvelope,
} from "../src/auth-json.js";

function docAuthJson(overrides = {}) {
  return {
    issuer: "https://acme-cloud.example.com",
    flows: [
      {
        type: "oidc-federation",
        audience: "hobo",
        exchange: "sts:AssumeRoleWithWebIdentity",
        trust: {
          oidcDiscovery: "https://yard.example.com/.well-known/openid-configuration",
        },
      },
      {
        type: "oauth2-obo",
        authorizationServer: "https://acme.example.com/oauth",
        scopes: ["db:write", "compute:deploy", "objstore:rw"],
      },
      {
        type: "oauth2-xaa",
        idJag: true,
        idJagDraftVersion: ID_JAG_DRAFT_VERSION,
        authorizationServer: "https://acme.example.com/oauth",
        audience: "urn:acme:app",
        scopes: ["tasks:read", "tasks:write"],
      },
      {
        type: "device-code",
        authorizationServer: "https://acme.example.com/device",
      },
      {
        type: "api-key",
        header: "X-Api-Key",
        rotation: "manual",
      },
    ],
    scopeModel: "least-privilege-per-resource",
    resourceIndicators: ["urn:acme:db", "urn:acme:compute", "urn:acme:objstore"],
    tokenLifetimeSec: 3600,
    audit: {
      events: ["token.Granted", "token.Used", "token.Revoked"],
    },
    ...overrides,
  };
}

describe("auth.json flow contract", () => {
  it("publishes a versioned schema and validates the documented auth.json shape", async () => {
    const schemaPath = join(import.meta.dirname, "..", "schema", "auth-json.v1.schema.json");
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));

    assert.equal(schema.$id, AUTH_JSON_SCHEMA_ID);
    assert.equal(schema.properties.issuer.$ref, "#/$defs/httpsUrl");
    assert.equal(
      schema.$defs.oidcFederationFlow.properties.trust.properties.oidcDiscovery.$ref,
      "#/$defs/httpsUrl",
    );
    assert.equal(
      schema.$defs.oauth2XaaFlow.properties.idJagDraftVersion.const,
      ID_JAG_DRAFT_VERSION,
    );
    assert.deepEqual(schema.properties.audit.properties.events.allOf, [
      { contains: { const: "token.Granted" } },
      { contains: { const: "token.Used" } },
    ]);
    assert.deepEqual(schema.required, [
      "issuer",
      "flows",
      "scopeModel",
      "resourceIndicators",
      "tokenLifetimeSec",
      "audit",
    ]);

    const manifest = parseAuthJson(docAuthJson(), {
      trustedOidcDiscoveryHost: "yard.example.com",
    });

    assert.equal(manifest.issuer, "https://acme-cloud.example.com");
    assert.equal(manifest.flows.length, 5);
    assert.deepEqual(parseResourceIndicators(manifest.resourceIndicators), [
      { raw: "urn:acme:db", scheme: "urn", namespace: "acme", resource: "db" },
      { raw: "urn:acme:compute", scheme: "urn", namespace: "acme", resource: "compute" },
      { raw: "urn:acme:objstore", scheme: "urn", namespace: "acme", resource: "objstore" },
    ]);
  });

  it("selects keyless flows before static secrets and flags api-key as last resort", () => {
    const manifest = parseAuthJson(docAuthJson(), {
      trustedOidcDiscoveryHost: "yard.example.com",
    });

    const preferred = selectPreferredAuthFlow(manifest);

    assert.equal(preferred.flow.type, "oidc-federation");
    assert.equal(preferred.flow.audience, "hobo");
    assert.deepEqual(preferred.warnings, []);

    const staticOnly = parseAuthJson(
      docAuthJson({
        flows: [{ type: "api-key", header: "X-Api-Key", rotation: "manual" }],
      }),
    );

    const fallback = selectPreferredAuthFlow(staticOnly);

    assert.equal(fallback.flow.type, "api-key");
    assert.deepEqual(fallback.warnings, ["last-resort-static-secret"]);
  });

  it("rejects unsigned, wrong-issuer, and tampered manifest entries", () => {
    const envelope = buildSignedAuthManifestEnvelope(docAuthJson(), {
      keyId: "provider-key-1",
      issuer: "https://acme-cloud.example.com",
    });

    assert.equal(
      verifySignedAuthManifestEnvelope(envelope, {
        trustedIssuer: "https://acme-cloud.example.com",
      }).auth.issuer,
      "https://acme-cloud.example.com",
    );

    assert.throws(
      () =>
        verifySignedAuthManifestEnvelope(
          { auth: docAuthJson() },
          { trustedIssuer: "https://acme-cloud.example.com" },
        ),
      /unsigned/i,
    );

    assert.throws(
      () =>
        verifySignedAuthManifestEnvelope(envelope, {
          trustedIssuer: "https://evil.example.com",
        }),
      /issuer/i,
    );

    const tampered = structuredClone(envelope);
    tampered.auth.flows[1].scopes.push("admin");

    assert.throws(
      () =>
        verifySignedAuthManifestEnvelope(tampered, {
          trustedIssuer: "https://acme-cloud.example.com",
        }),
      /signature/i,
    );

    const extraFieldTamper = structuredClone(envelope);
    extraFieldTamper.auth.flows[0].trust.untrustedKey = "https://evil.example.com";

    assert.throws(
      () =>
        verifySignedAuthManifestEnvelope(extraFieldTamper, {
          trustedIssuer: "https://acme-cloud.example.com",
        }),
      /unexpected property 'untrustedKey'/i,
    );
  });

  it("pins the ID-JAG draft and prefers oauth2-xaa before oauth2-obo", () => {
    const manifest = parseAuthJson(
      docAuthJson({
        flows: [
          {
            type: "oauth2-obo",
            authorizationServer: "https://acme.example.com/oauth",
            scopes: ["tasks:read", "tasks:write"],
          },
          {
            type: "oauth2-xaa",
            idJag: true,
            idJagDraftVersion: ID_JAG_DRAFT_VERSION,
            authorizationServer: "https://acme.example.com/oauth",
            audience: "urn:acme:app",
            scopes: ["tasks:read"],
          },
        ],
      }),
    );

    const xaaFlow = selectPreferredAuthFlow(manifest).flow;

    assert.equal(ID_JAG_DRAFT_VERSION, "draft-ietf-oauth-identity-assertion-authz-grant-04");
    assert.equal(xaaFlow.type, "oauth2-xaa");
    assert.equal(xaaFlow.idJagDraftVersion, ID_JAG_DRAFT_VERSION);
  });

  it("rejects unsafe declarations and duplicate/conflicting flow entries", () => {
    assert.throws(
      () =>
        parseAuthJson(docAuthJson(), {
          trustedOidcDiscoveryHost: "identity.attacker.example",
        }),
      /oidcDiscovery/i,
    );

    assert.throws(
      () =>
        parseAuthJson(
          docAuthJson({
            issuer: "urn:acme:issuer",
          }),
        ),
      /issuer.*https/i,
    );

    assert.throws(
      () =>
        parseAuthJson(
          docAuthJson({
            flows: [
              {
                type: "oauth2-xaa",
                idJag: false,
                idJagDraftVersion: ID_JAG_DRAFT_VERSION,
                authorizationServer: "https://acme.example.com/oauth",
                audience: "urn:acme:app",
                scopes: ["tasks:read"],
              },
            ],
          }),
        ),
      /idJag/i,
    );

    assert.throws(
      () =>
        parseAuthJson(
          docAuthJson({
            flows: [
              {
                type: "oauth2-obo",
                authorizationServer: "https://z.example.com/oauth",
                scopes: ["tasks:read"],
              },
              {
                type: "oauth2-obo",
                authorizationServer: "https://a.example.com/oauth",
                scopes: ["tasks:read"],
              },
            ],
          }),
        ),
      /duplicate auth flow type 'oauth2-obo'/i,
    );
  });
});
