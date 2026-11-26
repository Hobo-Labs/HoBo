import type {
  Driver,
  DriverId,
  MatchContext
} from "../../resource-definition-driver-contract/src/resource-definition-driver-contract.d.js";
import { type JsonValue, type JsonObject } from "./json.js";


export const DRIVER_DISPATCH_ROUTING_VERSION: "hobo.driver-dispatch-routing/v1";

export class DriverDispatchError extends Error {
  code: string;
  details: JsonObject;
  constructor(code: string, message: string, details?: JsonObject);
}

export type DispatchDefinition = {
  id: string;
  provider: string;
  driver: DriverId;
};

export type DispatchResource = {
  id: string;
  type?: string;
  name?: string;
  deps?: string[];
};

export type PlaceholderRef = {
  from: string;
  output: string;
};

export type DependentPlaceholders = {
  resourceId: string;
  placeholders: Record<string, PlaceholderRef>;
};

export type DriverDispatchInput = {
  definition: DispatchDefinition;
  resource: DispatchResource;
  context?: MatchContext & { correlationId?: string };
  inputs?: JsonObject;
  oldState?: JsonValue;
  state?: JsonValue;
  dependents?: DependentPlaceholders[];
};

export type DriverDispatchEvent = {
  id: string;
  type: string;
  schema: typeof DRIVER_DISPATCH_ROUTING_VERSION;
  seq: number;
  time: string;
  data: JsonObject;
};

export type DriverDispatchRouter = {
  registry: Map<DriverId, Driver>;
  provision(input: DriverDispatchInput): Promise<JsonObject>;
  destroy(input: DriverDispatchInput): Promise<JsonObject>;
  refresh(input: DriverDispatchInput): Promise<JsonObject>;
};

export declare function createDriverDispatchRouter(input?: {
  drivers?: Driver[];
  executor?: JsonValue;
  tokenBroker?: JsonValue;
}): DriverDispatchRouter;

export declare function createFixtureDriver(id: DriverId, options?: JsonObject): Driver & {
  calls: {
    provision: JsonValue[];
    destroy: JsonValue[];
    refresh: JsonValue[];
  };
};

export declare function createFixtureResource(id: string, overrides?: Partial<DispatchResource>): DispatchResource;
