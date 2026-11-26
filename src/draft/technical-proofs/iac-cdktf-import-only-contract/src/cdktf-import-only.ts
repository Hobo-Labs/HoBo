import { readFile } from "node:fs/promises";
import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";


export const CDKTF_IMPORT_ONLY_ERROR = "cdktf-import-only";
export const CDKTF_IMPORT_REPORT_VERSION = "hobo.iac-cdktf.import/v1";

export type CdktfResourceKind = "adopted" | "external";

export interface TerraformStateResourceInstance {
  attributes: JsonObject & { id: string | number };
}

export interface TerraformStateResource {
  mode?: string;
  type: string;
  name: string;
  provider?: string;
  instances: TerraformStateResourceInstance[];
}

export interface TerraformState {
  version?: number;
  serial?: number;
  lineage?: string;
  resources: TerraformStateResource[];
}

export interface ResourceMapping {
  hoboType: string;
  capability?: string;
}

export interface ResourceMappings {
  [terraformType: string]: ResourceMapping;
}

export interface CdktfResourceProvenance {
  source: "cdktf";
  stateLineage?: string;
  stateSerial?: number;
  provider: string;
  address: string;
}

export interface CdktfAdoptedResource {
  kind: "adopted";
  hoboType: string;
  capability?: string;
  terraformType: string;
  terraformName: string;
  address: string;
  id: string;
  provider: string;
  attributes: JsonObject;
  provenance: CdktfResourceProvenance;
}

export interface CdktfExternalResource {
  kind: "external";
  hoboType: "external";
  terraformType: string;
  terraformName: string;
  address: string;
  id: string;
  provider: string;
  attributes: JsonObject;
  provenance: CdktfResourceProvenance;
  externalReason: string;
}

export type CdktfImportedResource = CdktfAdoptedResource | CdktfExternalResource;

export interface CdktfPortabilityReport {
  nonPortableSurface: Array<{
    resource: string;
    kind: CdktfResourceKind;
    reason: string;
  }>;
}

export interface CdktfImportReport {
  apiVersion: typeof CDKTF_IMPORT_REPORT_VERSION;
  source: "cdktf";
  mode: "import-only";
  resources: CdktfImportedResource[];
  portabilityReport: CdktfPortabilityReport;
}

export interface CdktfDriftReport {
  kind: "drift-report";
  provider: "cdktf";
  mode: "import-only";
  drifted: false;
  resources: CdktfImportedResource[];
  portabilityReport: CdktfPortabilityReport;
}

export interface ImportCdktfStateOptions {
  mappings?: ResourceMappings;
}

export interface RefreshProgram {
  state?: TerraformState;
  stateFile?: URL | string;
  mappings?: ResourceMappings;
}

export interface ProposedChange {
  op: string;
  resource: string;
}

export interface PlanAdoptedResourcesOptions {
  proposedChanges?: ProposedChange[];
}

export interface AdoptedResourceSummary {
  address: string;
  id: string;
  kind: CdktfResourceKind;
}

export interface IacPlan {
  kind: "iac-plan";
  provider: "cdktf";
  mode: "import-only";
  adoptedResources: AdoptedResourceSummary[];
  diff: {
    dirty: false;
    changes: [];
    reason: "adopted resources are drift-detect only";
  };
  blockedAuthoringChanges: [];
}

export interface CdktfImportOnlyProvider {
  id: "cdktf";
  mode: "import-only";
  preview(program?: JsonValue): Promise<never>;
  apply(program?: JsonValue): Promise<never>;
  destroy(program?: JsonValue): Promise<never>;
  refresh(program?: RefreshProgram): Promise<CdktfDriftReport>;
}

const DEFAULT_MAPPINGS: ResourceMappings = Object.freeze({
  aws_dynamodb_table: { hoboType: "database", capability: "wasi:keyvalue/store" },
  aws_s3_bucket: { hoboType: "objectStore", capability: "wasi:blobstore/container" },
});

const AUTHORING_OPERATIONS: ReadonlySet<string> = new Set(["create", "update", "replace", "delete"]);

export class CdktfImportOnlyError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CdktfImportOnlyError";
    this.code = code;
  }
}

export class CdktfStateError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CdktfStateError";
    this.code = code;
  }
}

export async function readTerraformStateFile(fileUrlOrPath: URL | string): Promise<TerraformState> {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(await readFile(fileUrlOrPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CdktfStateError("malformed-state-json", `malformed CDKTF/Terraform state JSON: ${error.message}`);
    }
    throw error;
  }

  return validateTerraformState(parsed);
}

export function importCdktfState(state: TerraformState, options: ImportCdktfStateOptions = {}): CdktfImportReport {
  const validated = validateTerraformState(state);
  const mappings: ResourceMappings = { ...DEFAULT_MAPPINGS, ...options.mappings };
  const resources: CdktfImportedResource[] = [];

  for (const resource of validated.resources) {
    if (resource.mode !== "managed") {
      continue;
    }

    resource.instances.forEach((instance, index) => {
      const attributes = structuredClone(instance.attributes);
      const address = instanceAddress(resource, index);
      const mapping = mappings[resource.type];
      const common = {
        terraformType: resource.type,
        terraformName: resource.name,
        address,
        id: String(attributes.id),
        provider: normalizeProvider(resource.provider),
        attributes,
        provenance: {
          source: "cdktf" as const,
          stateLineage: validated.lineage,
          stateSerial: validated.serial,
          provider: normalizeProvider(resource.provider),
          address,
        },
      };

      if (!mapping) {
        resources.push({
          kind: "external",
          hoboType: "external",
          ...common,
          externalReason: `no HoBo mapping for Terraform resource type ${resource.type}`,
        });
        return;
      }

      resources.push({
        kind: "adopted",
        hoboType: mapping.hoboType,
        capability: mapping.capability,
        ...common,
      });
    });
  }

  return deepFreeze<CdktfImportReport>({
    apiVersion: CDKTF_IMPORT_REPORT_VERSION,
    source: "cdktf",
    mode: "import-only",
    resources,
    portabilityReport: {
      nonPortableSurface: resources.map((resource) => ({
        resource: resource.address,
        kind: resource.kind,
        reason:
          resource.kind === "external"
            ? resource.externalReason
            : "brownfield resource adopted from CDKTF/Terraform state",
      })),
    },
  });
}

export function createCdktfImportOnlyProvider(): CdktfImportOnlyProvider {
  return deepFreeze<CdktfImportOnlyProvider>({
    id: "cdktf",
    mode: "import-only",
    async preview(): Promise<never> {
      throw importOnlyError("preview");
    },
    async apply(): Promise<never> {
      throw importOnlyError("apply");
    },
    async destroy(): Promise<never> {
      throw importOnlyError("destroy");
    },
    async refresh(program: RefreshProgram = {}): Promise<CdktfDriftReport> {
      const state =
        program.state ??
        (program.stateFile
          ? await readTerraformStateFile(program.stateFile)
          : undefined);
      if (!state) {
        throw new CdktfStateError("missing-state", "refresh requires state or stateFile");
      }

      const imported = importCdktfState(state, { mappings: program.mappings });

      return deepFreeze<CdktfDriftReport>({
        kind: "drift-report",
        provider: "cdktf",
        mode: "import-only",
        drifted: false,
        resources: imported.resources,
        portabilityReport: imported.portabilityReport,
      });
    },
  });
}

export function planAdoptedResources(
  resources: CdktfImportedResource[],
  options: PlanAdoptedResourcesOptions = {},
): IacPlan {
  const destructive = (options.proposedChanges ?? []).filter((change) =>
    AUTHORING_OPERATIONS.has(change.op),
  );
  if (destructive.length > 0) {
    const ops = [...new Set(destructive.map((change) => change.op))].join(", ");
    const targets = [...new Set(destructive.map((change) => change.resource))].join(", ");
    throw new CdktfImportOnlyError(
      "destructive-import-plan",
      `CDKTF import is drift-detect only: refusing ${ops} for ${targets}`,
    );
  }

  return deepFreeze<IacPlan>({
    kind: "iac-plan",
    provider: "cdktf",
    mode: "import-only",
    adoptedResources: resources.map((resource) => ({
      address: resource.address,
      id: resource.id,
      kind: resource.kind,
    })),
    diff: {
      dirty: false,
      changes: [],
      reason: "adopted resources are drift-detect only",
    },
    blockedAuthoringChanges: [],
  });
}

function validateTerraformState<T>(state: T): TerraformState {
  if (!state || !isJsonObject(state)) {
    throw new CdktfStateError("invalid-state", "CDKTF/Terraform state must be an object");
  }

  if (!Array.isArray(state.resources)) {
    throw new CdktfStateError("missing-resources", "CDKTF/Terraform state must contain resources[]");
  }

  for (const resource of state.resources) {
    validateResource(resource);
  }

  const validated: TerraformState =
    // SAFETY: resources[] and instance attributes were parsed above.
    state as never;
  return validated;
}

function validateResource<T>(resource: T): void {
  if (!resource || !isJsonObject(resource)) {
    throw new CdktfStateError("invalid-resource", "state resources[] entries must be objects");
  }

  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const candidate = resource as JsonObject;
  if (!isJsonString(candidate.type) || candidate.type.length === 0) {
    throw new CdktfStateError("missing-resource-type", "state resource is missing type");
  }
  if (!isJsonString(candidate.name) || candidate.name.length === 0) {
    throw new CdktfStateError("missing-resource-name", `state resource ${candidate.type} is missing name`);
  }
  if (!Array.isArray(candidate.instances)) {
    throw new CdktfStateError("missing-resource-instances", `${candidate.type}.${candidate.name} is missing instances[]`);
  }

  candidate.instances.forEach((instance: JsonValue, index: number) => {
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    const instanceRecord = instance as JsonObject | null | undefined;
    if (!instanceRecord?.attributes || !isJsonObject(instanceRecord.attributes)) {
      throw new CdktfStateError(
        "missing-resource-attributes",
        `${candidate.type}.${candidate.name} instance ${index} is missing attributes`,
      );
    }
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    const attributes = instanceRecord.attributes as JsonObject;
    if (attributes.id === undefined || attributes.id === null || attributes.id === "") {
      throw new CdktfStateError(
        "missing-resource-id",
        `${candidate.type}.${candidate.name} instance ${index} is missing attributes.id`,
      );
    }
  });
}

function importOnlyError(operation: string): CdktfImportOnlyError {
  return new CdktfImportOnlyError(
    CDKTF_IMPORT_ONLY_ERROR,
    `@hobo/iac-cdktf is import-only: ${operation} would author infrastructure`,
  );
}

function instanceAddress(resource: TerraformStateResource, instanceIndex: number): string {
  const base = `${resource.type}.${resource.name}`;
  return resource.instances.length > 1 ? `${base}[${instanceIndex}]` : base;
}

function normalizeProvider(provider: string = "unknown"): string {
  const match = String(provider).match(/registry\.terraform\.io\/[^/"\]]+\/[^/"\]]+/);
  return match?.[0] ?? String(provider);
}

function deepFreeze<T>(value: T): T {
  if (!value || !isJsonObject(value)) {
    return value;
  }

  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }

  return Object.freeze(value);
}
