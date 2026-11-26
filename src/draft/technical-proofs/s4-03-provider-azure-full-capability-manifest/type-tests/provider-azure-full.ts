import type * as ProviderAzureFull from "../src/provider-azure-full.d.mts";
import { type JsonObject } from "../src/json.js";


declare const AZURE_PROVIDER_ID: typeof ProviderAzureFull.AZURE_PROVIDER_ID;
declare const FULL_CAPABILITY_PORTS: typeof ProviderAzureFull.FULL_CAPABILITY_PORTS;
declare const azureFull: typeof ProviderAzureFull.azureFull;
declare const createAzureFullProvider: typeof ProviderAzureFull.createAzureFullProvider;
declare const createAzureFullMultiCloudShopPlan: typeof ProviderAzureFull.createAzureFullMultiCloudShopPlan;
declare const evaluateAzureFullPlan: typeof ProviderAzureFull.evaluateAzureFullPlan;
declare const realizeAzureFullPlan: typeof ProviderAzureFull.realizeAzureFullPlan;

const provider = createAzureFullProvider({ campEvidence: "pass" });
const host: { capabilityManifest(): { claimedCapabilities: string[] } } =
  // SAFETY: Azure full provider host exposes capabilityManifest on the returned bag.
  provider as never;
const manifest = host.capabilityManifest();
const plan = createAzureFullMultiCloudShopPlan({
  resourceOptions: {
    "orders-db": [azureFull.with.flexiblePostgres({ storageGb: 64 })],
    api: [azureFull.with.containerApp({ ingress: "external" })]
  }
});

const evaluation = evaluateAzureFullPlan(provider, plan);
const emission = realizeAzureFullPlan(provider, plan);

AZURE_PROVIDER_ID satisfies "@hobo/provider-azure";
FULL_CAPABILITY_PORTS satisfies readonly ["web", "service", "kv", "bucket", "queue", "topic", "sql", "secret"];
manifest.claimedCapabilities satisfies string[];
evaluation satisfies JsonObject;
emission satisfies JsonObject;
