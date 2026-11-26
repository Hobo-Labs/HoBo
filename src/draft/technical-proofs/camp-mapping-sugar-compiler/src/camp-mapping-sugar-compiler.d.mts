import type {
  DriverId,
  ResourceDefinition,
  ResourceDefinitionInput
} from "../../resource-definition-driver-contract/src/resource-definition-driver-contract.d.mjs";
import { type JsonObject } from "./json.js";


export type CampMappingSugarVersion = "hobo.camp-mapping-sugar/v1";

export type CampResource = {
  id: string;
  type: string;
  engine?: string;
  className?: string;
  class?: string;
  paradigm?: string;
  serviceModel?: string;
};

export type ProviderTarget =
  | string
  | {
      provider: string;
      id?: string;
      driver?: DriverId;
      engine?: string;
      className?: string;
      class?: string;
      paradigm?: string;
      with?: JsonObject;
      options?: JsonObject;
      priority?: number;
      coProvisioned?: Array<JsonObject>;
    };

export interface NamedProviderTargets {
  readonly [name: string]: ProviderTarget;
}

export type CampMapping = {
  defaultProvider?: ProviderTarget;
  tiers?: NamedProviderTargets;
  bindings?: NamedProviderTargets;
};

export type CompiledDefinitionSource = {
  definitionId: string;
  sugar: "defaultProvider" | "tiers" | "bindings";
  campId: string;
  resourceIds: string[];
  serviceModel?: string;
};

export type CompiledCampMapping = {
  apiVersion: CampMappingSugarVersion;
  campId: string;
  definitions: ResourceDefinition[];
  sources: CompiledDefinitionSource[];
};

export declare const CAMP_MAPPING_SUGAR_VERSION: CampMappingSugarVersion;

export declare function compileCampMapping(input: {
  campId: string;
  resources: readonly CampResource[];
  mapping: CampMapping;
}): CompiledCampMapping;

export declare function registerCompiledDefinitions(
  catalog: {
    register(definition: ResourceDefinitionInput | ResourceDefinition): ResourceDefinition[];
  },
  compiled: CompiledCampMapping
): ResourceDefinition[];
