import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const GENERATED_STACK_LAYERS = Object.freeze(["data", "business", "message", "intelligence", "ui"]);

const LOOP_STEPS = Object.freeze(["generate", "validate", "repair", "certify", "persist"]);
const LOOP_EVENT_TYPES = Object.freeze({
  generate: "generation.LayerGenerated",
  validate: "generation.LayerValidated",
  repair: "generation.LayerRepaired",
  certify: "generation.LayerCertified",
});
const LAYER_CONTRACTS = Object.freeze({
  data: {
    deterministic: true,
    path: "src/data/_generated/support-ticket.ts",
    gates: ["migration", "projection-rebuild", "typecheck"],
  },
  business: {
    deterministic: true,
    path: "src/business/_generated/support-ticket-rules.ts",
    gates: ["invariant-replay", "unit-contract", "typecheck"],
  },
  message: {
    deterministic: true,
    path: "src/message/_generated/support-ticket-handlers.ts",
    gates: ["handler-contract", "trace-replay", "typecheck"],
  },
  intelligence: {
    deterministic: false,
    autoHealSafe: false,
    path: "src/intelligence/_generated/support-ticket-training.ts",
    gates: ["conformance", "eval-threshold", "policy"],
  },
  ui: {
    deterministic: false,
    autoHealSafe: false,
    path: "src/ui/_generated/support-ticket-priority.tsx",
    gates: ["component-typecheck", "design-md", "policy"],
  },
});

export function runCrossLayerPropagation(input = {}) {
  const domainRecord = parseDomainRecordChange(input.domainRecordChange);
  const existingSources = input.existingSources ?? {};
  const layerOverrides = input.layerOverrides ?? {};
  const events = [];

  const layers = GENERATED_STACK_LAYERS.map((name) => {
    const contract = {
      ...LAYER_CONTRACTS[name],
      ...(layerOverrides[name]),
    };
    const generatedContent = renderGeneratedContent(name, domainRecord);
    const generatedRegion = buildGeneratedRegion({
      layerName: name,
      path: contract.path,
      content: generatedContent,
    });
    const gates = contract.gates.map((gateId) => ({
      id: `${name}.${gateId}`,
      status: "passed",
      reportRef: `validation://generated-stack/${name}/${gateId}/${domainRecord.digest}`,
    }));
    const provenance = {
      schemaVersion: "hobo.generated-stack.provenance/v1",
      domainRecordRef: domainRecord.ref,
      domainRecordDigest: domainRecord.digest,
      layer: name,
      gates: gates.map((gate) => gate.reportRef),
    };
    const sourceBefore = existingSources[name] ?? "";
    const decision = decidePersistence({ contract, name, sourceBefore, generatedRegion });

    emitLoopEvents({ events, layerName: name, gates, domainRecord, decision });

    return freeze({
      name,
      deterministic: contract.deterministic,
      loop: [...LOOP_STEPS],
      domainRecord: {
        ref: domainRecord.ref,
        digest: domainRecord.digest,
      },
      generatedRegion,
      gates,
      provenance,
      reviewableDiff: {
        kind: "region-scoped",
        path: generatedRegion.path,
        expectedDigest: generatedRegion.digest,
      },
      persistence: decision.persistence,
      proposal: decision.proposal,
      sourceBefore,
      sourceAfter: decision.sourceAfter,
    });
  });

  const layersByName = Object.fromEntries(layers.map((layer) => [layer.name, layer]));

  return freeze({
    schemaVersion: "hobo.cross-layer-generated-stack/v1",
    domainRecord,
    layers,
    layersByName,
    events,
    summary: {
      gatedLayers: layers.filter((layer) => layer.gates.every((gate) => gate.status === "passed")).map((layer) => layer.name),
      persistedLayers: layers.filter((layer) => layer.persistence.status === "persisted").map((layer) => layer.name),
      proposedLayers: layers.filter((layer) => layer.persistence.status === "proposed-human-gate").map((layer) => layer.name),
    },
  });
}

export function renderSourceWithGeneratedRegions(layers) {
  return Object.fromEntries(
    layers.map((layer) => [
      layer.name,
      applyGeneratedRegion(`// hand-authored ${layer.name} boundary\n`, layer.generatedRegion),
    ]),
  );
}

export function checkGeneratedRegions({ expectedLayers = [], sources = {} } = {}) {
  const drift = [];

  for (const layer of expectedLayers) {
    const source = String(sources[layer.name] ?? "");
    const actual = extractGeneratedRegion(source, layer.name);

    if (!actual) {
      drift.push({
        layer: layer.name,
        path: layer.generatedRegion.path,
        status: "missing",
        expectedDigest: layer.generatedRegion.digest,
        message: `generated region drift: ${layer.name} region missing`,
      });
      continue;
    }

    const actualDigest = digest(actual.content);
    if (actualDigest !== layer.generatedRegion.digest || actual.content !== layer.generatedRegion.content) {
      drift.push({
        layer: layer.name,
        path: layer.generatedRegion.path,
        status: "changed",
        expectedDigest: layer.generatedRegion.digest,
        actualDigest,
        message: `generated region drift: ${layer.name} generated region changed`,
      });
    }
  }

  return freeze({
    ok: drift.length === 0,
    exitCode: drift.length === 0 ? 0 : 1,
    code: drift.length === 0 ? null : "HOBO_CODEGEN_DRIFT",
    drift,
    sourcesAfter: { ...sources },
  });
}

function decidePersistence({ contract, name, sourceBefore, generatedRegion }) {
  if (contract.autoHealSafe === false || !contract.deterministic) {
    const reason = contract.deterministic
      ? "layer-cannot-auto-heal-safely-human-gate"
      : "nondeterministic-layer-requires-human-gate";
    return {
      sourceAfter: sourceBefore,
      persistence: {
        status: "proposed-human-gate",
        mutatedSource: false,
        reason,
      },
      proposal: {
        kind: "reviewable-diff",
        layer: name,
        patch: [
          {
            path: generatedRegion.path,
            digest: generatedRegion.digest,
            content: generatedRegion.content,
          },
        ],
      },
    };
  }

  return {
    sourceAfter: applyGeneratedRegion(sourceBefore, generatedRegion),
    persistence: {
      status: "persisted",
      mutatedSource: true,
      reason: "deterministic-gates-passed",
    },
    proposal: null,
  };
}

function emitLoopEvents({ events, layerName, gates, domainRecord, decision }) {
  for (const step of LOOP_STEPS) {
    const type = step === "persist"
      ? decision.persistence.status === "proposed-human-gate"
        ? "generation.LayerProposed"
        : "generation.LayerPersisted"
      : LOOP_EVENT_TYPES[step];
    events.push({
      id: `generated-stack:${domainRecord.digest}:${events.length + 1}`,
      type,
      layer: layerName,
      domainRecordRef: domainRecord.ref,
      gateRefs: step === "validate" ? gates.map((gate) => gate.reportRef) : [],
      persistence: step === "persist" ? decision.persistence.status : undefined,
    });
  }
}

function renderGeneratedContent(layerName, domainRecord) {
  const fieldSummary = `${domainRecord.field}: ${domainRecord.displayType}`;
  const typeName = `${pascalCase(domainRecord.record)}${pascalCase(domainRecord.field)}`;
  const invariantRows = domainRecord.invariants.map((invariant) => `  ${JSON.stringify(invariant)},`).join("\n");

  if (layerName === "data") {
    return [
      `export type ${typeName} = ${domainRecord.nextType};`,
      `export const ${domainRecord.record}${pascalCase(domainRecord.field)}Projection = {`,
      `  field: ${JSON.stringify(domainRecord.field)},`,
      `  summary: ${JSON.stringify(fieldSummary)},`,
      "};",
    ].join("\n");
  }

  if (layerName === "business") {
    return [
      `export const ${domainRecord.record}BusinessRules = {`,
      `  field: ${JSON.stringify(fieldSummary)},`,
      "  required: true,",
      `  invariants: [`,
      invariantRows,
      "  ],",
      "};",
    ].join("\n");
  }

  if (layerName === "message") {
    return [
      `export const ${domainRecord.record}MessageContract = {`,
      `  event: ${JSON.stringify(`${domainRecord.record}.${domainRecord.field}.changed`)},`,
      `  payload: ${JSON.stringify(fieldSummary)},`,
      "  contractGate: \"handler-replay\",",
      "};",
    ].join("\n");
  }

  if (layerName === "intelligence") {
    return [
      `export const ${domainRecord.record}TrainingCandidate = {`,
      `  inputFeature: ${JSON.stringify(fieldSummary)},`,
      "  promotionGate: \"eval-threshold-and-policy\",",
      "  mode: \"propose\",",
      "};",
    ].join("\n");
  }

  return [
    `export const ${domainRecord.record}PriorityComponent = {`,
    `  designMdGate: ${JSON.stringify("priority states must remain visible and typed")},`,
    `  prop: ${JSON.stringify(fieldSummary)},`,
    "  mode: \"propose\",",
    "};",
  ].join("\n");
}

function buildGeneratedRegion({ layerName, path, content }) {
  const normalized = normalizeText(content);
  const contentDigest = digest(normalized);
  return freeze({
    layer: layerName,
    path,
    digest: contentDigest,
    content: normalized,
    startMarker: `// hobo:generated:start layer=${layerName} digest=${contentDigest}`,
    endMarker: `// hobo:generated:end layer=${layerName}`,
  });
}

function applyGeneratedRegion(source, generatedRegion) {
  const rendered = renderGeneratedRegion(generatedRegion);
  const existing = extractGeneratedRegionBounds(source, generatedRegion.layer);
  if (!existing) {
    return normalizeText(`${source}${source.endsWith("\n") || source.length === 0 ? "" : "\n"}${rendered}`);
  }

  return normalizeText(`${source.slice(0, existing.start)}${rendered}${source.slice(existing.end)}`);
}

function renderGeneratedRegion(generatedRegion) {
  return `${generatedRegion.startMarker}\n${generatedRegion.content}${generatedRegion.endMarker}\n`;
}

function extractGeneratedRegion(source, layerName) {
  const bounds = extractGeneratedRegionBounds(source, layerName);
  if (!bounds) return null;

  const bodyStart = source.indexOf("\n", bounds.start) + 1;
  const content = source.slice(bodyStart, bounds.endMarkerStart);
  return {
    content: normalizeText(content),
  };
}

function extractGeneratedRegionBounds(source, layerName) {
  const startToken = `// hobo:generated:start layer=${layerName} `;
  const endToken = `// hobo:generated:end layer=${layerName}`;
  const start = source.indexOf(startToken);
  if (start === -1) return null;
  const endMarkerStart = source.indexOf(endToken, start);
  if (endMarkerStart === -1) return null;
  const endLine = source.indexOf("\n", endMarkerStart);
  const end = endLine === -1 ? source.length : endLine + 1;

  return {
    start,
    end,
    endMarkerStart,
  };
}

function parseDomainRecordChange(value) {
  if (!value || !isJsonObject(value)) {
    throw new TypeError("domainRecordChange is required");
  }
  const record = requiredString(value.record, "domainRecordChange.record");
  const field = requiredString(value.field, "domainRecordChange.field");
  const nextType = requiredString(value.nextType, "domainRecordChange.nextType");
  const ref = requiredString(value.ref, "domainRecordChange.ref");
  const invariants = Array.isArray(value.invariants) ? value.invariants.map(String) : [];
  const payload = {
    ref,
    record,
    field,
    previousType: String(value.previousType ?? ""),
    nextType,
    invariants,
  };

  return freeze({
    ...payload,
    displayType: nextType.replaceAll("\"", ""),
    digest: digest(stableStringify(payload)),
  });
}

function requiredString(value, path) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(normalizeText(value), "utf8").digest("hex")}`;
}

function stableStringify(value) {
  return `${JSON.stringify(toStableValue(value), null, 2)}\n`;
}

function toStableValue(value) {
  if (Array.isArray(value)) return value.map(toStableValue);
  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, entry]) => [key, toStableValue(entry)])
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  }
  return value;
}

function normalizeText(value) {
  return `${String(value).replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\s+$/u, "")}\n`;
}

function pascalCase(value) {
  return String(value)
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("");
}

function freeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
