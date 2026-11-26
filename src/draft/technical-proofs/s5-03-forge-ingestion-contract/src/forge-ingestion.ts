import { createHash } from "node:crypto";

import { validateGenRequest } from "../../generation-pipeline-io-contract/src/contract.js";
import { sanitizeGenerationMaterials } from "../../generation-material-sanitization-contract/src/material-sanitization.js";
import { scaffoldGenerationRequest } from "../../generation-scaffold-stage-contract/src/scaffold.js";

import {
  assertCandidateCompiles,
  emitCandidatePackage,
  type EmittedCandidatePackage
} from "./emit-package.js";
import { buildForgeEvent, type ForgeEvent } from "./events.js";
import {
  fetchFixtureSources,
  parseIngestionSources,
  type ParsedIngestion
} from "./parse-sources.js";
import { type JsonValue } from "./json.js";


export type ReasoningEngine = {
  id: string;
  augmentPackage?: (input: {
    parsed: ParsedIngestion;
    emitted: EmittedCandidatePackage;
  }) => EmittedCandidatePackage;
};

export const scaffoldOnlyReasoningEngine: ReasoningEngine = {
  id: "scaffold-only"
};

export type ForgeIngestionResult =
  | {
      status: "compiled";
      requestId: string;
      providerId: string;
      packageDir: string;
      packageRef: EmittedCandidatePackage["packageRef"];
      events: ForgeEvent[];
      eventTypes: string[];
    }
  | {
      status: "material-refused";
      requestId: string;
      events: ForgeEvent[];
      eventTypes: string[];
      reason: string;
    };

export type ForgeIngestionOptions = {
  reasoningEngine?: ReasoningEngine;
  outputDir?: string;
  ts?: string;
  tenant?: string;
  keepOutput?: boolean;
};

export async function runForgeIngestion(
  fixtureUrl: string,
  options: ForgeIngestionOptions = {}
): Promise<ForgeIngestionResult> {
  const reasoningEngine = options.reasoningEngine ?? scaffoldOnlyReasoningEngine;
  const events: ForgeEvent[] = [];
  let seq = 1;
  const ts = options.ts ?? "2026-07-02T00:00:00.000Z";
  const tenant = options.tenant ?? "tenant:demo";

  const { index, sources } = await fetchFixtureSources(fixtureUrl);
  events.push(
    buildForgeEvent({
      requestId: index.requestId,
      type: "forge.IngestionStarted",
      seq: seq++,
      ts,
      tenant,
      data: {
        requestId: index.requestId,
        fixtureUrl,
        reasoningEngineId: reasoningEngine.id
      }
    })
  );

  for (const source of sources) {
    events.push(
      buildForgeEvent({
        requestId: index.requestId,
        type: "forge.SourceFetched",
        seq: seq++,
        ts,
        tenant,
        data: {
          requestId: index.requestId,
          kind: source.kind,
          ref: source.ref,
          digest: source.digest
        }
      })
    );
  }

  const parsed = parseIngestionSources(index, sources);
  events.push(
    buildForgeEvent({
      requestId: index.requestId,
      type: "forge.SourcesParsed",
      seq: seq++,
      ts,
      tenant,
      data: {
        requestId: index.requestId,
        providerId: parsed.providerId,
        targetWitPort: parsed.targetWitPort,
        // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
        openapiTitle: (parsed.openapi.info as { title?: string } | undefined)?.title ?? "",
        equivalenceClassCount: parsed.equivalenceClasses.length,
        terraformHintCount: parsed.terraformComments.length
      }
    })
  );

  const generationRequest = buildGenerationRequest(parsed);
  const sanitization = sanitizeGenerationMaterials(generationRequest, parsed.materials, {
    seq: seq++,
    ts,
    tenant
  });
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  events.push(sanitization.event as ForgeEvent);

  if (sanitization.status === "material-refused") {
    return {
      status: "material-refused",
      requestId: index.requestId,
      events,
      eventTypes: events.map((event) => event.type),
      reason: "material.injection_detected"
    };
  }

  const requestedEvent = buildGenRequestedEvent(sanitization.sanitizedRequest, seq++, ts, tenant);
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  events.push(requestedEvent as ForgeEvent);

  const scaffold = scaffoldGenerationRequest(sanitization.sanitizedRequest, {
    seq: seq++,
    ts,
    tenant
  });

  if (scaffold.status === "needs-human") {
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    events.push(scaffold.event as ForgeEvent);
    return {
      status: "material-refused",
      requestId: index.requestId,
      events,
      eventTypes: events.map((event) => event.type),
      // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
      reason: scaffold.event.data.reason as string
    };
  }

  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  events.push(scaffold.event as ForgeEvent);

  let emitted = await emitCandidatePackage(parsed, { outputDir: options.outputDir });
  if (reasoningEngine.augmentPackage) {
    emitted = reasoningEngine.augmentPackage({ parsed, emitted });
  }

  events.push(
    buildForgeEvent({
      requestId: index.requestId,
      type: "forge.PackageEmitted",
      seq: seq++,
      ts,
      tenant,
      data: {
        requestId: index.requestId,
        providerId: emitted.providerId,
        packageRef: emitted.packageRef,
        fileCount: emitted.files.length,
        scaffoldDigest: scaffold.candidate.ref.digest
      }
    })
  );

  assertCandidateCompiles(emitted.rootDir);
  events.push(
    buildForgeEvent({
      requestId: index.requestId,
      type: "forge.PackageCompiled",
      seq: seq++,
      ts,
      tenant,
      data: {
        requestId: index.requestId,
        packageRef: emitted.packageRef,
        compiler: "typescript",
        mode: "noEmit"
      }
    })
  );

  return {
    status: "compiled",
    requestId: index.requestId,
    providerId: emitted.providerId,
    packageDir: emitted.rootDir,
    packageRef: emitted.packageRef,
    events,
    eventTypes: events.map((event) => event.type)
  };
}

function buildGenerationRequest(parsed: ParsedIngestion) {
  const manifestPayload = parsed.capabilityManifest;
  return {
    schema: "hobo.gen.request/v1",
    requestId: parsed.requestId,
    artifactKind: parsed.artifactKind,
    target: {
      witPort: parsed.targetWitPort
    },
    capabilityManifestRef: {
      uri: `fixture://${parsed.requestId}/capability-manifest`,
      digest: digestForPayload(manifestPayload)
    },
    authoritativeRefs: [
      {
        kind: "wit",
        ref: `wit://${parsed.targetWitPort.split("@", 1)[0]}`
      },
      {
        kind: "conformance-suite",
        suiteId: parsed.conformanceSuiteId,
        ref: `fixture://${parsed.requestId}/conformance-suite`
      }
    ],
    materialRefs: []
  };
}

function buildGenRequestedEvent(
  request: ReturnType<typeof validateGenRequest>,
  seq: number,
  ts: string,
  tenant: string
) {
  return {
    id: `01GENREQ${String(seq).padStart(4, "0")}`,
    type: "gen.Requested",
    v: 1,
    streamId: `generation:${request.requestId}`,
    seq,
    ts,
    actor: {
      kind: "agent",
      id: "agent:forge-ingestion"
    },
    tenant,
    correlationId: request.requestId,
    data: request
  };
}

function digestForPayload(payload: JsonValue): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}
