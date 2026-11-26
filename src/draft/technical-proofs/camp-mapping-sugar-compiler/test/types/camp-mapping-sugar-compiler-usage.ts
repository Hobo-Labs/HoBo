import {
  compileCampMapping,
  registerCompiledDefinitions,
  type CampMapping,
  type CampResource,
  type CompiledCampMapping
} from "@hobo/draft-camp-mapping-sugar-compiler";

const resources: CampResource[] = [
  { id: "shop.db", type: "database", engine: "postgres", serviceModel: "saas" },
  { id: "shop.web", type: "web", serviceModel: "edge" }
];

const mapping: CampMapping = {
  defaultProvider: "azure",
  tiers: {
    edge: { provider: "cloudflare", driver: "terraform", with: { service: "workers" } }
  },
  bindings: {
    "shop.db": { provider: "azure", driver: "terraform", engine: "cosmos" }
  }
};

const compiled: CompiledCampMapping = compileCampMapping({ campId: "prod", resources, mapping });
const registered = registerCompiledDefinitions({ register: () => compiled.definitions }, compiled);
const providerId: string = registered[0]?.provider ?? "";

// @ts-expect-error provider target objects must name a provider.
const missingProvider: CampMapping = { defaultProvider: { driver: "terraform" } };

// @ts-expect-error resources must declare the abstract port type.
const missingType: CampResource = { id: "shop.db", serviceModel: "saas" };

void [missingProvider, missingType];

void providerId;
