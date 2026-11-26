import { type JsonObject } from "./json.js";
export type ProviderCapability = {
  type: string;
  satisfies: string[];
};

export type ProviderEquivalence = {
  resourceClass: string;
  driver: string;
  satisfies: string[];
  options?: JsonObject;
};

export interface RealizationOutput {
  type: string;
  resourceClass: string;
  driver: string;
  with: JsonObject;
}

export type Provider = {
  id: string;
  capabilities: ProviderCapability[];
  equivalence: Record<string, ProviderEquivalence>;
  realize(type: string, equivalence: ProviderEquivalence): RealizationOutput;
};

export interface ProviderDefaultDefinition {
  id: string;
  source: "provider-default";
  type: string;
  provider: string;
  driver: string;
  resourceClass: string;
  satisfies: string[];
  match: Record<string, string>;
  priority?: number;
  with: JsonObject;
  equivalence: {
    providerResourceClass: string;
  };
  realization: {
    resourceClass: string;
    driver: string;
    with: JsonObject;
  };
}

export interface PlatformDefinition {
  id: string;
  source: "platform-defined";
  type: string;
  provider: string;
  driver: string;
  resourceClass: string;
  satisfies: string[];
  match: Record<string, string>;
  priority?: number;
}

export type CatalogDefinition = ProviderDefaultDefinition | PlatformDefinition;

export interface DefinitionCatalog {
  definitions: CatalogDefinition[];
}

export type RegistrationResult = {
  provider: string;
  definitions: ProviderDefaultDefinition[];
  errors: string[];
  catalog?: DefinitionCatalog;
};

export function buildFixtureProvider(overrides?: Partial<Provider>): Provider;
export function createDefinitionCatalog(definitions?: CatalogDefinition[]): DefinitionCatalog;
export function defineResource(definition: Partial<PlatformDefinition> & Pick<PlatformDefinition, "id" | "type">): PlatformDefinition;
export function registerProviderDefaults(provider: Provider): RegistrationResult;
export function register(provider: Provider, catalog?: DefinitionCatalog): RegistrationResult & { catalog: DefinitionCatalog };
export function validateProviderDefaults(provider: Provider): { ok: boolean; errors: string[] };
export function selectFromCatalogWithControlPlaneScorer(
  request: { type: string; require?: string[] },
  catalog: DefinitionCatalog,
  context: Record<string, string>
): { winner: (CatalogDefinition & { matchScore: number }) | null; rejected: Array<CatalogDefinition & { matchScore: number }>; tie: boolean };
export function remediationForUnsupportedPort(provider: string, port: string): {
  provider: string;
  port: string;
  code: "provider-capability-missing";
  message: string;
};
