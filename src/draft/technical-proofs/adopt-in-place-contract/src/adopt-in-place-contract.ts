import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const ADOPT_IN_PLACE_CONTRACT_VERSION = "hobo.adopt-in-place/v1";

const KIND_PRIORITY = new Map([
  ["adopted", 0],
  ["external", 1],
  ["managed", 2],
]);

export class AdoptInPlaceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AdoptInPlaceError";
    this.code = code;
    this.details = details;
  }
}

export function createFixtureIacState() {
  return deepFreeze({
    kind: "pulumi-state",
    resources: [
      {
        id: "legacy-db",
        type: "database",
        externalId: "urn:pulumi:prod::legacy::aws:rds/instance:Instance::legacy-db",
        outputs: {
          endpoint: "postgres://legacy-db.internal:5432/shop",
          passwordRef: "secret://legacy-db/password",
        },
        state: {
          stack: "prod",
          provider: "aws",
          urn: "urn:pulumi:prod::legacy::aws:rds/instance:Instance::legacy-db",
        },
      },
    ],
  });
}

export function createTerraformStateFixture() {
  return deepFreeze({
    kind: "terraform-state",
    resources: [
      {
        id: "legacy-network",
        type: "network",
        externalId: "terraform://prod/aws_vpc.legacy",
        outputs: {
          cidr: "10.0.0.0/16",
          vpcId: "vpc-legacy",
        },
        state: {
          address: "aws_vpc.legacy",
          provider: "registry.terraform.io/hashicorp/aws",
          workspace: "prod",
        },
      },
    ],
  });
}

export function createUnsupportedTerraformStateFixture() {
  return deepFreeze({
    kind: "terraform-state",
    resources: [
      {
        id: "legacy-bus",
        type: "managedKafka",
        externalId: "terraform://prod/kafka.legacy",
        outputs: {
          brokerUrl: "kafka://legacy-bus.internal:9092",
        },
        state: {
          address: "confluent_kafka_cluster.legacy",
          provider: "registry.terraform.io/confluentinc/confluent",
          workspace: "prod",
        },
      },
    ],
  });
}

export function createAdoptionGraph({ nodes = [] } = {}) {
  const graphNodes = {};
  for (const node of nodes) {
    const normalized = normalizeNode(node);
    if (Object.hasOwn(graphNodes, normalized.id)) {
      throw new AdoptInPlaceError("duplicate-node-id", `graph already contains node ${normalized.id}`);
    }
    graphNodes[normalized.id] = normalized;
  }

  return freezeGraph({ nodes: graphNodes });
}

export function createManagedResource({ id, type = "service", deps = [], binds = [] } = {}) {
  assertId(id, "managed resource");
  return deepFreeze({
    id,
    kind: "managed",
    type,
    deps: [...deps],
    binds: binds.map(normalizeBinding),
    lifecycle: {
      reconcile: "managed",
      destroy: "destroy",
    },
  });
}

export function createExternalResource({
  id,
  type,
  declaredOutputs = [],
  outputs = {},
  source,
  externalId,
  credential,
  credentialRef,
  federatedAlternative,
} = {}) {
  assertId(id, "external resource");
  if (!type) {
    throw new AdoptInPlaceError("invalid-external-resource", `external resource ${id} requires type`);
  }

  const normalizedCredential = normalizeCredential(
    credential ?? (credentialRef ? { mode: "static-key", ref: credentialRef, federatedAlternative } : undefined),
    id,
  );
  const resource = {
    id,
    kind: "external",
    type,
    declaredOutputs: uniqueStrings(declaredOutputs, `external resource ${id} declaredOutputs`),
    outputs: clonePlainObject(outputs, `external resource ${id} outputs`),
    source: normalizeSource(source ?? { kind: "byo", ref: id }),
    lifecycle: {
      reconcile: "read-only",
      destroy: "skip",
    },
  };
  if (externalId) {
    resource.externalId = String(externalId);
  }
  if (normalizedCredential) {
    resource.credential = normalizedCredential;
  }

  return deepFreeze(resource);
}

export function importIacState({ graph = createAdoptionGraph(), state, source, supportedTypes } = {}) {
  const current = normalizeGraph(graph);
  const normalizedState = normalizeIacState(state);
  const normalizedSource = normalizeSource(source);
  const supportedTypeSet = normalizeSupportedTypes(supportedTypes);
  const nodes = clonePlainObject(current.nodes, "graph nodes");
  const events = [];
  let changed = false;

  for (const resource of normalizedState.resources) {
    const imported =
      supportedTypeSet && !supportedTypeSet.has(resource.type)
        ? externalNodeFromState(resource, normalizedSource)
        : adoptedNodeFromState(resource, normalizedSource);
    const existing = nodes[imported.id];

    if (existing) {
      if (sameImportedNode(existing, imported)) {
        continue;
      }
      throw new AdoptInPlaceError(
        "import-id-collision",
        `imported resource ${imported.id} collides with existing ${existing.kind} node`,
        { resourceId: imported.id, existingKind: existing.kind },
      );
    }

    nodes[imported.id] = imported;
    changed = true;
    if (imported.kind === "adopted") {
      events.push(resourceAdoptedEvent(imported, normalizedSource));
    }
  }

  return deepFreeze({
    status: changed ? "imported" : "noop",
    graph: freezeGraph({ nodes }),
    events,
  });
}

export function planImportRoundTrip({ graph = createAdoptionGraph(), state, source, supportedTypes } = {}) {
  const result = importIacState({ graph, state, source, supportedTypes });

  return deepFreeze({
    status: result.status,
    graph: result.graph,
    actions: result.events.map((event) => ({
      action: "import",
      resourceId: event.data.resourceId,
      externalId: event.data.externalId,
      kind: "adopted",
    })),
  });
}

export function resolveBindings(graph, resourceId) {
  const normalized = normalizeGraph(graph);
  const consumer = normalized.nodes[resourceId];
  if (!consumer) {
    throw new AdoptInPlaceError("binding-consumer-missing", `binding consumer ${resourceId} is missing`);
  }

  const resolved = {};
  for (const binding of consumer.binds ?? []) {
    if (Object.hasOwn(resolved, binding.as)) {
      throw new AdoptInPlaceError(
        "binding-output-collision",
        `binding output ${binding.as} is produced by more than one resource`,
      );
    }

    const source = normalized.nodes[binding.from];
    if (!source) {
      throw new AdoptInPlaceError("binding-source-missing", `binding source ${binding.from} is missing`);
    }

    assertOutputAvailable(source, binding.output);
    resolved[binding.as] = structuredClone(source.outputs[binding.output]);
  }

  return deepFreeze(resolved);
}

export function planReconcile({ graph } = {}) {
  const normalized = normalizeGraph(graph);
  const actions = sortedNodes(normalized)
    .filter((node) => node.kind === "adopted")
    .map((node) => ({
      action: "refresh",
      resourceId: node.id,
      mode: "drift-detect-only",
    }));

  return deepFreeze({ actions });
}

export function detectAdoptedDrift({ graph, observedOutputs = {} } = {}) {
  const normalized = normalizeGraph(graph);
  const records = [];

  for (const node of sortedNodes(normalized)) {
    if (node.kind !== "adopted" || !Object.hasOwn(observedOutputs, node.id)) {
      continue;
    }

    const observed = clonePlainObject(observedOutputs[node.id], `observed outputs for ${node.id}`);
    const changedOutputs = Object.keys({ ...node.outputs, ...observed })
      .filter((key) => stableJson(node.outputs[key]) !== stableJson(observed[key]))
      .sort();

    if (changedOutputs.length > 0) {
      records.push({
        resourceId: node.id,
        mode: "detect-only",
        changedOutputs,
        remediation: "manual",
      });
    }
  }

  return deepFreeze({
    records,
    actions: records.map((record) => ({
      action: "record-drift",
      resourceId: record.resourceId,
      mode: "detect-only",
    })),
  });
}

export function planDestroy(graph) {
  const normalized = normalizeGraph(graph);
  const actions = sortedNodes(normalized)
    .filter((node) => node.kind === "managed")
    .map((node) => ({ action: "destroy", resourceId: node.id }));
  const skipped = sortedNodes(normalized)
    .filter((node) => node.kind === "adopted" || node.kind === "external")
    .map((node) => ({
      resourceId: node.id,
      kind: node.kind,
      reason: node.kind === "adopted" ? "adopted resources are retained" : "external resources are unmanaged",
    }));

  return deepFreeze({ actions, skipped });
}

export function planBrownfieldDeployment({ graph, resourceId } = {}) {
  const normalized = normalizeGraph(graph);
  const resource = normalized.nodes[resourceId];
  if (!resource) {
    throw new AdoptInPlaceError("deployment-resource-missing", `deployment resource ${resourceId} is missing`);
  }
  if (resource.kind !== "managed") {
    throw new AdoptInPlaceError(
      "deployment-resource-unmanaged",
      `deployment resource ${resourceId} must be a managed node`,
      { resourceId, kind: resource.kind },
    );
  }

  return deepFreeze({
    status: "deployable",
    actions: [
      {
        action: "deploy",
        resourceId,
        bindings: resolveBindings(normalized, resourceId),
      },
    ],
    skipped: sortedNodes(normalized)
      .filter((node) => node.kind === "adopted" || node.kind === "external")
      .map((node) => ({
        resourceId: node.id,
        kind: node.kind,
        reason: node.kind === "adopted" ? "adopted resources are drift-detect only" : "external resources are unmanaged",
      })),
  });
}

export function createPortabilityPlanFromGraph(
  graph,
  { planId = "adopt-in-place-brownfield-plan", targetProviders = ["aws", "azure"] } = {},
) {
  const normalized = normalizeGraph(graph);

  return deepFreeze({
    id: String(planId),
    targetProviders: uniqueStrings(targetProviders, "portability targetProviders"),
    resources: sortedNodes(normalized).map((node) => ({
      id: node.id,
      type: node.type,
      provider: providerForNode(node),
      nonPortableEvidence: portabilityEvidenceForNode(node),
    })),
  });
}

export function graphDigest(graph) {
  return `sha256:${createHash("sha256").update(stableJson(normalizeGraph(graph))).digest("hex")}`;
}

function adoptedNodeFromState(resource, source) {
  const importHash = stableDigest({
    externalId: resource.externalId,
    outputs: resource.outputs,
    source,
    state: resource.state,
    type: resource.type,
  });

  return deepFreeze({
    id: resource.id,
    kind: "adopted",
    type: resource.type,
    externalId: resource.externalId,
    outputs: structuredClone(resource.outputs),
    source,
    importHash,
    lifecycle: {
      reconcile: "drift-detect-only",
      destroy: "retain",
    },
  });
}

function externalNodeFromState(resource, source) {
  return createExternalResource({
    id: resource.id,
    type: resource.type,
    declaredOutputs: Object.keys(resource.outputs),
    outputs: resource.outputs,
    source,
    externalId: resource.externalId,
  });
}

function resourceAdoptedEvent(node, source) {
  return deepFreeze({
    schema: ADOPT_IN_PLACE_CONTRACT_VERSION,
    type: "resource.Adopted",
    data: {
      resourceId: node.id,
      externalId: node.externalId,
      source,
    },
  });
}

function assertOutputAvailable(source, output) {
  if (source.kind === "external" && !source.declaredOutputs.includes(output)) {
    throw new AdoptInPlaceError(
      "external-output-undeclared",
      `external resource ${source.id} does not declare output ${output}`,
      { resourceId: source.id, output },
    );
  }
  if (!Object.hasOwn(source.outputs ?? {}, output)) {
    const code = source.kind === "external" ? "external-output-missing" : "binding-output-missing";
    throw new AdoptInPlaceError(code, `resource ${source.id} has no output ${output}`, {
      resourceId: source.id,
      output,
    });
  }
}

function sameAdoptedNode(existing, next) {
  return existing.kind === "adopted" && existing.externalId === next.externalId && existing.importHash === next.importHash;
}

function sameImportedNode(existing, next) {
  if (next.kind === "adopted") {
    return sameAdoptedNode(existing, next);
  }
  return existing.kind === "external" && stableJson(existing) === stableJson(next);
}

function normalizeGraph(graph) {
  if (!graph || !isPlainObject(graph.nodes)) {
    throw new AdoptInPlaceError("invalid-graph", "adoption graph requires a nodes object");
  }

  return freezeGraph({ nodes: clonePlainObject(graph.nodes, "graph nodes") });
}

function freezeGraph({ nodes }) {
  const normalizedNodes = {};
  for (const [id, node] of Object.entries(nodes).sort(([left], [right]) => left.localeCompare(right))) {
    normalizedNodes[id] = normalizeNode(node);
  }

  return deepFreeze({
    schema: ADOPT_IN_PLACE_CONTRACT_VERSION,
    nodes: normalizedNodes,
  });
}

function normalizeNode(node) {
  if (!node || !node.kind || !node.id) {
    throw new AdoptInPlaceError("invalid-node", "graph nodes require id and kind");
  }
  if (!KIND_PRIORITY.has(node.kind)) {
    throw new AdoptInPlaceError("invalid-node-kind", `unsupported node kind ${node.kind}`);
  }

  if (node.kind === "managed") {
    return createManagedResource({
      id: node.id,
      type: node.type,
      deps: node.deps ?? [],
      binds: node.binds ?? [],
    });
  }
  if (node.kind === "external") {
    return createExternalResource({
      id: node.id,
      type: node.type,
      declaredOutputs: node.declaredOutputs ?? [],
      outputs: node.outputs ?? {},
      source: node.source ?? { kind: "byo", ref: node.id },
      externalId: node.externalId,
      credential: node.credential,
    });
  }

  return deepFreeze({
    id: node.id,
    kind: "adopted",
    type: node.type,
    externalId: node.externalId,
    outputs: clonePlainObject(node.outputs ?? {}, `adopted resource ${node.id} outputs`),
    source: normalizeSource(node.source),
    importHash: node.importHash,
    lifecycle: {
      reconcile: "drift-detect-only",
      destroy: "retain",
    },
  });
}

function normalizeIacState(state) {
  if (!state || !Array.isArray(state.resources)) {
    throw new AdoptInPlaceError("invalid-iac-state", "IaC state requires a resources array");
  }

  return deepFreeze({
    kind: state.kind ?? "iac-state",
    resources: state.resources.map((resource) => {
      assertId(resource.id, "imported resource");
      if (!resource.externalId) {
        throw new AdoptInPlaceError("invalid-iac-state", `imported resource ${resource.id} requires externalId`);
      }
      if (!resource.type) {
        throw new AdoptInPlaceError("invalid-iac-state", `imported resource ${resource.id} requires type`);
      }

      return {
        id: resource.id,
        type: resource.type,
        externalId: resource.externalId,
        outputs: clonePlainObject(resource.outputs ?? {}, `imported resource ${resource.id} outputs`),
        state: structuredClone(resource.state ?? {}),
      };
    }),
  });
}

function normalizeSource(source) {
  if (!source || !source.kind || !source.ref) {
    throw new AdoptInPlaceError("invalid-source", "import source requires kind and ref");
  }
  return deepFreeze({
    kind: String(source.kind),
    ref: String(source.ref),
  });
}

function normalizeCredential(credential, resourceId) {
  if (credential === undefined || credential === null) {
    return undefined;
  }
  if (credential.mode !== "static-key" || !credential.ref) {
    throw new AdoptInPlaceError(
      "invalid-external-credential",
      `external resource ${resourceId} credential requires static-key mode and ref`,
    );
  }

  return deepFreeze({
    mode: "static-key",
    ref: String(credential.ref),
    federatedAlternative: String(credential.federatedAlternative ?? "brokered-credential"),
  });
}

function normalizeBinding(binding) {
  if (!binding?.from || !binding.output || !binding.as) {
    throw new AdoptInPlaceError("invalid-binding", "binding requires from, output, and as");
  }
  return deepFreeze({
    from: String(binding.from),
    output: String(binding.output),
    as: String(binding.as),
  });
}

function sortedNodes(graph) {
  return Object.values(graph.nodes).sort((left, right) => {
    const kind = KIND_PRIORITY.get(left.kind) - KIND_PRIORITY.get(right.kind);
    return kind === 0 ? left.id.localeCompare(right.id) : kind;
  });
}

function normalizeSupportedTypes(supportedTypes) {
  if (supportedTypes === undefined || supportedTypes === null) {
    return null;
  }
  return new Set(uniqueStrings(supportedTypes, "supportedTypes"));
}

function providerForNode(node) {
  if (node.kind === "managed") {
    return "portable-fixture";
  }
  return node.kind;
}

function portabilityEvidenceForNode(node) {
  const evidence = [];
  if (node.kind === "external") {
    evidence.push({
      category: "external-dependency",
      dependencyKind: "external",
      target: brownfieldTarget(node),
    });
  }
  if (node.kind === "adopted") {
    evidence.push({
      category: "adopted-dependency",
      dependencyKind: "adopted",
      target: brownfieldTarget(node),
    });
  }
  if (node.credential?.mode === "static-key") {
    evidence.push({
      category: "static-key",
      credentialRef: node.credential.ref,
      federatedAlternative: node.credential.federatedAlternative,
    });
  }

  return evidence;
}

function brownfieldTarget(node) {
  return node.externalId ?? `${node.source.kind}://${node.source.ref}#${node.id}`;
}

function stableDigest(value) {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && isJsonObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function clonePlainObject(value, label) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new AdoptInPlaceError("invalid-object", `${label} must be an object`);
  }
  return structuredClone(value);
}

function isPlainObject(value) {
  return Boolean(value) && isJsonObject(value) && !Array.isArray(value);
}

function uniqueStrings(values, label) {
  if (!Array.isArray(values)) {
    throw new AdoptInPlaceError("invalid-list", `${label} must be an array`);
  }
  return [...new Set(values.map((value) => String(value)))].sort();
}

function assertId(id, label) {
  if (!id || !isJsonString(id)) {
    throw new AdoptInPlaceError("invalid-id", `${label} requires a string id`);
  }
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}
