import { createHash } from "node:crypto";

import {
  canonicalJson,
  createDecision,
  createDecisionRequest,
  createPolicyDecidedEvent,
} from "../../hobo-policy-ir-contract/src/policy-ir.js";
import { isJsonString, isJsonObject } from "./json.js";


export const DATA_GOVERNANCE_POLICY_ENGINE_ID = "hobo.data-governance-policy/contract@0.1.0";
export const DATA_GOVERNANCE_POLICY_SCHEMA_VERSION = "hobo.data-governance-policy/v1";

const CLASSIFICATION_RANK = new Map([
  ["public", 0],
  ["internal", 1],
  ["pii", 2],
  ["phi", 3],
  ["pci", 3],
  ["secret", 4],
]);

const RESOLVED_COVERAGE_STATUSES = new Set(["accepted", "resolved", "closed"]);

export function evaluateDataGovernancePolicy(input) {
  const source = expectObject(input, "input");
  const request = createDecisionRequest(source.request);
  const policy = normalizePolicy(source.policy);
  const classifiedData = normalizeClassifiedData(source.classifiedData ?? []);
  const placement = normalizeOptionalObject(source.placement, "input.placement");
  const runtimeAction = normalizeRuntimeAction(source.runtimeAction);
  const retentionRequest = normalizeRetentionRequest(source.retentionRequest);
  const subprocessorRegistry = normalizeSubprocessorRegistry(source.subprocessorRegistry ?? []);
  const coverageFindings = normalizeCoverageFindings(source.coverageFindings ?? []);
  const requestDataClassifications = readRequestDataClassifications(request);
  const requestRegion = optionalStringField(request.context.region, "request.context.region");
  const classificationContext = buildClassificationContext({
    classifiedData,
    placement,
    runtimeAction,
    requestDataClassifications,
    requestRegion,
  });

  const state = {
    request,
    policy,
    classifiedData,
    requestDataClassifications,
    classificationContext,
    runtimeAction,
    retentionRequest,
    subprocessorRegistry,
    coverageFindings,
    violations: [],
    mutations: [],
    obligations: [],
    events: [],
    evaluations: [],
    coverageFailed: false,
    residencyFailed: false,
    retentionFailed: false,
    subprocessorFailed: false,
    runtimeBoundaryFailed: false,
  };

  evaluateClassificationSource(state);
  evaluateCoverageFindings(state);
  evaluateRuntimeBoundary(state);
  evaluateResidency(state);
  evaluateRetention(state);
  evaluateSubprocessor(state);

  const decision = createDecision(request, {
    effect: chooseEffect(state),
    reason: chooseReason(state),
    violations: state.violations,
    mutations: state.mutations,
    obligations: state.obligations,
    evidence: {
      engine: DATA_GOVERNANCE_POLICY_ENGINE_ID,
      policyIds: [policy.id],
    },
  });

  const policyEvent = createAuditedPolicyEvent({
    request,
    decision,
    policy,
    classifiedData,
    classificationContext,
  });

  return {
    schemaVersion: DATA_GOVERNANCE_POLICY_SCHEMA_VERSION,
    request,
    classificationContext,
    decision,
    events: [policyEvent, ...state.events],
    evaluations: state.evaluations,
  };
}

function evaluateClassificationSource(state) {
  const factClassifications = new Set(state.classifiedData.map((fact) => fact.classification));
  const missingClassifications = state.requestDataClassifications.filter(
    (classification) => !factClassifications.has(classification),
  );
  if (missingClassifications.length === 0) {
    return;
  }

  state.coverageFailed = true;
  state.violations.push(
    `${state.policy.id}: request classified as ${missingClassifications.join(", ")} has no matching data.Classified source fact`,
  );
  state.events.push(
    createGovernanceEvent("dataGovernance.ClassificationSourceMissing", state, {
      dataClassifications: missingClassifications,
      blocked: true,
    }),
  );
}

function evaluateCoverageFindings(state) {
  for (const finding of state.coverageFindings) {
    if (RESOLVED_COVERAGE_STATUSES.has(finding.status)) {
      continue;
    }
    const declaredRank = CLASSIFICATION_RANK.get(finding.declaredClassification);
    const detectedRank = CLASSIFICATION_RANK.get(finding.detectedClassification);
    if (detectedRank <= declaredRank) {
      continue;
    }

    state.coverageFailed = true;
    state.violations.push(
      `${state.policy.id}: ${finding.resourceId} declared ${finding.declaredClassification} but detected ${finding.detectedClassification}`,
    );
    state.events.push(
      createGovernanceEvent("dataGovernance.CoverageMismatch", state, {
        resourceId: finding.resourceId,
        declaredClassification: finding.declaredClassification,
        detectedClassification: finding.detectedClassification,
        status: finding.status,
        blocked: true,
      }),
    );
  }
}

function evaluateRuntimeBoundary(state) {
  if (!state.runtimeAction || state.request.phase !== "runtime") {
    return;
  }
  if (state.runtimeAction.endpointCompliance !== "non-compliant") {
    return;
  }

  state.runtimeBoundaryFailed = true;
  state.violations.push(
    `${state.policy.id}: runtime ${state.runtimeAction.kind} endpoint is non-compliant for classified data`,
  );
  state.events.push(
    createGovernanceEvent("dataGovernance.RuntimeBoundaryEvaluated", state, {
      actionKind: state.runtimeAction.kind,
      destinationRegion: state.runtimeAction.destinationRegion,
      endpointCompliance: state.runtimeAction.endpointCompliance,
      blocked: true,
    }),
  );
}

function evaluateResidency(state) {
  const requestedRegion = readRequestedRegion(state);
  for (const fact of state.classifiedData) {
    const evaluation = {
      policyId: state.policy.id,
      resourceId: fact.resourceId,
      classification: fact.classification,
      requestedRegion,
      allowedRegions: fact.allowedRegions,
    };
    state.evaluations.push(evaluation);

    if (!requestedRegion) {
      state.residencyFailed = true;
      state.violations.push(`${state.policy.id}: ${fact.resourceId} has no region for residency evaluation`);
      state.events.push(
        createGovernanceEvent("dataGovernance.ResidencyEvaluated", state, {
          ...evaluation,
          blocked: true,
        }),
      );
      continue;
    }

    if (regionAllowed(fact.allowedRegions, requestedRegion)) {
      state.events.push(
        createGovernanceEvent("dataGovernance.ResidencyEvaluated", state, {
          ...evaluation,
          blocked: false,
        }),
      );
      continue;
    }

    const mutation = createRegionPinMutation(state.runtimeAction, fact);
    if (mutation) {
      state.mutations.push(mutation);
      state.obligations.push({
        kind: "governance.runtime-region-pinned",
        resourceId: fact.resourceId,
        classification: fact.classification,
        requestedRegion,
        pinnedRegion: mutation.toRegion,
      });
      state.events.push(
        createGovernanceEvent("dataGovernance.ResidencyEvaluated", state, {
          ...evaluation,
          blocked: false,
          mutationKind: mutation.kind,
          pinnedRegion: mutation.toRegion,
        }),
      );
      continue;
    }

    state.residencyFailed = true;
    state.violations.push(
      `${state.policy.id}: ${fact.classification} ${fact.resourceId} region ${requestedRegion} is outside allowed regions ${fact.allowedRegions.join(", ")}`,
    );
    state.events.push(
      createGovernanceEvent("dataGovernance.ResidencyEvaluated", state, {
        ...evaluation,
        blocked: true,
      }),
    );
  }
}

function evaluateRetention(state) {
  if (!state.retentionRequest) {
    return;
  }

  const facts = state.retentionRequest.resourceId
    ? state.classifiedData.filter((fact) => fact.resourceId === state.retentionRequest.resourceId)
    : state.classifiedData;
  if (facts.length === 0) {
    state.retentionFailed = true;
    state.violations.push(
      `${state.policy.id}: no data.Classified fact found for retention resource ${state.retentionRequest.resourceId}`,
    );
    return;
  }

  for (const fact of facts) {
    const eventDetails = {
      resourceId: fact.resourceId,
      classification: fact.classification,
      minDays: fact.retention.minDays,
      maxDays: fact.retention.maxDays,
      deleteAfterDays: state.retentionRequest.deleteAfterDays,
      retainForDays: state.retentionRequest.retainForDays,
      blocked: false,
    };

    if (
      state.retentionRequest.deleteAfterDays !== null &&
      state.retentionRequest.deleteAfterDays < fact.retention.minDays
    ) {
      state.retentionFailed = true;
      eventDetails.blocked = true;
      state.violations.push(
        `${state.policy.id}: ${fact.resourceId} deleteAfterDays ${state.retentionRequest.deleteAfterDays} is below retention floor ${fact.retention.minDays}`,
      );
    }

    if (
      state.retentionRequest.retainForDays !== null &&
      state.retentionRequest.retainForDays > fact.retention.maxDays
    ) {
      state.retentionFailed = true;
      eventDetails.blocked = true;
      state.violations.push(
        `${state.policy.id}: ${fact.resourceId} retainForDays ${state.retentionRequest.retainForDays} is past retention ceiling ${fact.retention.maxDays}`,
      );
    }

    state.events.push(createGovernanceEvent("dataGovernance.RetentionEvaluated", state, eventDetails));
  }
}

function evaluateSubprocessor(state) {
  if (!state.runtimeAction?.subprocessorId) {
    return;
  }

  const subprocessor = state.subprocessorRegistry.find(
    (candidate) => candidate.id === state.runtimeAction.subprocessorId,
  );
  const details = {
    subprocessorId: state.runtimeAction.subprocessorId,
    destinationRegion: state.runtimeAction.destinationRegion,
    dataClassifications: state.classificationContext.dataClassifications,
    blocked: false,
  };

  if (!subprocessor) {
    state.subprocessorFailed = true;
    details.blocked = true;
    state.violations.push(`${state.policy.id}: unregistered subprocessor ${state.runtimeAction.subprocessorId}`);
    state.events.push(createGovernanceEvent("dataGovernance.SubprocessorEvaluated", state, details));
    return;
  }

  const disallowedClassifications = state.classificationContext.dataClassifications.filter(
    (classification) => !subprocessor.allowedClassifications.includes(classification),
  );
  const region = state.runtimeAction.destinationRegion ?? state.classificationContext.region;
  const regionBlocked = region !== null && !regionAllowed(subprocessor.allowedRegions, region);

  if (disallowedClassifications.length > 0 || regionBlocked) {
    state.subprocessorFailed = true;
    details.blocked = true;
    state.violations.push(
      `${state.policy.id}: subprocessor ${subprocessor.id} is not registered for ${[
        ...disallowedClassifications,
        regionBlocked ? region : null,
      ]
        .filter(Boolean)
        .join(", ")}`,
    );
  }

  state.events.push(createGovernanceEvent("dataGovernance.SubprocessorEvaluated", state, details));
}

function chooseEffect(state) {
  if (state.violations.length > 0) {
    return "deny";
  }
  if (state.mutations.length > 0) {
    return "mutate";
  }
  return "allow";
}

function chooseReason(state) {
  if (state.coverageFailed) {
    return "classification coverage failed closed";
  }
  if (state.runtimeBoundaryFailed) {
    return "runtime boundary obligation failed";
  }
  if (state.subprocessorFailed) {
    return "subprocessor registry denied action";
  }
  if (state.retentionFailed) {
    return "retention window violates floor or ceiling";
  }
  if (state.residencyFailed) {
    return "data residency policy denied action";
  }
  if (state.mutations.length > 0) {
    return "runtime action region-pinned";
  }
  return "data governance policy passed";
}

function buildClassificationContext({
  classifiedData,
  placement,
  runtimeAction,
  requestDataClassifications,
  requestRegion,
}) {
  const classifications = [...requestDataClassifications];
  for (const fact of classifiedData) {
    classifications.push(fact.classification);
  }

  return {
    dataClassifications: dedupe(classifications),
    region: placement?.region ?? requestRegion ?? runtimeAction?.destinationRegion ?? null,
    jurisdiction: classifiedData[0]?.jurisdiction ?? null,
    resourceIds: classifiedData.map((fact) => fact.resourceId),
  };
}

function readRequestDataClassifications(request) {
  return parseOptionalStringArray(request.context.dataClassifications, "request.context.dataClassifications").map(
    (value) => normalizeClassification(value, "request.context.dataClassifications"),
  );
}

function createRegionPinMutation(runtimeAction, fact) {
  if (!runtimeAction || runtimeAction.allowRegionPinning !== true) {
    return null;
  }
  if (!runtimeAction.pinnedRegion || !regionAllowed(fact.allowedRegions, runtimeAction.pinnedRegion)) {
    return null;
  }
  if (!runtimeAction.pinnedEndpoint || runtimeAction.endpointCompliance !== "compliant") {
    return null;
  }
  return {
    kind: "governance.pin-runtime-region",
    fromRegion: runtimeAction.destinationRegion,
    toRegion: runtimeAction.pinnedRegion,
    endpoint: runtimeAction.pinnedEndpoint,
  };
}

function createAuditedPolicyEvent({ request, decision, policy, classifiedData, classificationContext }) {
  return {
    ...createPolicyDecidedEvent({
      request,
      decision,
      id: `policy-decided-${shortHash({ requestHash: request.inputHash, decision })}`,
    }),
    audit: {
      actorId: readActorId(request),
      policyIds: [policy.id],
      dataClassifications: classificationContext.dataClassifications,
      region: classificationContext.region,
      classifiedResourceIds: classifiedData.map((fact) => fact.resourceId),
    },
  };
}

function createGovernanceEvent(type, state, details) {
  const payload = {
    type,
    schemaVersion: DATA_GOVERNANCE_POLICY_SCHEMA_VERSION,
    policyId: state.policy.id,
    requestHash: state.request.inputHash,
    ...details,
  };

  return {
    id: `${type}:${shortHash(payload)}`,
    ...payload,
  };
}

function readRequestedRegion(state) {
  if (state.runtimeAction?.destinationRegion) {
    return state.runtimeAction.destinationRegion;
  }
  if (state.classificationContext.region) {
    return state.classificationContext.region;
  }
  return null;
}

function readActorId(request) {
  if (isJsonString(request.context.actorId) && request.context.actorId.length > 0) {
    return request.context.actorId;
  }
  if (isJsonString(request.subject.delegatedBy)) {
    return request.subject.delegatedBy;
  }
  if (request.subject.delegatedBy && isJsonObject(request.subject.delegatedBy)) {
    return `${request.subject.delegatedBy.kind}:${request.subject.delegatedBy.id}`;
  }
  return request.subject.id;
}

function normalizePolicy(input) {
  const policy = expectObject(input, "input.policy");
  return {
    id: requireString(policy.id, "input.policy.id"),
  };
}

function normalizeClassifiedData(input) {
  if (!Array.isArray(input)) {
    throw new TypeError("input.classifiedData must be an array");
  }
  return input.map((fact, index) => normalizeClassifiedFact(fact, `input.classifiedData[${index}]`));
}

function normalizeClassifiedFact(input, path) {
  const fact = expectObject(input, path);
  if (fact.type !== "data.Classified") {
    throw new TypeError(`${path}.type must be data.Classified`);
  }
  const classification = normalizeClassification(fact.classification, `${path}.classification`);
  return {
    type: "data.Classified",
    resourceId: requireString(fact.resourceId, `${path}.resourceId`),
    classification,
    jurisdiction: requireString(fact.jurisdiction, `${path}.jurisdiction`),
    allowedRegions: parseStringArray(fact.allowedRegions, `${path}.allowedRegions`),
    retention: normalizeRetentionPolicy(fact.retention, `${path}.retention`),
  };
}

function normalizeRetentionPolicy(input, path) {
  const retention = expectObject(input, path);
  const minDays = requireNonNegativeInteger(retention.minDays, `${path}.minDays`);
  const maxDays = requireNonNegativeInteger(retention.maxDays, `${path}.maxDays`);
  if (minDays > maxDays) {
    throw new RangeError(`${path}.minDays must be less than or equal to maxDays`);
  }
  return { minDays, maxDays };
}

function normalizeRuntimeAction(input) {
  if (input === undefined || input === null) {
    return null;
  }
  const action = expectObject(input, "input.runtimeAction");
  return {
    kind: requireString(action.kind, "input.runtimeAction.kind"),
    destinationRegion: optionalString(action.destinationRegion),
    subprocessorId: optionalString(action.subprocessorId),
    endpointCompliance: optionalString(action.endpointCompliance) ?? "unknown",
    allowRegionPinning: action.allowRegionPinning === true,
    pinnedRegion: optionalString(action.pinnedRegion),
    pinnedEndpoint: optionalString(action.pinnedEndpoint),
  };
}

function normalizeRetentionRequest(input) {
  if (input === undefined || input === null) {
    return null;
  }
  const request = expectObject(input, "input.retentionRequest");
  return {
    resourceId: optionalString(request.resourceId),
    deleteAfterDays: optionalNonNegativeInteger(request.deleteAfterDays, "input.retentionRequest.deleteAfterDays"),
    retainForDays: optionalNonNegativeInteger(request.retainForDays, "input.retentionRequest.retainForDays"),
  };
}

function normalizeSubprocessorRegistry(input) {
  if (!Array.isArray(input)) {
    throw new TypeError("input.subprocessorRegistry must be an array");
  }
  return input.map((candidate, index) => {
    const subprocessor = expectObject(candidate, `input.subprocessorRegistry[${index}]`);
    return {
      id: requireString(subprocessor.id, `input.subprocessorRegistry[${index}].id`),
      allowedRegions: parseStringArray(
        subprocessor.allowedRegions,
        `input.subprocessorRegistry[${index}].allowedRegions`,
      ),
      allowedClassifications: parseStringArray(
        subprocessor.allowedClassifications,
        `input.subprocessorRegistry[${index}].allowedClassifications`,
      ).map((value) =>
        normalizeClassification(value, `input.subprocessorRegistry[${index}].allowedClassifications`),
      ),
    };
  });
}

function normalizeCoverageFindings(input) {
  if (!Array.isArray(input)) {
    throw new TypeError("input.coverageFindings must be an array");
  }
  return input.map((candidate, index) => {
    const finding = expectObject(candidate, `input.coverageFindings[${index}]`);
    if (finding.type !== "data.ClassificationCoverageFinding") {
      throw new TypeError(`input.coverageFindings[${index}].type must be data.ClassificationCoverageFinding`);
    }
    return {
      type: "data.ClassificationCoverageFinding",
      resourceId: requireString(finding.resourceId, `input.coverageFindings[${index}].resourceId`),
      declaredClassification: normalizeClassification(
        finding.declaredClassification,
        `input.coverageFindings[${index}].declaredClassification`,
      ),
      detectedClassification: normalizeClassification(
        finding.detectedClassification,
        `input.coverageFindings[${index}].detectedClassification`,
      ),
      status: requireString(finding.status, `input.coverageFindings[${index}].status`),
    };
  });
}

function normalizeOptionalObject(input, fieldName) {
  if (input === undefined || input === null) {
    return null;
  }
  const value = expectObject(input, fieldName);
  return {
    ...value,
    region: optionalString(value.region),
  };
}

function normalizeClassification(input, fieldName) {
  const classification = requireString(input, fieldName).toLowerCase();
  if (!CLASSIFICATION_RANK.has(classification)) {
    throw new TypeError(`${fieldName} must be one of ${[...CLASSIFICATION_RANK.keys()].join(", ")}`);
  }
  return classification;
}

function regionAllowed(allowedRegions, region) {
  return allowedRegions.includes("global") || allowedRegions.includes(region);
}

function dedupe(values) {
  return [...new Set(values)];
}

function parseStringArray(input, fieldName) {
  if (!Array.isArray(input)) {
    throw new TypeError(`${fieldName} must be an array`);
  }
  return input.map((value, index) => requireString(value, `${fieldName}[${index}]`));
}

function parseOptionalStringArray(input, fieldName) {
  if (input === undefined || input === null) {
    return [];
  }
  if (!Array.isArray(input)) {
    throw new TypeError(`${fieldName} must be an array`);
  }
  return input.map((value, index) => requireString(value, `${fieldName}[${index}]`));
}

function optionalString(input) {
  if (input === undefined || input === null || input === "") {
    return null;
  }
  if (!isJsonString(input)) {
    throw new TypeError("expected optional string");
  }
  return input;
}

function optionalStringField(input, fieldName) {
  if (input === undefined || input === null || input === "") {
    return null;
  }
  if (!isJsonString(input)) {
    throw new TypeError(`${fieldName} must be a string`);
  }
  return input;
}

function optionalNonNegativeInteger(input, fieldName) {
  if (input === undefined || input === null) {
    return null;
  }
  return requireNonNegativeInteger(input, fieldName);
}

function requireNonNegativeInteger(input, fieldName) {
  if (!Number.isInteger(input) || input < 0) {
    throw new TypeError(`${fieldName} must be a non-negative integer`);
  }
  return input;
}

function requireString(input, fieldName) {
  if (!isJsonString(input) || input.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return input;
}

function expectObject(input, fieldName) {
  if (!input || !isJsonObject(input) || Array.isArray(input)) {
    throw new TypeError(`${fieldName} must be an object`);
  }
  return input;
}

function shortHash(input) {
  return createHash("sha256").update(canonicalJson(input)).digest("hex").slice(0, 16);
}
