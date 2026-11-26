import type {
  ArtifactRef,
  InstallVerdict,
  ProvenanceTier,
  RefusalReason,
  SignedArtifactCandidate,
} from "./artifact-trust.js";

// domain-view: parse-produced draft-proof record; its wire form is the ArtifactPublishedEvent proto message in data-models/.
export type ArtifactPublishedEvent = {
  readonly type: "artifact.Published";
  readonly ref: ArtifactRef;
  readonly keyId: string;
  readonly provenanceTier: ProvenanceTier;
};

// domain-view: parse-produced draft-proof record; its wire form is the ArtifactInstallVerifiedEvent proto message in data-models/.
export type ArtifactInstallVerifiedEvent = {
  readonly type: "artifact.InstallVerified";
  readonly ref: ArtifactRef;
  readonly keyId: string;
  readonly provenanceTier: ProvenanceTier;
};

// domain-view: parse-produced draft-proof record; its wire form is the ArtifactInstallRefusedEvent proto message in data-models/.
export type ArtifactInstallRefusedEvent = {
  readonly type: "artifact.InstallRefused";
  readonly ref: ArtifactRef | null;
  readonly reasons: readonly RefusalReason[];
};

export type ArtifactTrustEvent =
  | ArtifactPublishedEvent
  | ArtifactInstallVerifiedEvent
  | ArtifactInstallRefusedEvent;

export type VerifiedCatalogEntry = {
  readonly ref: ArtifactRef;
  readonly availableToMatching: true;
  readonly selectedByMatching: false;
};

export function artifactPublishedEvent(input: {
  candidate: SignedArtifactCandidate;
}): ArtifactPublishedEvent {
  return Object.freeze({
    type: "artifact.Published",
    ref: input.candidate.artifact,
    keyId: input.candidate.signature.keyId,
    provenanceTier: input.candidate.provenance.slsa.provenanceTier,
  });
}

export function artifactInstallVerifiedEvent(input: {
  verdict: Extract<InstallVerdict, { ok: true }>;
  keyId: string;
  provenanceTier: ProvenanceTier;
}): ArtifactInstallVerifiedEvent {
  return Object.freeze({
    type: "artifact.InstallVerified",
    ref: Object.freeze({
      coordinate: input.verdict.ref.coordinate,
      version: input.verdict.ref.version,
      mediaType: input.verdict.ref.mediaType,
      bytes: "",
      digest: input.verdict.ref.digest,
      uri: input.verdict.ref.uri,
    }),
    keyId: input.keyId,
    provenanceTier: input.provenanceTier,
  });
}

export function artifactInstallRefusedEvent(input: {
  ref: ArtifactRef | null;
  reasons: readonly RefusalReason[];
}): ArtifactInstallRefusedEvent {
  return Object.freeze({
    type: "artifact.InstallRefused",
    ref: input.ref,
    reasons: Object.freeze([...input.reasons]),
  });
}

export function verifiedArtifactCatalog(events: readonly ArtifactTrustEvent[]): readonly VerifiedCatalogEntry[] {
  const entries = new Map<string, VerifiedCatalogEntry>();

  for (const event of events) {
    if (event.type === "artifact.InstallVerified" && event.ref) {
      entries.set(event.ref.digest, {
        ref: event.ref,
        availableToMatching: true,
        selectedByMatching: false,
      });
    }
    if (event.type === "artifact.InstallRefused" && event.ref) {
      entries.delete(event.ref.digest);
    }
  }

  return Object.freeze([...entries.values()]);
}
