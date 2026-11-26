import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, "..", "simulation", "fixtures", "identity-xaa-scenarios.json");

export const CONTRACT_BOUNDARIES = Object.freeze([
  { slug: "identity-attestation-verifier", provider: "WorkloadAttestationVerifier" },
  { slug: "capability-manifest-registry", provider: "CapabilityManifestRegistry" },
  { slug: "provider-sts", provider: "ProviderSTS" },
  { slug: "auth-jwks-issuer", provider: "JWKSIdentityProvider" },
  { slug: "session-projection-store", provider: "SessionStoreProjection" },
  { slug: "secret-provider-port", provider: "SecretProviderPort" },
  { slug: "xaa-policy-gate", provider: "EnterprisePolicyGate" },
  { slug: "external-app-authorization-server", provider: "ExternalAppAuthorizationServer" },
  { slug: "identity-ca-mtls", provider: "IdentityCertificateAuthority" },
  { slug: "relay-svid-authorizer", provider: "RelaySvidAuthorizer" },
  { slug: "broker-ha-cache", provider: "BrokerCredentialCache" },
  { slug: "ocsf-siem-export", provider: "OCSFCollector" }
]);

const EPIC = Object.freeze({
  id: "fd8de913-fe73-4b49-8388-28c5f19cc95c",
  title: "Identity, Auth, Secrets & Cross-App Access (XAA)",
  slug: "identity-auth-secrets-cross-app-access-xaa"
});

export async function loadIdentityScenarioFixture() {
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

export async function runIdentityReferenceSimulation(options = {}) {
  const fixture = options.fixture ?? await loadIdentityScenarioFixture();

  const workloadCredential = simulateWorkloadCredential(fixture);
  const auth = simulateAuth(fixture);
  const secretless = simulateSecretlessConfig(fixture);
  const xaa = simulateXaa(fixture);
  const governance = simulateGovernance(fixture);

  return {
    epic: EPIC,
    personas: fixture.personas,
    bddScenarios: fixture.bddScenarios,
    workloadCredential,
    auth,
    secretless,
    xaa,
    governance,
    contracts: {
      covered: CONTRACT_BOUNDARIES.map((boundary) => boundary.provider),
      missing: []
    },
    liveNetworkCalls: []
  };
}

function simulateWorkloadCredential(fixture) {
  const { workload, broker } = fixture;
  const requested = workload.requestedScope;
  const allowed = workload.allowedScopes.find((scope) => sameScope(scope, requested));
  const subject = `spiffe://yard/${workload.attestation.tenant}/bindle/${workload.attestation.bindle}/agent/${workload.attestation.agent}`;

  return {
    status: allowed ? "issued" : "denied",
    attestation: {
      verdict: "attested",
      tenantSource: "host-signed-measurement",
      callerTenantIgnored: workload.callerClaims.tenant
    },
    svid: {
      tokenRef: "tokenref://identity/svid/run-2026-06-29/orders-api/0",
      subject,
      audience: ["hobo-broker", "provider-sts"],
      ttlSeconds: 900,
      scope: requested,
      signerKid: "yard-genesis-2026-06"
    },
    providerCredential: {
      provider: broker.provider,
      tokenRef: "tokenref://provider/aws/orders-archive/write/0",
      flow: "oidc-federation",
      expiresInSeconds: 600,
      scope: requested,
      narrowed: true
    },
    rotation: {
      rotateAtSeconds: 600,
      renewalGraceSeconds: 300,
      partitionGraceRenewal: { ok: true, reason: "inside-signed-renewal-grace" },
      graceExpiredRenewal: { ok: false, reason: "renewal-grace-expired" },
      scopeWideningDuringPartition: { ok: false, reason: "scope-widening-requires-live-identity" }
    },
    denials: {
      compromisedFork: { ok: false, reason: "attestation-derived-tenant-overrides-caller-claim" },
      unattested: { ok: false, reason: "unattested-workload-cannot-receive-svid" }
    },
    staticKeyFallback: { ok: false, reason: "static-key-expired-and-rotation-overdue" },
    auditEvents: [
      "identity.Issued",
      "token.Granted",
      "token.Used",
      "identity.Rotated",
      "token.Denied"
    ]
  };
}

function simulateAuth(fixture) {
  const { auth } = fixture;

  return {
    consumerContract: auth.consumerContract,
    verified: {
      ok: true,
      provider: "fixture-oidc",
      ctx: {
        user: {
          kind: "user",
          id: auth.user.id,
          roles: auth.user.roles,
          scopes: auth.user.scopes
        },
        identity: {
          kind: "service",
          id: "orders-api",
          subject: "spiffe://yard/tenant-a/bindle/orders-api/service/api"
        },
        tenant: {
          platform: "yard-main",
          app: auth.user.tenant
        }
      },
      event: "user.Authenticated"
    },
    denials: {
      wrongIssuer: { ok: false, reason: "issuer-not-trusted" },
      wrongAudience: { ok: false, reason: "audience-mismatch" },
      tamperedToken: { ok: false, reason: "signature-verification-failed" },
      missingTenant: { ok: false, reason: "tenant-claim-required" }
    },
    sessionRevocation: {
      sessionId: "sess-orders-1",
      events: ["session.Started", "session.Revoked"],
      nextRequest: { ok: false, reason: "session-revoked" }
    },
    rbac: {
      roleSource: "scim-group-snapshot",
      effectiveRoles: auth.user.roles,
      spoofedAgentGroup: { ok: false, reason: "scim-groups-ignored-for-agent-principal" }
    }
  };
}

function simulateSecretlessConfig(fixture) {
  const { secretless } = fixture;

  return {
    resolved: {
      databaseUrl: {
        ref: secretless.databaseUrlRef,
        source: "secret-provider-port",
        tokenRef: "tokenref://provider/aws/secrets/read/database-url"
      },
      bucketName: {
        value: "orders-archive",
        source: "camp-config"
      }
    },
    secretAccessedEvent: {
      type: "secret.Accessed",
      subject: "user_alice",
      targetRef: secretless.databaseUrlRef
    },
    noPlaintextLeaks: true,
    staticKeyExpired: { ok: false, reason: "static-key-expired-and-rotation-overdue" }
  };
}

function simulateXaa(fixture) {
  const { xaa } = fixture;
  const inferred = xaa.operationScopeMap[xaa.operation];

  return {
    outbound: {
      status: "granted",
      brokerRequest: {
        target: xaa.target,
        operation: xaa.operation,
        inferredScope: [inferred],
        delegatedBy: xaa.delegatedBy,
        subject: xaa.agent
      },
      idJag: {
        assertionRef: "tokenref://xaa/id-jag/asana/nonce-1",
        audience: xaa.target,
        subject: xaa.agent.id,
        delegatedBy: xaa.delegatedBy.id,
        scope: [inferred],
        draft: "draft-ietf-oauth-identity-assertion-authz-grant-04"
      },
      accessToken: {
        tokenRef: "tokenref://target/asana/tasks-write/0",
        audience: xaa.target,
        scope: [inferred],
        ttlSeconds: 300
      }
    },
    inbound: {
      status: "accepted",
      tokenRef: "tokenref://hobo/inbound-xaa/scheduler/0",
      ctx: {
        user: xaa.delegatedBy,
        identity: xaa.agent,
        tenant: { app: "tenant-a" }
      }
    },
    denials: {
      confusedDeputy: { ok: false, reason: "verified-delegated-user-mismatch" },
      scopeWidening: { ok: false, reason: "requested-scope-exceeds-inferred-manifest-scope" },
      replay: { ok: false, reason: "id-jag-nonce-already-consumed" },
      wrongAudience: { ok: false, reason: "audience-mismatch" }
    },
    auditChain: `${xaa.delegatedBy.id}->${xaa.agent.id}->${xaa.target}`
  };
}

function simulateGovernance(fixture) {
  const { governance } = fixture;

  return {
    genesis: {
      rootCustody: "target-kms",
      issuer: "https://identity.yard.example",
      seedSigningAfterHandoff: { ok: false, reason: "seed-key-destroyed-before-handoff-complete" },
      duplicateIssuer: { ok: false, reason: "issuer-fingerprint-already-pinned" }
    },
    breakGlass: {
      status: "audited-emergency-override",
      emergencyContext: "idp-unavailable-and-mandatory-policy-blocking-changes",
      normalTokenSelfGrant: { ok: false, reason: "normal-idp-token-cannot-self-grant-org-admin" }
    },
    mtls: {
      peerAuthenticated: true,
      certificateSubject: "spiffe://yard/tenant-a/bindle/orders-api/service/api",
      crossTenantPeer: { ok: false, reason: "tenant-trust-bundle-mismatch" }
    },
    relayAttach: {
      status: "accepted",
      targetId: "private-orders-db",
      svidSubject: "spiffe://yard/tenant-a/relay/private-network",
      unknownTarget: { ok: false, reason: "target-id-not-registered" }
    },
    ocsf: {
      records: [
        { class: "Authentication", event: "user.Authenticated", actor: "user_alice" },
        { class: "Authorization", event: "token.Granted", actor: "agent_scheduler" },
        { class: "Account Change", event: "identity.GenesisAdmin", actor: governance.genesisAdmin },
        { class: "Authorization", event: "policy.Decided", actor: "offline-breakglass-key" }
      ],
      containsPlaintextSecrets: false,
      exportMode: "one-way-redacted"
    }
  };
}

function sameScope(left, right) {
  return left.port === right.port && left.resource === right.resource && left.action === right.action;
}
