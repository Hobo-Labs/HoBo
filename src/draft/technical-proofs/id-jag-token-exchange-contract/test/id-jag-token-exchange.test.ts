import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "vitest";

import { ID_JAG_DRAFT_VERSION as AUTH_JSON_ID_JAG_DRAFT_VERSION } from "../../hobo-auth-json-contract/src/auth-json.js";
import {
  ID_JAG_DRAFT_VERSION,
  ID_JAG_GRANT_PROFILE,
  ID_JAG_SCHEMA_ID,
  ID_JAG_TOKEN_TYPE,
  buildIdJagTokenExchangeRequest,
  buildJwtBearerGrantRequest,
  createFixtureIdJag,
  parseIdJagTokenExchangeResponse,
  parseJwtBearerGrantRequest,
} from "../src/id-jag-token-exchange.js";

const NOW = 1_799_999_000;
const ASANA_AUDIENCE = "https://authorization.asana.example";
const SLACK_AUDIENCE = "https://authorization.slack.example";
const RESOURCE = "https://api.asana.example";
const SUBJECT_TOKEN = "user-id-token-fixture";
const SUBJECT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id_token";

function delegatedSubject(overrides = {}) {
  return {
    kind: "agent",
    id: "agent:triage-bot",
    delegatedBy: {
      kind: "user",
      id: "user:pat",
    },
    ...overrides,
  };
}

function stage1Response(overrides = {}) {
  const accessToken = createFixtureIdJag({
    issuer: "https://idp.example",
    subjectId: "user:pat",
    subject: delegatedSubject(),
    audience: ASANA_AUDIENCE,
    resource: RESOURCE,
    clientId: "https://hobo.example/agents/triage-bot",
    scopes: ["tasks:read", "tasks:write"],
    nonce: "nonce-stage-1",
    issuedAt: NOW - 60,
    expiresAt: NOW + 300,
    extraClaims: {
      sub_id: { format: "opaque", id: "external-user-123" },
      email: "pat@example.com",
      authorization_details: [
        {
          type: "external-app",
          actions: ["tasks:read"],
        },
      ],
    },
  });

  return {
    issued_token_type: ID_JAG_TOKEN_TYPE,
    access_token: accessToken,
    token_type: "N_A",
    scope: "tasks:read tasks:write",
    expires_in: 300,
    ...overrides,
  };
}

describe("ID-JAG token-exchange wire contract", () => {
  it("publishes schema constants and keeps the draft pin aligned with auth.json", async () => {
    const schemaPath = join(
      import.meta.dirname,
      "..",
      "schema",
      "id-jag-token-exchange.v1.schema.json",
    );
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));

    assert.equal(schema.$id, ID_JAG_SCHEMA_ID);
    assert.equal(ID_JAG_DRAFT_VERSION, "draft-ietf-oauth-identity-assertion-authz-grant-04");
    assert.equal(ID_JAG_DRAFT_VERSION, AUTH_JSON_ID_JAG_DRAFT_VERSION);
    assert.equal(schema.$defs.idJagTokenExchangeRequest.properties.grant_type.const, "urn:ietf:params:oauth:grant-type:token-exchange");
    assert.equal(schema.$defs.idJagTokenExchangeRequest.properties.requested_token_type.const, ID_JAG_TOKEN_TYPE);
    assert.equal(schema.$defs.jwtBearerGrantRequest.properties.grant_type.const, "urn:ietf:params:oauth:grant-type:jwt-bearer");
    assert.equal(schema.$defs.metadata.properties.authorization_grant_profiles_supported.items.const, ID_JAG_GRANT_PROFILE);
    assert.deepEqual(schema.$defs.idJagClaims.required, [
      "iss",
      "sub",
      "aud",
      "resource",
      "client_id",
      "exp",
      "iat",
      "scope",
      "nonce",
      "jti",
      "subject",
      "grant_profile",
      "idJagDraftVersion",
    ]);
    assert.equal(schema.$defs.idJagHeader.properties.typ.const, "oauth-id-jag+jwt");
    assert.equal(schema.properties.draftVersion.$ref, "#/$defs/draftVersion");
  });

  it("round-trips the two-stage XAA sequence from token exchange to JWT bearer grant", () => {
    const stage1 = buildIdJagTokenExchangeRequest({
      audience: ASANA_AUDIENCE,
      resource: RESOURCE,
      scopes: ["tasks:write", "tasks:read"],
      subjectToken: SUBJECT_TOKEN,
      subjectTokenType: SUBJECT_TOKEN_TYPE,
      clientAssertion: "client-assertion-fixture",
    });

    assert.deepEqual(stage1, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      requested_token_type: ID_JAG_TOKEN_TYPE,
      audience: ASANA_AUDIENCE,
      resource: RESOURCE,
      scope: "tasks:read tasks:write",
      subject_token: SUBJECT_TOKEN,
      subject_token_type: SUBJECT_TOKEN_TYPE,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: "client-assertion-fixture",
    });

    const parsedStage1 = parseIdJagTokenExchangeResponse(stage1Response(), {
      expectedAudience: ASANA_AUDIENCE,
      expectedResource: RESOURCE,
      now: NOW,
      consumedNonces: new Set(),
    });

    assert.equal(parsedStage1.issued_token_type, ID_JAG_TOKEN_TYPE);
    assert.equal(parsedStage1.claims.aud, ASANA_AUDIENCE);
    assert.deepEqual(parsedStage1.claims.scope, ["tasks:read", "tasks:write"]);
    assert.equal(parsedStage1.claims.subject.delegatedBy.id, "user:pat");
    assert.equal(parsedStage1.claims.extraClaims.email, "pat@example.com");
    assert.deepEqual(parsedStage1.claims.extraClaims.sub_id, {
      format: "opaque",
      id: "external-user-123",
    });

    const stage2 = buildJwtBearerGrantRequest({
      assertion: parsedStage1.access_token,
    });

    assert.deepEqual(stage2, {
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: parsedStage1.access_token,
    });

    const parsedStage2 = parseJwtBearerGrantRequest(stage2, {
      expectedAudience: ASANA_AUDIENCE,
      expectedResource: RESOURCE,
      now: NOW,
    });

    assert.equal(parsedStage2.claims.aud, ASANA_AUDIENCE);
    assert.equal(parsedStage2.claims.resource, RESOURCE);
  });

  it("enforces scope subset and short-lived assertion bounds", () => {
    assert.throws(
      () =>
        buildIdJagTokenExchangeRequest({
          audience: ASANA_AUDIENCE,
          resource: RESOURCE,
          scopes: ["tasks:read", "admin:everything"],
          allowedScopes: ["tasks:read", "tasks:write"],
          subjectToken: SUBJECT_TOKEN,
          subjectTokenType: SUBJECT_TOKEN_TYPE,
        }),
      /allowed scopes/i,
    );

    assert.throws(
      () =>
        parseIdJagTokenExchangeResponse(stage1Response(), {
          expectedAudience: ASANA_AUDIENCE,
          expectedResource: RESOURCE,
          allowedScopes: ["tasks:read"],
          now: NOW,
        }),
      /allowed scopes/i,
    );

    assert.throws(
      () =>
        parseIdJagTokenExchangeResponse(
          stage1Response({
            access_token: createFixtureIdJag({
              issuer: "https://idp.example",
              subjectId: "user:pat",
              subject: delegatedSubject(),
              audience: ASANA_AUDIENCE,
              resource: RESOURCE,
              clientId: "https://hobo.example/agents/triage-bot",
              scopes: ["tasks:read"],
              nonce: "long-lived-nonce",
              issuedAt: NOW - 60,
              expiresAt: NOW + 7_200,
            }),
            scope: "tasks:read",
          }),
          {
            expectedAudience: ASANA_AUDIENCE,
            expectedResource: RESOURCE,
            now: NOW,
            maxLifetimeSec: 600,
          },
        ),
      /short-lived/i,
    );
  });

  it("rejects an ID-JAG whose audience is reused for another target", () => {
    assert.throws(
      () =>
        parseIdJagTokenExchangeResponse(stage1Response(), {
          expectedAudience: SLACK_AUDIENCE,
          expectedResource: RESOURCE,
          now: NOW,
        }),
      /audience/i,
    );

    assert.throws(
      () =>
        parseJwtBearerGrantRequest(buildJwtBearerGrantRequest({ assertion: stage1Response().access_token }), {
          expectedAudience: SLACK_AUDIENCE,
          expectedResource: RESOURCE,
          now: NOW,
        }),
      /audience/i,
    );
  });

  it("rejects malformed, expired, and anonymous-delegation assertions", () => {
    assert.throws(
      () =>
        parseIdJagTokenExchangeResponse(
          stage1Response({
            access_token: "not.a.valid.jwt",
          }),
          { expectedAudience: ASANA_AUDIENCE, expectedResource: RESOURCE, now: NOW },
        ),
      /compact JWT|base64url JSON/i,
    );

    assert.throws(
      () =>
        parseIdJagTokenExchangeResponse(
          stage1Response({
            access_token: createFixtureIdJag({
              issuer: "https://idp.example",
              subjectId: "user:pat",
              subject: delegatedSubject(),
              audience: ASANA_AUDIENCE,
              resource: RESOURCE,
              clientId: "https://hobo.example/agents/triage-bot",
              scopes: ["tasks:read"],
              nonce: "expired-nonce",
              issuedAt: NOW - 600,
              expiresAt: NOW - 1,
            }),
          }),
          { expectedAudience: ASANA_AUDIENCE, expectedResource: RESOURCE, now: NOW },
        ),
      /expired/i,
    );

    assert.throws(
      () =>
        parseIdJagTokenExchangeResponse(
          stage1Response({
            access_token: createFixtureIdJag({
              issuer: "https://idp.example",
              subjectId: "user:pat",
              subject: { kind: "agent", id: "agent:triage-bot" },
              audience: ASANA_AUDIENCE,
              resource: RESOURCE,
              clientId: "https://hobo.example/agents/triage-bot",
              scopes: ["tasks:read"],
              nonce: "anonymous-nonce",
              issuedAt: NOW - 60,
              expiresAt: NOW + 300,
            }),
          }),
          { expectedAudience: ASANA_AUDIENCE, expectedResource: RESOURCE, now: NOW },
        ),
      /delegatedBy/i,
    );
  });

  it("rejects nonce replay when the stage-1 response is consumed twice", () => {
    const consumedNonces = new Set();

    parseIdJagTokenExchangeResponse(stage1Response(), {
      expectedAudience: ASANA_AUDIENCE,
      expectedResource: RESOURCE,
      now: NOW,
      consumedNonces,
    });

    assert.throws(
      () =>
        parseIdJagTokenExchangeResponse(stage1Response(), {
          expectedAudience: ASANA_AUDIENCE,
          expectedResource: RESOURCE,
          now: NOW,
          consumedNonces,
        }),
      /nonce replay/i,
    );
  });
});
