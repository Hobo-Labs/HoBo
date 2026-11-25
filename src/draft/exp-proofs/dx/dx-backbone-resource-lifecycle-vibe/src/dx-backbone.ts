import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";
export const REQUIRED_DESIGN_ANCHORS = [
  "docs/design/developer-experience.md#plan-07",
  "docs/design/sdk-api.md#plan-02",
  "docs/design/control-plane.md#plan-04",
  "docs/design/platform-engineering.md#plan-25",
  "docs/design/data-plane.md#plan-11",
] as const;

export const REQUIRED_PROOF_MODES = ["live", "simulated", "reference fixture", "scope-out"] as const;

const REQUIRED_CHILD_ISSUES = [
  "HOBO-567",
  "HOBO-568",
  "HOBO-569",
  "HOBO-570",
  "HOBO-571",
  "HOBO-572",
  "HOBO-573",
  "HOBO-574",
  "HOBO-575",
  "HOBO-576",
  "HOBO-577",
] as const;

const REQUIRED_COVERAGE = [
  "api-shape",
  "cli-mcp-shape",
  "deploy-transcript",
  "deterministic-fixtures",
  "manage-transcript",
  "migration-transcript",
  "proof-mode-labels",
  "quickstart",
  "result-envelope",
  "scenario-matrix",
  "sdk-shape",
  "support-handoff",
] as const;

type DesignAnchorSource = (typeof REQUIRED_DESIGN_ANCHORS)[number];
type ProofMode = (typeof REQUIRED_PROOF_MODES)[number];
type Coverage = (typeof REQUIRED_COVERAGE)[number];
type Phase = "M1" | "M2";

// domain-view: parse-produced draft-proof record; its wire form is the DesignAnchor proto message in data-models/.
interface DesignAnchor {
  source: DesignAnchorSource;
  reason: string;
}

type ExperienceType = "dx" | "ux" | "cx" | "ax" | "api";
type ExpProofPackagePath = `src/draft/exp-proofs/${ExperienceType}/${string}`;

// domain-view: parse-produced draft-proof record; its wire form is the ChildSlice proto message in data-models/.
interface ChildSlice {
  issue: `HOBO-${number}`;
  title: string;
  phase: Phase;
  targetPackage: ExpProofPackagePath;
  proofNote: `docs/design/proofs/${string}/README.md`;
  coverage: Coverage[];
  dependsOn: `HOBO-${number}`[];
  scopeOut: string[];
}

// domain-view: parse-produced draft-proof record; its wire form is the DownstreamConsumerGate proto message in data-models/.
interface DownstreamConsumerGate {
  consumer: string;
  mustConsume: `HOBO-${number}`[];
  sourceMaterial: string;
  inventBehavior: boolean;
}

// domain-view: parse-produced draft-proof record; its wire form is the DxBackboneRecord proto message in data-models/.
interface DxBackboneRecord {
  issue: "HOBO-566";
  targetPackage: "src/draft/exp-proofs/dx/dx-backbone-resource-lifecycle-vibe";
  proofNote: "docs/design/proofs/dx-backbone-resource-lifecycle-vibe/README.md";
  designAnchors: DesignAnchor[];
  proofModes: ProofMode[];
  childSlices: ChildSlice[];
  downstreamGates: DownstreamConsumerGate[];
  scopeOut: string[];
}

export type ParsedDxBackboneRecord = DxBackboneRecord & { readonly __parsed: unique symbol };

const M1_FOUNDATION_ISSUES = ["HOBO-567", "HOBO-568", "HOBO-569", "HOBO-570", "HOBO-571", "HOBO-572"] as const;

export const DOWNSTREAM_CONSUMER_GATES: DownstreamConsumerGate[] = [
  consumerGate("Docs Portal"),
  consumerGate("Tutorials & Walkthroughs"),
  consumerGate("Troubleshooting Guides"),
  consumerGate("V1 Launch Site, Messaging & Demo Assets"),
  consumerGate("Workspace & Onboarding UX"),
  consumerGate("Plan/Diff Viewer"),
  consumerGate("Deployment Dashboard & Topology Explorer"),
  consumerGate("Marketplace UX"),
  consumerGate("Support Workflow"),
  consumerGate("Accessibility & Usability Quality"),
];

const TYPED_EXP_PROOF_PATH = /^src\/draft\/exp-proofs\/(dx|ux|cx|ax|api)\/[a-z0-9-]+$/u;

export const DX_BACKBONE_RECORD: DxBackboneRecord = {
  issue: "HOBO-566",
  targetPackage: "src/draft/exp-proofs/dx/dx-backbone-resource-lifecycle-vibe",
  proofNote: "docs/design/proofs/dx-backbone-resource-lifecycle-vibe/README.md",
  designAnchors: [
    {
      source: "docs/design/developer-experience.md#plan-07",
      reason: "Defines terminal-first lifecycle commands, MCP parity, projection reads, and proof-mode honesty.",
    },
    {
      source: "docs/design/sdk-api.md#plan-02",
      reason: "Defines WIT-first SDK object graph, thin idiom layer, manifest IR, and generated type expectations.",
    },
    {
      source: "docs/design/control-plane.md#plan-04",
      reason: "Defines DeploymentPlan, ResourceActor, Gatekeeper, Gateway, and API/MCP ingress constraints.",
    },
    {
      source: "docs/design/platform-engineering.md#plan-25",
      reason: "Defines Deployment Sets, Deltas, matching, Gatekeeper application, import/adopt, and migration gating.",
    },
    {
      source: "docs/design/data-plane.md#plan-11",
      reason: "Defines event families, projection reads, migration events, and support/audit facts consumed by DX fixtures.",
    },
  ],
  proofModes: [...REQUIRED_PROOF_MODES],
  childSlices: [
    childSlice({
      issue: "HOBO-567",
      title: "DX scenario matrix for deploy, manage, and migrate resources",
      phase: "M1",
      experienceType: "dx",
      slug: "dx-resource-lifecycle-scenario-matrix",
      coverage: ["scenario-matrix", "api-shape", "sdk-shape", "cli-mcp-shape", "support-handoff", "proof-mode-labels"],
      dependsOn: ["HOBO-566"],
      scopeOut: ["production CLI/API/SDK", "live providers", "real credentials", "customer data"],
    }),
    childSlice({
      issue: "HOBO-568",
      title: "@hobo/bindles SDK object graph and manifest IR consumer examples",
      phase: "M1",
      experienceType: "api",
      slug: "sdk-object-graph-manifest-ir-shapes",
      coverage: ["sdk-shape", "api-shape", "deterministic-fixtures", "proof-mode-labels"],
      dependsOn: ["HOBO-566", "HOBO-567"],
      scopeOut: ["published @hobo/bindles package", "production bindings", "live cloud calls"],
    }),
    childSlice({
      issue: "HOBO-569",
      title: "Control-plane API shapes for DeploymentPlan, DeploymentSet, Delta, and migration",
      phase: "M1",
      experienceType: "api",
      slug: "control-plane-api-resource-lifecycle-shapes",
      coverage: ["api-shape", "result-envelope", "deterministic-fixtures", "proof-mode-labels"],
      dependsOn: ["HOBO-566", "HOBO-567"],
      scopeOut: ["production REST", "real persistence", "live provider adapters", "Planner/Gatekeeper bypass"],
    }),
    childSlice({
      issue: "HOBO-570",
      title: "CLI/MCP parity contracts for plan, up, collect, inspect, logs, doctor",
      phase: "M1",
      experienceType: "ax",
      slug: "cli-mcp-parity-resource-lifecycle-contracts",
      coverage: ["cli-mcp-shape", "api-shape", "proof-mode-labels", "deterministic-fixtures"],
      dependsOn: ["HOBO-566", "HOBO-567", "HOBO-568", "HOBO-569"],
      scopeOut: ["production argument parser", "live auth broker", "live MCP server"],
    }),
    childSlice({
      issue: "HOBO-571",
      title: "Typed result, gate, refusal, and proof-mode envelope examples",
      phase: "M1",
      experienceType: "dx",
      slug: "dx-result-refusal-proof-envelopes",
      coverage: ["result-envelope", "support-handoff", "proof-mode-labels", "deterministic-fixtures"],
      dependsOn: ["HOBO-566", "HOBO-567", "HOBO-569", "HOBO-570"],
      scopeOut: ["final product copy", "live support routing", "production telemetry", "optimistic success without evidence"],
    }),
    childSlice({
      issue: "HOBO-572",
      title: "Deterministic resource lifecycle fixture corpus for DX examples",
      phase: "M1",
      experienceType: "dx",
      slug: "dx-resource-lifecycle-fixture-corpus",
      coverage: ["deterministic-fixtures", "api-shape", "sdk-shape", "cli-mcp-shape", "proof-mode-labels"],
      dependsOn: ["HOBO-566", "HOBO-567", "HOBO-568", "HOBO-569"],
      scopeOut: ["live providers", "customer data", "real secrets", "one-off mockup fixtures"],
    }),
    childSlice({
      issue: "HOBO-573",
      title: "CLI deploy transcript prototype over DeploymentPlan and Gatekeeper fixtures",
      phase: "M2",
      experienceType: "dx",
      slug: "cli-deploy-transcript-prototype",
      coverage: ["deploy-transcript", "cli-mcp-shape", "support-handoff", "proof-mode-labels"],
      dependsOn: [...M1_FOUNDATION_ISSUES],
      scopeOut: ["production hobo up", "live provider apply", "real account login", "launch demo claims"],
    }),
    childSlice({
      issue: "HOBO-574",
      title: "CLI manage transcript prototype for inspect, logs, drift, and support bundles",
      phase: "M2",
      experienceType: "dx",
      slug: "cli-manage-inspect-logs-drift-prototype",
      coverage: ["manage-transcript", "cli-mcp-shape", "result-envelope", "support-handoff", "proof-mode-labels"],
      dependsOn: [...M1_FOUNDATION_ISSUES],
      scopeOut: ["production observability", "live log streaming", "real support tooling", "customer data"],
    }),
    childSlice({
      issue: "HOBO-575",
      title: "CLI migration transcript prototype for import, adopt-in-place, expand/backfill/contract, cutover",
      phase: "M2",
      experienceType: "dx",
      slug: "cli-migration-transcript-prototype",
      coverage: ["migration-transcript", "cli-mcp-shape", "sdk-shape", "api-shape", "result-envelope", "proof-mode-labels"],
      dependsOn: [...M1_FOUNDATION_ISSUES],
      scopeOut: ["real Terraform import", "live databases", "cross-engine auto-remodelling", "hand-written down migrations"],
    }),
    childSlice({
      issue: "HOBO-576",
      title: "SDK-to-CLI golden path compile consumer and terminal transcript",
      phase: "M2",
      experienceType: "api",
      slug: "sdk-to-cli-golden-path",
      coverage: ["sdk-shape", "cli-mcp-shape", "deploy-transcript", "result-envelope", "support-handoff", "proof-mode-labels"],
      dependsOn: [...M1_FOUNDATION_ISSUES],
      scopeOut: ["production app scaffold", "real deploy URL", "package publication", "live MCP server"],
    }),
    childSlice({
      issue: "HOBO-577",
      title: "Resource lifecycle quickstart examples for docs, tutorials, and launch demo",
      phase: "M2",
      experienceType: "dx",
      slug: "resource-lifecycle-quickstart-examples",
      coverage: ["quickstart", "deploy-transcript", "manage-transcript", "migration-transcript", "support-handoff", "proof-mode-labels"],
      dependsOn: ["HOBO-573", "HOBO-574", "HOBO-575", "HOBO-576"],
      scopeOut: ["marketing copy without transcripts", "customer promises", "live credentials", "production docs publication"],
    }),
  ],
  downstreamGates: DOWNSTREAM_CONSUMER_GATES,
  scopeOut: [
    "production CLI implementation",
    "production API implementation",
    "production SDK implementation",
    "live provider calls",
    "customer data",
    "real credentials",
    "public launch claims",
    "UI-first dashboard mockups that invent behavior not present in DX shapes",
  ],
};

export function parseDxBackboneRecord(record: JsonValue): ParsedDxBackboneRecord {
  const result = validateDxBackboneRecord(record);
  if (!result.ok) {
    throw new TypeError(result.errors.join("; "));
  }

  // SAFETY: `return Object.freeze(record as DxBackboneRecord) as ParsedDxBackboneRecord;` is required at this I/O or test boundary.
  return Object.freeze(record as DxBackboneRecord) as ParsedDxBackboneRecord;
}

export interface BackboneValidation {
  ok: boolean;
  errors: string[];
}

export interface BackboneClassification {
  owner: string;
  inScope: boolean;
}

export function validateDxBackboneRecord(record: JsonValue): BackboneValidation {
  const errors: string[] = [];
  if (!isRecord(record)) {
    return { ok: false, errors: ["DX backbone record is required"] };
  }

  const candidate = record;
  if (candidate.issue !== "HOBO-566") {
    errors.push("issue must be HOBO-566");
  }
  if (candidate.targetPackage !== "src/draft/exp-proofs/dx/dx-backbone-resource-lifecycle-vibe") {
    errors.push("target package must be the HOBO-566 exp proof");
  }
  if (candidate.proofNote !== "docs/design/proofs/dx-backbone-resource-lifecycle-vibe/README.md") {
    errors.push("proof note must be the HOBO-566 design proof README");
  }

  const designAnchors = readObjectArray<Partial<DesignAnchor>>(candidate.designAnchors, "design anchors", errors);
  const anchors = designAnchors.map((anchor) => anchor.source);
  if (JSON.stringify(anchors) !== JSON.stringify(REQUIRED_DESIGN_ANCHORS)) {
    errors.push("design anchors must exactly match the authoritative HOBO-566 anchors");
  }
  for (const anchor of designAnchors) {
    if (!isJsonString(anchor.reason) || anchor.reason.trim() === "") {
      errors.push(`design anchor ${String(anchor.source)} must explain why it is consumed`);
    }
  }

  const proofModes = readStringArray(candidate.proofModes, "proof modes", errors);
  if (JSON.stringify(proofModes) !== JSON.stringify(REQUIRED_PROOF_MODES)) {
    errors.push("proof modes must be closed over live, simulated, reference fixture, and scope-out");
  }

  const childSlices = readObjectArray<Partial<ChildSlice>>(candidate.childSlices, "child slices", errors);
  const childIssues = childSlices.map((slice) => slice.issue);
  if (JSON.stringify(childIssues) !== JSON.stringify(REQUIRED_CHILD_ISSUES)) {
    errors.push("child slices must cover HOBO-567 through HOBO-577 in canonical order");
  }

  const normalizedChildSlices: ChildSlice[] = [];
  const coverage = new Set<JsonValue>();
  for (const [index, slice] of childSlices.entries()) {
    const label = isJsonString(slice.issue) ? slice.issue : `child slice ${index + 1}`;
    const sliceCoverage = readStringArray(slice.coverage, `${label} coverage`, errors);
    const dependsOn = readStringArray(slice.dependsOn, `${label} dependsOn`, errors);
    const scopeOut = readStringArray(slice.scopeOut, `${label} scope out`, errors);
    for (const covered of sliceCoverage) {
      coverage.add(covered);
    }

    const targetPackage = isJsonString(slice.targetPackage) ? slice.targetPackage : "";
    const proofNote = isJsonString(slice.proofNote) ? slice.proofNote : "";
    const slug = targetPackage.split("/").at(-1);
    if (!TYPED_EXP_PROOF_PATH.test(targetPackage)) {
      errors.push(`${label} must target src/draft/exp-proofs/<type>/<slug>`);
    }
    if (proofNote !== `docs/design/proofs/${slug}/README.md`) {
      errors.push(`${label} proof note must mirror its target package slug`);
    }
    if (scopeOut.length === 0) {
      errors.push(`${label} must name explicit non-scope`);
    }

    if (
      isHoboIssue(slice.issue) &&
      isJsonString(slice.title) &&
      (slice.phase === "M1" || slice.phase === "M2") &&
      TYPED_EXP_PROOF_PATH.test(targetPackage) &&
      proofNote !== ""
    ) {
      normalizedChildSlices.push({
        issue: slice.issue,
        title: slice.title,
        phase: slice.phase,
        // SAFETY: `targetPackage: targetPackage as ExpProofPackagePath,` is required at this I/O or test boundary.
        targetPackage: targetPackage as ExpProofPackagePath,
        // SAFETY: `proofNote: proofNote as `docs/design/proofs/${string}/README.md`,` is required at this I/O or test boundary.
        proofNote: proofNote as `docs/design/proofs/${string}/README.md`,
        // SAFETY: `coverage: sliceCoverage as Coverage[],` is required at this I/O or test boundary.
        coverage: sliceCoverage as Coverage[],
        dependsOn: dependsOn.filter(isHoboIssue),
        scopeOut,
      });
    }
  }

  for (const required of REQUIRED_COVERAGE) {
    if (!coverage.has(required)) {
      errors.push(`missing child coverage: ${required}`);
    }
  }

  errors.push(...findSequencingViolations({ childSlices: normalizedChildSlices }));

  const downstreamGates = readObjectArray<Partial<DownstreamConsumerGate>>(
    candidate.downstreamGates,
    "downstream gates",
    errors,
  );
  for (const [index, gate] of downstreamGates.entries()) {
    const label = isJsonString(gate.consumer) && gate.consumer.trim() !== "" ? gate.consumer : `downstream gate ${index + 1}`;
    const mustConsume = readStringArray(gate.mustConsume, `${label} must consume`, errors);
    if (!mustConsume.includes("HOBO-577")) {
      errors.push(`${label} must consume HOBO-577 quickstart evidence`);
    }
    if (gate.inventBehavior !== false) {
      errors.push(`${label} must not invent behavior before accepted DX quickstart evidence`);
    }
    if (mustConsume.length === 0) {
      errors.push(`${label} must name at least one source issue`);
    }
  }

  for (const scope of readStringArray(candidate.scopeOut, "scope out", errors)) {
    if (!classifyBackboneRequest(scope).inScope) {
      continue;
    }
    errors.push(`scope-out item is not recognized as out of scope: ${scope}`);
  }

  return { ok: errors.length === 0, errors };
}

export function findSequencingViolations(record: Pick<DxBackboneRecord, "childSlices">): string[] {
  const errors: string[] = [];
  if (!Array.isArray(record.childSlices)) {
    return ["child slices must be an array"];
  }

  const byIssue = new Map(record.childSlices.map((slice) => [slice.issue, slice]));

  for (const slice of record.childSlices) {
    if (slice.phase === "M2" && slice.issue !== "HOBO-577") {
      const missing = M1_FOUNDATION_ISSUES.filter((issue) => !slice.dependsOn.includes(issue));
      if (missing.length > 0) {
        errors.push(`${slice.issue} must wait for M1 foundations: ${missing.join(", ")}`);
      }
    }
    if (slice.issue === "HOBO-577") {
      const required = ["HOBO-573", "HOBO-574", "HOBO-575", "HOBO-576"] as const;
      const missing = required.filter((issue) => !slice.dependsOn.includes(issue));
      if (missing.length > 0) {
        errors.push(`HOBO-577 must wait for transcript/golden-path prototypes: ${missing.join(", ")}`);
      }
    }
    for (const dependency of slice.dependsOn) {
      if (dependency !== "HOBO-566" && !byIssue.has(dependency)) {
        errors.push(`${slice.issue} depends on unmanaged child ${dependency}`);
      }
    }
  }

  return errors;
}

function isRecord(value: JsonValue): value is JsonObject {
  return value !== null && isJsonObject(value) && !Array.isArray(value);
}

function isHoboIssue(value: JsonValue): value is `HOBO-${number}` {
  return isJsonString(value) && /^HOBO-\d+$/.test(value);
}

function readObjectArray<T extends object>(value: JsonValue, label: string, errors: string[]): T[] {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return [];
  }

  const objects: T[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      errors.push(`${label}[${index}] must be an object`);
      continue;
    }
    // SAFETY: `objects.push(item as T);` is required at this I/O or test boundary.
    objects.push(item as T);
  }

  return objects;
}

function readStringArray(value: JsonValue, label: string, errors: string[]): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return [];
  }

  const strings: string[] = [];
  for (const [index, item] of value.entries()) {
    if (!isJsonString(item)) {
      errors.push(`${label}[${index}] must be a string`);
      continue;
    }
    strings.push(item);
  }

  return strings;
}

export function classifyBackboneRequest(request: JsonValue): BackboneClassification {
  const text = String(request ?? "").toLowerCase();

  if (/\bproduction\b.*\b(cli|api|sdk)\b|\b(cli|api|sdk)\b.*\bimplementation\b|\bargument parser\b/.test(text)) {
    return { owner: "CLI implementation", inScope: false };
  }
  if (/\blive\b.*\b(provider|aws|azure|gcp|cloud|database|mcp)\b|\breal credentials?\b|\bprovider credentials?\b/.test(text)) {
    return { owner: "provider/runtime implementation", inScope: false };
  }
  if (/\bcustomer data\b|\braw customer\b|\bsecret\b/.test(text)) {
    return { owner: "security/privacy boundary", inScope: false };
  }
  if (/\blaunch claims?\b|\bmarketing copy\b|\bdashboard mockup\b.*\binvent\b|\bui-first\b/.test(text)) {
    return { owner: "launch/docs artifacts", inScope: false };
  }

  return { owner: "HOBO-566", inScope: true };
}

function childSlice(
  input: Omit<ChildSlice, "targetPackage" | "proofNote"> & { slug: string; experienceType: ExperienceType },
): ChildSlice {
  const { slug, experienceType, ...slice } = input;
  return {
    ...slice,
    targetPackage: `src/draft/exp-proofs/${experienceType}/${slug}`,
    proofNote: `docs/design/proofs/${slug}/README.md`,
  };
}

function consumerGate(consumer: string): DownstreamConsumerGate {
  return {
    consumer,
    mustConsume: ["HOBO-577", "HOBO-567", "HOBO-571", "HOBO-572"],
    sourceMaterial: "resource lifecycle quickstart, scenario matrix, refusal envelopes, and fixture corpus",
    inventBehavior: false,
  };
}
