import { type JsonValue } from "./json.js";
export type ExecutionHostCategory = "runner" | "build-machine";
export type ExecutionHostObjective =
  | "cost"
  | "latency"
  | "single-provider"
  | "carbon"
  | "maximize-credits";

export interface ExecutionHostCapabilityManifest {
  schema: "hobo.execution-host-capability-manifest/v1";
  provider: {
    id: string;
    category: ExecutionHostCategory;
    kind: "execution-host-provider";
    adapter: string;
  };
  capabilities: Array<{
    port: "hobo:runner" | "hobo:build-machine";
    interface: string;
    version: string;
    stability: "preview";
    features: string[];
  }>;
  cost: {
    schema: "hobo.cost/v1";
    currency: string;
    facts: Array<{
      sku: "runner.minutes" | "build.minutes";
      unit: string;
      marginalPrice: string;
      freeTier: {
        unit: string;
        included: number;
        reset: string;
      };
      source: {
        type: "declared-provider";
        digest: string;
      };
    }>;
  };
}

export interface RunnerJob {
  jobId: string;
  command?: string;
  estimatedUnits?: number;
}

export interface RunnerResult {
  providerId: string;
  category: "runner";
  jobId: string;
  status: "succeeded" | "failed";
  command?: string;
  events: Array<{ type: string; jobId: string; providerId: string }>;
}

export interface BuildSpec {
  buildId: string;
  engine: string;
  sourceRef: string;
  estimatedUnits?: number;
}

export interface ImageRef {
  mediaType: string;
  uri: string;
  digest: string;
}

export interface RunnerProvider {
  id: string;
  category: "runner";
  capabilityManifest(): ExecutionHostCapabilityManifest;
  run(job: RunnerJob): Promise<RunnerResult>;
}

export interface BuildMachineProvider {
  id: string;
  category: "build-machine";
  capabilityManifest(): ExecutionHostCapabilityManifest;
  execute(build: BuildSpec): Promise<ImageRef>;
}

export interface FixtureBuildProvider {
  calls: Array<BuildSpec & { hostProviderId: string }>;
  build(build: BuildSpec & { hostProviderId: string }): Promise<ImageRef>;
}

export interface CreditLedgerDispatchView {
  seq: number;
  balanceHash: string;
  balances: Record<string, Record<string, {
    freeHeadroom: number;
    marginalUnitCost: number;
  }>>;
}

export interface ExecutionHostRegistry {
  providers: Array<RunnerProvider | BuildMachineProvider>;
}

export interface ExecutionHostSelectionRequest {
  category: ExecutionHostCategory;
  dispatchId: string;
  objective: ExecutionHostObjective;
  units: number;
  withProvider?: string;
  ledgerView: CreditLedgerDispatchView;
}

export interface ExecutionHostDecision {
  selectedProvider: string;
  category: ExecutionHostCategory;
  routingMode: "ranked" | "pinned";
  optedOutOfRouting: boolean;
  candidates: Array<{
    providerId: string;
    category: ExecutionHostCategory;
    effectiveMarginalCost: number;
    totalCost: number;
    costTrust: "declared-unverified";
  }>;
  dispatchDecided: {
    type: "dispatch.Decided";
    data: JsonValue;
  };
}

export declare function createSelfHostedRunnerProvider(options?: {
  id?: string;
  freeTierUnits?: number;
  marginalPrice?: string;
}): RunnerProvider;

export declare function createSelfHostedBuildMachineProvider(options?: {
  id?: string;
  buildProvider?: FixtureBuildProvider;
  creditBudget?: { remainingUnits: number };
  freeTierUnits?: number;
  marginalPrice?: string;
}): BuildMachineProvider;

export declare function createFixtureBuildProvider(options?: {
  digest?: string;
  mediaType?: string;
}): FixtureBuildProvider;

export declare function createExecutionHostRegistry(
  providers: Array<RunnerProvider | BuildMachineProvider>
): ExecutionHostRegistry;

export declare function selectExecutionHost(
  request: ExecutionHostSelectionRequest,
  registry: ExecutionHostRegistry
): ExecutionHostDecision;

export declare function validateExecutionHostManifest(
  manifest: JsonValue,
  options?: { category?: ExecutionHostCategory }
): { ok: boolean; errors: string[] };
