import { createHash } from "node:crypto";
import { cloneAsJson, isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";


export const REALIZE_EMISSION_VERSION = "hobo.realize-emission/v1";
export const IAC_PROGRAM_VERSION = "hobo.iacProgram/v1";
export const BUILD_SPEC_VERSION = "hobo.buildSpec/v1";

const PLACEHOLDER_RE =
  /^\$\{resources\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)#([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\}$/;

const DRIVER_DIALECT_FIELDS = new Set([
  "awsCloudFormationType",
  "awsCdkConstruct",
  "cloudFormationType",
  "driverDialect",
  "providerDialect",
  "providerSdk",
  "pulumiModule",
  "terraformResourceType"
]);

export interface OutputPlaceholderInput {
  type: string;
  className?: string;
  id: string;
  output: string;
}

/** A driver-agnostic IacProgram node: one provisionable resource in the resource graph. */
export interface IacNode {
  id: string;
  type?: string;
  className?: string;
  coProvisionedFor?: string;
  driverIntent?: JsonObject;
  inputs?: JsonObject;
  outputs?: string[];
}

export interface IacEdge {
  from: string;
  to: string;
  reason?: string;
}

export interface IacLink {
  import: string;
  providerNode: string;
  component?: string;
  capability?: string;
}

export interface OutputPlaceholderEntry {
  placeholder: string;
  producerNode?: string;
  output?: string;
  consumerNode?: string;
  inputPath?: string;
}

export interface BuildArtifact {
  id: string;
  source?: string;
  target?: string;
  outputKind?: string;
  dependsOn?: string[];
}

export interface BuildOutputEntry {
  artifactId: string;
  imageRef: string;
}

export interface IacProgram {
  apiVersion?: string;
  intent?: string;
  context?: JsonValue;
  nodes?: IacNode[];
  edges?: IacEdge[];
  outputPlaceholders?: OutputPlaceholderEntry[];
  links?: IacLink[];
}

export interface BuildSpec {
  apiVersion?: string;
  artifacts?: BuildArtifact[];
  outputs?: BuildOutputEntry[];
}

/** The driver-agnostic emission a provider realizes from a resource plan: IacProgram + BuildSpec. */
export interface RealizeEmission {
  apiVersion?: string;
  provider?: string;
  planId?: string;
  iac?: IacProgram;
  build?: BuildSpec;
}

export interface LockInMarker {
  path: string;
  field: string;
  reason: string;
}

export interface DriftPortabilityReport {
  lockInMarkers: LockInMarker[];
  warnings: string[];
}

export interface BuildRefEntry {
  artifactId: string;
  path: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  buildRefs: BuildRefEntry[];
  portabilityReport: DriftPortabilityReport;
}

export interface AcceptanceResult {
  accepted: boolean;
  errors: string[];
  portabilityReport: DriftPortabilityReport;
}

export interface ReferenceIacBackend {
  accept(emission: RealizeEmission | undefined): AcceptanceResult;
}

export interface FixtureResourceBuild {
  artifactId: string;
  source?: string;
  target?: string;
}

export interface FixtureResourceBind {
  import: string;
  providerResourceId: string;
}

export interface FixtureResource {
  id: string;
  type: string;
  className: string;
  request?: JsonObject;
  build?: FixtureResourceBuild;
  binds?: FixtureResourceBind[];
}

export interface FixtureResourcePlanContext {
  app: string;
  env: string;
  envType: string;
}

export interface FixtureResourcePlan {
  id: string;
  context: FixtureResourcePlanContext;
  resources: FixtureResource[];
}

export function outputPlaceholder({ type, className = "standard", id, output }: OutputPlaceholderInput): string {
  return `\${resources.${type}.${className}#${id}.outputs.${output}}`;
}

export function createFixtureResourcePlan(): FixtureResourcePlan {
  return {
    id: "fixture-object-store-and-api",
    context: {
      app: "gallery",
      env: "preview",
      envType: "ephemeral"
    },
    resources: [
      {
        id: "assets",
        type: "objectStore",
        className: "standard",
        request: {
          durability: "regional"
        }
      },
      {
        id: "api",
        type: "compute",
        className: "standard",
        build: {
          artifactId: "api-image",
          source: "services/api",
          target: "wasm-component"
        },
        binds: [
          {
            import: "wasi:blobstore/blobstore",
            providerResourceId: "assets"
          }
        ]
      }
    ]
  };
}

export function realizeFixtureProvider(plan: FixtureResourcePlan = createFixtureResourcePlan()): RealizeEmission {
  const assets = getRequiredResource(plan, "assets");
  const api = getRequiredResource(plan, "api");
  const imageArtifactId = api.build?.artifactId ?? "api-image";

  const bucketName = outputPlaceholder({
    type: assets.type,
    className: assets.className,
    id: assets.id,
    output: "bucketName"
  });
  const bucketArn = outputPlaceholder({
    type: assets.type,
    className: assets.className,
    id: assets.id,
    output: "bucketArn"
  });

  const iac: IacProgram = {
    apiVersion: IAC_PROGRAM_VERSION,
    intent: "driver-agnostic-resource-graph",
    context: cloneAsJson(plan.context),
    nodes: [
      {
        id: "assets",
        type: "objectStore",
        className: "standard",
        driverIntent: {
          capability: "objectStore",
          operation: "create"
        },
        inputs: {
          name: "gallery-assets-${context.env}",
          durability: "regional"
        },
        outputs: ["bucketName", "bucketArn"]
      },
      {
        id: "assets-read-policy",
        type: "iamPolicy",
        className: "standard",
        coProvisionedFor: "assets",
        driverIntent: {
          capability: "iamPolicy",
          operation: "grant"
        },
        inputs: {
          subject: "component:api",
          actions: ["objectStore.read"],
          resource: bucketArn
        },
        outputs: ["policyRef"]
      },
      {
        id: "api",
        type: "compute",
        className: "standard",
        driverIntent: {
          capability: "compute",
          operation: "deploy"
        },
        inputs: {
          image: { $build: imageArtifactId },
          env: {
            ASSETS_BUCKET: bucketName
          }
        },
        outputs: ["url"]
      }
    ],
    edges: [
      { from: "assets", to: "assets-read-policy", reason: "co-provisioned-output" },
      { from: "assets", to: "api", reason: "binding-output" },
      { from: "assets-read-policy", to: "api", reason: "runtime-policy" }
    ],
    outputPlaceholders: [
      {
        placeholder: bucketName,
        producerNode: "assets",
        output: "bucketName",
        consumerNode: "api",
        inputPath: "inputs.env.ASSETS_BUCKET"
      },
      {
        placeholder: bucketArn,
        producerNode: "assets",
        output: "bucketArn",
        consumerNode: "assets-read-policy",
        inputPath: "inputs.resource"
      }
    ],
    links: [
      {
        component: "api",
        import: "wasi:blobstore/blobstore",
        providerNode: "assets",
        capability: "objectStore"
      }
    ]
  };

  return {
    apiVersion: REALIZE_EMISSION_VERSION,
    provider: "fixture-local-provider",
    planId: plan.id,
    iac,
    build: {
      apiVersion: BUILD_SPEC_VERSION,
      artifacts: [
        {
          id: imageArtifactId,
          source: api.build?.source ?? "services/api",
          target: api.build?.target ?? "wasm-component",
          outputKind: "ImageRef",
          dependsOn: []
        }
      ]
    }
  };
}

export function validateEmission(emission: RealizeEmission | undefined): ValidationResult {
  const errors: string[] = [];
  const portabilityReport: DriftPortabilityReport = {
    lockInMarkers: [],
    warnings: []
  };

  if (emission?.apiVersion !== REALIZE_EMISSION_VERSION) {
    errors.push(`expected apiVersion ${REALIZE_EMISSION_VERSION}`);
  }
  if (emission?.iac?.apiVersion !== IAC_PROGRAM_VERSION) {
    errors.push(`expected iac.apiVersion ${IAC_PROGRAM_VERSION}`);
  }

  const nodes = new Map<string, IacNode>();
  for (const node of emission?.iac?.nodes ?? []) {
    if (nodes.has(node.id)) {
      errors.push(`duplicate node id ${node.id}`);
    }
    nodes.set(node.id, node);
  }

  for (const edge of emission?.iac?.edges ?? []) {
    if (!nodes.has(edge.from)) errors.push(`edge references missing source node ${edge.from}`);
    if (!nodes.has(edge.to)) errors.push(`edge references missing target node ${edge.to}`);
  }

  for (const link of emission?.iac?.links ?? []) {
    if (!nodes.has(link.providerNode)) {
      errors.push(`link ${link.import} references missing provider node ${link.providerNode}`);
    }
  }

  const buildArtifacts = new Map(
    (emission?.build?.artifacts ?? []).map((artifact): [string, BuildArtifact] => [artifact.id, artifact])
  );
  for (const artifact of emission?.build?.artifacts ?? []) {
    for (const dependency of artifact.dependsOn ?? []) {
      if (!buildArtifacts.has(dependency)) {
        errors.push(`build artifact ${artifact.id} depends on missing artifact ${dependency}`);
      }
    }
  }

  for (const cycle of findBuildCycles(emission?.build?.artifacts ?? [])) {
    errors.push(`build dependency cycle: ${cycle.join(" -> ")}`);
  }

  const buildRefs: BuildRefEntry[] = [];
  visit(emission?.iac === undefined ? null : cloneAsJson(emission.iac), (value, path, key) => {
    if (isJsonString(key) && DRIVER_DIALECT_FIELDS.has(key)) {
      portabilityReport.lockInMarkers.push({
        path: path.join("."),
        field: key,
        reason: "driver-specific dialect must be reported before a backend accepts the program"
      });
    }

    if (isJsonString(value)) {
      const placeholder = parseOutputPlaceholder(value);
      if (!placeholder) return;

      const producer = nodes.get(placeholder.id);
      if (!producer) {
        errors.push(`placeholder ${value} references missing node ${placeholder.id}`);
        return;
      }
      if (producer.type !== placeholder.type || producer.className !== placeholder.className) {
        errors.push(`placeholder ${value} does not match producer ${producer.id} type/class`);
      }
      if (!producer.outputs?.includes(placeholder.output)) {
        errors.push(`placeholder ${value} references missing output ${placeholder.output}`);
      }
    }

    const buildId = buildReferenceId(value);
    if (buildId !== undefined) {
      buildRefs.push({ artifactId: buildId, path: path.join(".") });
      if (!buildArtifacts.has(buildId)) {
        errors.push(`build reference ${buildId} at ${path.join(".")} has no BuildSpec artifact`);
      }
    }
  });

  for (const declared of emission?.iac?.outputPlaceholders ?? []) {
    if (!parseOutputPlaceholder(declared.placeholder)) {
      errors.push(`declared output placeholder is malformed: ${declared.placeholder}`);
    }
  }

  if (portabilityReport.lockInMarkers.length > 0) {
    errors.push("driver-specific dialect leak surfaced in PortabilityReport");
  }

  return {
    ok: errors.length === 0,
    errors,
    buildRefs,
    portabilityReport
  };
}

export function wireBuildOutputs(emission: RealizeEmission, imageRefs: Record<string, string>): RealizeEmission {
  const imageRefByArtifact = new Map(Object.entries(imageRefs));
  // SAFETY: `const iac = replaceBuildRefs(cloneAsJson(emission.iac), imageRefByArtifact) as IacProgram | undefined` is required at this I/O or test boundary.
  const iac = (emission.iac === undefined
    ? undefined
    : replaceBuildRefs(cloneAsJson(emission.iac), imageRefByArtifact)) as IacProgram | undefined;

  return {
    ...emission,
    iac,
    build: {
      ...emission.build,
      outputs: Object.entries(imageRefs).map(([artifactId, imageRef]) => ({
        artifactId,
        imageRef
      }))
    }
  };
}

export function createReferenceIacBackend(): ReferenceIacBackend {
  return {
    accept(emission) {
      const result = validateEmission(emission);
      if (!result.ok) {
        return {
          accepted: false,
          errors: result.errors,
          portabilityReport: result.portabilityReport
        };
      }
      if (result.buildRefs.length > 0) {
        return {
          accepted: false,
          errors: result.buildRefs.map((ref) => `unresolved BuildSpec artifact ${ref.artifactId} at ${ref.path}`),
          portabilityReport: result.portabilityReport
        };
      }

      return {
        accepted: true,
        errors: [],
        portabilityReport: result.portabilityReport
      };
    }
  };
}

export function canonicalJson(value: JsonValue): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

export function stableDigest(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function getRequiredResource(plan: FixtureResourcePlan, id: string): FixtureResource {
  const resource = plan.resources.find((candidate) => candidate.id === id);
  if (!resource) {
    throw new Error(`fixture plan missing required resource ${id}`);
  }
  return resource;
}

interface ParsedOutputPlaceholder {
  type: string;
  className: string;
  id: string;
  output: string;
}

function parseOutputPlaceholder(value: string): ParsedOutputPlaceholder | null {
  const match = PLACEHOLDER_RE.exec(value);
  if (!match) return null;
  return {
    type: match[1],
    className: match[2],
    id: match[3],
    output: match[4]
  };
}

function buildReferenceId(value: JsonValue): string | undefined {
  if (!isJsonObject(value)) return undefined;
  const ref: JsonValue | undefined = value.$build;
  return ref !== undefined && isJsonString(ref) ? ref : undefined;
}

function findBuildCycles(artifacts: BuildArtifact[]): string[][] {
  const byId = new Map(artifacts.map((artifact): [string, BuildArtifact] => [artifact.id, artifact]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles: string[][] = [];

  function walk(id: string, stack: string[]): void {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      cycles.push([...stack.slice(start), id]);
      return;
    }
    if (visited.has(id)) return;

    visiting.add(id);
    const artifact = byId.get(id);
    for (const dependency of artifact?.dependsOn ?? []) {
      walk(dependency, [...stack, dependency]);
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const artifact of artifacts) {
    walk(artifact.id, [artifact.id]);
  }

  return cycles;
}

type VisitPath = string[];
type VisitKey = string | number | undefined;
type VisitCallback = (value: JsonValue, path: VisitPath, key: VisitKey) => void;

function visit(value: JsonValue, callback: VisitCallback, path: VisitPath = [], key: VisitKey = undefined): void {
  callback(value, path, key);

  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, callback, [...path, String(index)], index));
    return;
  }
  if (!isJsonObject(value)) return;

  for (const [childKey, child] of Object.entries(value)) {
    visit(child, callback, [...path, childKey], childKey);
  }
}

function replaceBuildRefs(value: JsonValue, imageRefByArtifact: Map<string, string>): JsonValue {
  const buildId = buildReferenceId(value);
  if (buildId !== undefined) {
    const imageRef = imageRefByArtifact.get(buildId);
    if (!imageRef) return value;
    return {
      artifactId: buildId,
      imageRef
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => replaceBuildRefs(item, imageRefByArtifact));
  }

  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, replaceBuildRefs(child, imageRefByArtifact)])
    );
  }

  return value;
}

function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}
