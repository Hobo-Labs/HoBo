import { type JsonValue } from "./json.js";
export type { JsonValue };

export type FlagValueType = "boolean" | "string" | "number" | "object";

export interface PrincipalRef {
  kind?: string;
  id?: string;
  tenant?: string;
  claims?: Array<{ key: string; value: JsonValue }>;
}

export interface EvaluationContext {
  user?: PrincipalRef;
  identity?: PrincipalRef;
  attributes?: Array<{ key: string; value: JsonValue }>;
}

export interface TargetingRule {
  attribute: string;
  op: "equals" | "notEquals" | "in" | "exists";
  value?: JsonValue;
}

export interface FlagConfig<T extends JsonValue> {
  default: T;
  targeting?: TargetingRule[];
}

export interface SdkFlagRef<T extends JsonValue> {
  key: string;
  type: FlagValueType;
  defaultValue: T;
  ref: {
    key: string;
    type: FlagValueType;
  };
  event: JsonValue;
}

export interface SdkFlagContract {
  flag: {
    boolean(key: string, config: FlagConfig<boolean>): SdkFlagRef<boolean>;
    string(key: string, config: FlagConfig<string>): SdkFlagRef<string>;
    number(key: string, config: FlagConfig<number>): SdkFlagRef<number>;
    object<T extends JsonValue>(key: string, config: FlagConfig<T>): SdkFlagRef<T>;
  };
}

export interface FlagDetails<T extends JsonValue> {
  flagKey: string;
  value: T;
  reason: string;
  variant?: string;
  bucket?: number;
  rulesetSeq?: number;
  error?: {
    code: string;
    message: string;
  };
  deprecation?: {
    code: string;
    message: string;
  };
}

export interface FlagSurfaceEventLog {
  append(entry: { seq: number; event: unknown }): void;
  appendBatch(entries: Array<{ seq: number; event: unknown }>): void;
  entries(): Array<{ seq: number; event: unknown }>;
  subscribe(listener: (entries: Array<{ seq: number; event: unknown }>) => void): () => void;
}

export interface UseFlagProbe<T extends JsonValue> {
  value(): T;
  details(): FlagDetails<T>;
  renderCount(): number;
  unsubscribe(): void;
}

export interface SdkFlagSurface {
  ctx: {
    flags: {
      eval<T extends JsonValue>(flag: SdkFlagRef<T>, context?: EvaluationContext): Promise<T>;
      details<T extends JsonValue>(flag: SdkFlagRef<T>, context?: EvaluationContext): Promise<FlagDetails<T>>;
      bucket<T extends JsonValue>(flag: SdkFlagRef<T>, context?: EvaluationContext): Promise<number | undefined>;
    };
  };
  useFlag<T extends JsonValue>(flag: SdkFlagRef<T>, options?: { clientContext?: EvaluationContext }): UseFlagProbe<T>;
}

export function createSdkFlagContract(options?: { knownTargetingAttributes?: string[] }): SdkFlagContract;

export function createFlagSurfaceEventLog(entries?: Array<{ seq: number; event: unknown }>): FlagSurfaceEventLog;

export function createSdkFlagSurface(options?: {
  eventLog?: FlagSurfaceEventLog;
  requestContext?: () => EvaluationContext;
  clientContext?: EvaluationContext;
}): SdkFlagSurface;
