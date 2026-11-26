import {
  createFixtureHostAttestor,
  type AttestationDocument,
  verifyWorkloadAttestation,
} from "./attestation.js";
import {
  createIdentityIssuedEvent,
  createIdentityRotatedEvent,
  type IdentityEvent,
  validateIdentityEvent,
} from "./events.js";
import {
  createInMemoryKms,
  JwtSvidIssuer,
  verifyJwtWithJwks,
  type JwtSvidClaims,
  type KmsLike,
} from "./issuer.js";
import { isJsonObject, isJsonString, type JsonValue } from "./json.js";

export const IDENTITY_BOUNDARY_SCHEMA = "hobo.draft.s3_02_hobo_identity/v1";

export type ScopeEntry = Readonly<{
  port: string;
  resource: string;
  verbs: readonly string[];
}>;

export type ActiveSvidRecord = Readonly<{
  identityId: string;
  subject: string;
  token: string;
  audience: string;
  scope: readonly ScopeEntry[];
  expiresAt: string;
  signerKid: string;
}>;

export type IssueSvidResult =
  | Readonly<{
      status: "issued";
      svid: ActiveSvidRecord;
      token: string;
      events: readonly IdentityEvent[];
    }>
  | Readonly<{
      status: "denied";
      reason: string;
      events: readonly IdentityEvent[];
    }>;

type RotateSvidInput = {
  identityId: string;
  now?: string;
  nextKeyId?: string;
};

export type RotateSvidResult =
  | Readonly<{
      status: "rotated";
      svid: ActiveSvidRecord;
      previousIdentityId: string;
      token: string;
      events: readonly IdentityEvent[];
    }>
  | Readonly<{
      status: "denied";
      reason: string;
      events: readonly IdentityEvent[];
    }>;

export type GatewayAuthResult =
  | Readonly<{ status: "authenticated"; subject: string; tenant: string; scope: readonly ScopeEntry[] }>
  | Readonly<{ status: "denied"; reason: string }>;

export class IdentityService {
  readonly issuerUrl: string;
  readonly ttlSeconds: number;
  readonly renewalGraceSeconds: number;
  private issuer: JwtSvidIssuer;
  readonly events: IdentityEvent[] = [];
  readonly activeSvids = new Map<string, ActiveSvidRecord>();
  private seq = 0;

  constructor(options: {
    issuerUrl: string;
    kms?: KmsLike;
    genesisKeyId: string;
    ttlSeconds?: number;
    renewalGraceSeconds?: number;
  }) {
    const kms = options.kms ?? createInMemoryKms();
    if (!kms.hasKey(options.genesisKeyId)) {
      kms.generateRsaKey(options.genesisKeyId);
    }
    this.issuerUrl = options.issuerUrl;
    this.ttlSeconds = options.ttlSeconds ?? 900;
    this.renewalGraceSeconds = options.renewalGraceSeconds ?? 300;
    this.issuer = new JwtSvidIssuer({
      issuerUrl: options.issuerUrl,
      kms,
      activeKeyId: options.genesisKeyId,
      jwksKeyIds: [options.genesisKeyId],
    });
  }

  discovery() {
    return this.issuer.discovery();
  }

  jwks() {
    return this.issuer.jwks();
  }

  contractEvidence() {
    return {
      ok: true,
      schema: IDENTITY_BOUNDARY_SCHEMA,
      events: ["identity.Issued", "identity.Rotated"],
    };
  }

  async issueSvidFromAttestation(input: {
    attestationDocument: AttestationDocument;
    requestedScope: ScopeEntry;
    audience: string;
    agentName: string;
    hostPublicKeys: readonly { hostId: string; keyId: string; verificationKey: string }[];
    knownImageDigests: readonly string[];
    now?: string;
  }): Promise<IssueSvidResult> {
    const nowIso = input.now ?? new Date().toISOString();
    const nowSeconds = Math.floor(Date.parse(nowIso) / 1000);
    const verdict = verifyWorkloadAttestation(input.attestationDocument, {
      knownImageDigests: input.knownImageDigests,
      hostPublicKeys: input.hostPublicKeys,
      now: nowIso,
    });

    if (verdict.state !== "attested") {
      return { status: "denied", reason: verdict.reason, events: [] };
    }

    const tenant = verdict.binding.tenant;
    const subject = `spiffe://yard/${tenant}/agent/${input.agentName}`;
    const identityId = `svid-${input.agentName}-${verdict.binding.runId}`;
    const svidRef = `tokenref://identity/svid/${identityId}`;
    const expiresAt = new Date(Date.parse(nowIso) + this.ttlSeconds * 1000).toISOString();

    const claims: JwtSvidClaims = {
      sub: subject,
      aud: input.audience,
      tenant,
      parentPrincipal: verdict.binding.parentPrincipal,
      codeVersion: verdict.binding.codeVersion,
      scope: [input.requestedScope],
      iat: nowSeconds,
      nbf: nowSeconds,
      exp: nowSeconds + this.ttlSeconds,
    };

    const token = await this.issuer.signJwtSvid(claims);
    const record: ActiveSvidRecord = {
      identityId,
      subject,
      token,
      audience: input.audience,
      scope: [input.requestedScope],
      expiresAt,
      signerKid: this.issuer.activeKeyId,
    };
    this.activeSvids.set(identityId, record);

    const event = createIdentityIssuedEvent({
      identityId,
      subject,
      svidRef,
      scope: [input.requestedScope],
      expiresAt,
      tenant,
      seq: this.nextSeq(),
      time: nowIso,
    });
    validateIdentityEvent(event);
    this.events.push(event);

    return { status: "issued", svid: record, token, events: [event] };
  }

  async rotateSvid(input: RotateSvidInput): Promise<RotateSvidResult> {
    const current = this.activeSvids.get(input.identityId);
    if (!current) {
      return { status: "denied", reason: "unknown-identity", events: [] };
    }

    const nowIso = input.now ?? new Date().toISOString();
    const nowSeconds = Math.floor(Date.parse(nowIso) / 1000);
    const expiresMs = Date.parse(current.expiresAt);
    const graceStartMs = expiresMs - this.renewalGraceSeconds * 1000;
    if (Date.parse(nowIso) < graceStartMs) {
      return { status: "denied", reason: "rotation-outside-renewal-grace", events: [] };
    }

    const nextKeyId = input.nextKeyId ?? `${current.signerKid}-successor`;
    this.issuer = this.issuer.rotateSigningKey(nextKeyId);

    const newIdentityId = `${current.identityId}-r${this.events.filter((e) => e.type === "identity.Rotated").length + 1}`;
    const svidRef = `tokenref://identity/svid/${newIdentityId}`;
    const expiresAt = new Date(Date.parse(nowIso) + this.ttlSeconds * 1000).toISOString();

    const claims: JwtSvidClaims = {
      sub: current.subject,
      aud: current.audience,
      tenant: current.subject.split("/")[2] ?? "unknown",
      parentPrincipal: { kind: "agent", id: current.identityId },
      codeVersion: { digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000", version: "rotation" },
      scope: current.scope,
      iat: nowSeconds,
      nbf: nowSeconds,
      exp: nowSeconds + this.ttlSeconds,
    };

    const token = await this.issuer.signJwtSvid(claims);
    const record: ActiveSvidRecord = {
      identityId: newIdentityId,
      subject: current.subject,
      token,
      audience: current.audience,
      scope: current.scope,
      expiresAt,
      signerKid: this.issuer.activeKeyId,
    };
    this.activeSvids.set(newIdentityId, record);

    const event = createIdentityRotatedEvent({
      identityId: newIdentityId,
      previousIdentityId: current.identityId,
      subject: current.subject,
      svidRef,
      expiresAt,
      tenant: claims.tenant,
      seq: this.nextSeq(),
      time: nowIso,
    });
    validateIdentityEvent(event);
    this.events.push(event);

    return {
      status: "rotated",
      svid: record,
      previousIdentityId: current.identityId,
      token,
      events: [event],
    };
  }

  async rotateSvidWithScope(input: {
    identityId: string;
    requestedScope: ScopeEntry;
    now?: string;
  }): Promise<RotateSvidResult> {
    const current = this.activeSvids.get(input.identityId);
    if (!current) {
      return { status: "denied", reason: "unknown-identity", events: [] };
    }
    if (scopeWidens(current.scope[0], input.requestedScope)) {
      return { status: "denied", reason: "scope-widening-requires-live-identity", events: [] };
    }
    const rotateInput: RotateSvidInput = { identityId: input.identityId };
    if (input.now !== undefined) {
      rotateInput.now = input.now;
    }
    return this.rotateSvid(rotateInput);
  }

  async authenticateAtGateway(input: {
    token: string;
    audience: string;
    now?: string;
  }): Promise<GatewayAuthResult> {
    const nowIso = input.now ?? new Date().toISOString();
    const nowSeconds = Math.floor(Date.parse(nowIso) / 1000);
    try {
      const verified = await verifyJwtWithJwks(input.token, this.jwks(), {
        issuer: this.issuerUrl,
        audience: input.audience,
        now: nowSeconds,
      });
      const scope = parseScopeEntries(verified.claims.scope ?? null);
      if (scope === undefined) {
        return { status: "denied", reason: "scope-claim-missing" };
      }
      return {
        status: "authenticated",
        subject: String(verified.claims.sub),
        tenant: String(verified.claims.tenant),
        scope,
      };
    } catch (error) {
      return {
        status: "denied",
        reason: error instanceof Error ? error.message : "authentication-failed",
      };
    }
  }

  getAuditEvents(): readonly IdentityEvent[] {
    return [...this.events];
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }
}

function scopeWidens(current: ScopeEntry | undefined, requested: ScopeEntry): boolean {
  if (!current) {
    return true;
  }
  if (current.port !== requested.port || current.resource !== requested.resource) {
    return true;
  }
  const currentVerbs = new Set(current.verbs);
  for (const verb of requested.verbs) {
    if (!currentVerbs.has(verb)) {
      return true;
    }
  }
  return requested.verbs.length > current.verbs.length;
}

function parseScopeEntries(value: JsonValue): ScopeEntry[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries: ScopeEntry[] = [];
  for (const entry of value) {
    if (!isJsonObject(entry) || !isJsonString(entry.port) || !isJsonString(entry.resource) || !Array.isArray(entry.verbs)) {
      return undefined;
    }
    const verbs = entry.verbs.filter((verb) => isJsonString(verb));
    if (verbs.length !== entry.verbs.length) {
      return undefined;
    }
    entries.push({ port: entry.port, resource: entry.resource, verbs });
  }
  return entries;
}

export {
  createFixtureHostAttestor,
  verifyWorkloadAttestation,
  createInMemoryKms,
  verifyJwtWithJwks,
};
