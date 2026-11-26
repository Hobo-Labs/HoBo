import { type JsonValue } from "./json.js";
export type ContractMode = "declared" | "inferred" | "observed" | "promoted";

export type ContractEdgeKind =
  | "http"
  | "event"
  | "message"
  | "topic"
  | "resource-binding"
  | "capability-scope"
  | "runtime-slo"
  | "semantic-function"
  | "agent-tool"
  | "provider-interface"
  | "service"
  | "actor"
  | "workflow";

export interface ContractEdge {
  kind: ContractEdgeKind;
  producer: string;
  consumer: string;
  operation: string;
}

export interface RequiredRecord {
  format: string;
  schemaVersion?: string;
  requiredFields: string[];
  schema?: JsonValue;
}

export interface SampleCoverage {
  samples: number;
  coveragePct: number;
  traceWindow?: string;
}

export interface DeclaredContractProvenance {
  source: "wit-zod";
  verifiedByConstruction: true;
}

export interface InferredContractProvenance {
  source: "graph-compile";
  verifiedByConstruction: true;
}

export interface ObservedContractProvenance {
  source: "trace-mined";
  verifiedByConstruction: false;
  sampleCoverage: SampleCoverage;
}

export interface PromotedContractProvenance {
  source: "promotion-gate";
  verifiedByConstruction: false;
  sampleCoverage: SampleCoverage;
  migrationWindow: {
    days: number;
    startedAt?: string;
  };
}

export type ContractProvenance =
  | DeclaredContractProvenance
  | InferredContractProvenance
  | ObservedContractProvenance
  | PromotedContractProvenance;

export interface ConsumerRequirement {
  consumer: string;
  requiredFields: string[];
}

export interface ContractIrBase<
  Mode extends ContractMode,
  Provenance extends ContractProvenance
> {
  schema: "contract.ir/v1";
  id: string;
  version: string;
  mode: Mode;
  edge: ContractEdge;
  requiredRecord: RequiredRecord;
  provenance: Provenance;
  consumerRequirements: ConsumerRequirement[];
  interop: {
    importTargets: string[];
    exportTargets: string[];
  };
}

export type ContractIr =
  | ContractIrBase<"declared", DeclaredContractProvenance>
  | ContractIrBase<"inferred", InferredContractProvenance>
  | ContractIrBase<"observed", ObservedContractProvenance>
  | ContractIrBase<"promoted", PromotedContractProvenance>;

export interface ParseContractResult {
  ok: boolean;
  errors: string[];
  contract: ContractIr | null;
}

export const CONTRACT_SCHEMA: "contract.ir/v1";
export const CONTRACT_MODES: readonly ContractMode[];
export const CONTRACT_EDGE_KINDS: readonly ContractEdgeKind[];

export function createContractFixture(input?: {
  edgeKind?: ContractEdgeKind;
  mode?: ContractMode;
  consumerRequirements?: ConsumerRequirement[];
}): ContractIr;
export function parseContract(candidate: JsonValue): ParseContractResult;
export function serializeContract(contract: ContractIr): string;
export function deserializeContract(text: string): ParseContractResult;
export function canonicalJson(value: JsonValue): string;
export function importOpenApiContract(openApi: JsonValue, input?: {
  id?: string;
  producer?: string;
  consumer?: string;
}): ContractIr;
export function importPactContract(pact: JsonValue, input?: {
  id?: string;
  eventType?: string;
}): ContractIr;
export function exportOpenApiContract(contract: ContractIr): {
  source: "hobo-contract-ir";
  id: string;
  edgeKind: ContractEdgeKind;
  producer: string;
  consumer: string;
  requiredFields: string[];
};
export function exportPactContract(contract: ContractIr): {
  source: "hobo-contract-ir";
  id: string;
  consumer: string;
  provider: string;
  requiredFields: string[];
};
export function importAsyncApiContract(asyncApi: JsonValue, input?: {
  id?: string;
  eventType?: string;
}): ContractIr;
export function exportAsyncApiContract(contract: ContractIr): {
  source: "hobo-contract-ir";
  id: string;
  channel: string;
  producer: string;
  requiredFields: string[];
};
export function importProtobufContract(proto: JsonValue, input?: {
  id?: string;
  producer?: string;
  consumer?: string;
}): ContractIr;
export function exportProtobufContract(contract: ContractIr): {
  source: "hobo-contract-ir";
  id: string;
  message: string;
  producer: string;
  consumer: string;
  requiredFields: string[];
};
