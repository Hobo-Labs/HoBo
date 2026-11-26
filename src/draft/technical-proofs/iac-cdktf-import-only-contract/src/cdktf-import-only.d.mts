import { type JsonValue, type JsonObject } from "./json.js";
export const CDKTF_IMPORT_ONLY_ERROR: "cdktf-import-only";
export const CDKTF_IMPORT_REPORT_VERSION: "hobo.iac-cdktf.import/v1";

export type CdktfResourceKind = "adopted" | "external";

export interface TerraformState {
  version?: number;
  serial?: number;
  lineage?: string;
  resources: TerraformStateResource[];
}

export interface TerraformStateResource {
  mode?: string;
  type: string;
  name: string;
  provider?: string;
  instances: Array<{
    attributes: JsonObject & { id: string | number };
  }>;
}

export interface CdktfImportedResource {
  kind: CdktfResourceKind;
  hoboType: string;
  terraformType: string;
  terraformName: string;
  address: string;
  id: string;
  provider: string;
  attributes: JsonObject;
  provenance: {
    source: "cdktf";
    stateLineage?: string;
    stateSerial?: number;
    provider: string;
    address: string;
  };
  capability?: string;
  externalReason?: string;
}

export interface CdktfImportReport {
  apiVersion: typeof CDKTF_IMPORT_REPORT_VERSION;
  source: "cdktf";
  mode: "import-only";
  resources: CdktfImportedResource[];
  portabilityReport: {
    nonPortableSurface: Array<{
      resource: string;
      kind: CdktfResourceKind;
      reason: string;
    }>;
  };
}

export interface CdktfDriftReport {
  kind: "drift-report";
  provider: "cdktf";
  mode: "import-only";
  drifted: false;
  resources: CdktfImportedResource[];
  portabilityReport: CdktfImportReport["portabilityReport"];
}

export interface CdktfImportOnlyProvider {
  id: "cdktf";
  mode: "import-only";
  preview(program: JsonValue): Promise<never>;
  apply(program: JsonValue): Promise<never>;
  destroy(program: JsonValue): Promise<never>;
  refresh(program: { state?: TerraformState; stateFile?: URL | string; mappings?: ResourceMappings }): Promise<CdktfDriftReport>;
}

export interface ResourceMapping {
  hoboType: string;
  capability?: string;
}

export interface ResourceMappings {
  [terraformType: string]: ResourceMapping;
}

export class CdktfImportOnlyError extends Error {
  name: "CdktfImportOnlyError";
  code: string;
  constructor(code: string, message: string);
}

export class CdktfStateError extends Error {
  name: "CdktfStateError";
  code: string;
  constructor(code: string, message: string);
}

export function readTerraformStateFile(fileUrlOrPath: URL | string): Promise<TerraformState>;
export function importCdktfState(state: TerraformState, options?: { mappings?: ResourceMappings }): CdktfImportReport;
export function createCdktfImportOnlyProvider(): CdktfImportOnlyProvider;
export function planAdoptedResources(
  resources: CdktfImportedResource[],
  options?: { proposedChanges?: Array<{ op: string; resource: string }> },
): {
  kind: "iac-plan";
  provider: "cdktf";
  mode: "import-only";
  adoptedResources: Array<{ address: string; id: string; kind: CdktfResourceKind }>;
  diff: { dirty: false; changes: []; reason: "adopted resources are drift-detect only" };
  blockedAuthoringChanges: [];
};
