import type * as ProviderAzureContract from "../src/provider-azure.d.mts";
import type { AzureProvider } from "../src/provider-azure.d.mts";
import { type JsonObject } from "../src/json.js";


declare const AZURE_PROVIDER_ID: typeof ProviderAzureContract.AZURE_PROVIDER_ID;
declare const azure: typeof ProviderAzureContract.azure;
declare const createAzureMultiCloudShopPlan: typeof ProviderAzureContract.createAzureMultiCloudShopPlan;
declare const createAzureProvider: typeof ProviderAzureContract.createAzureProvider;
declare const evaluateAzurePlan: typeof ProviderAzureContract.evaluateAzurePlan;
declare const realizeAzurePlan: typeof ProviderAzureContract.realizeAzurePlan;

const provider: AzureProvider = createAzureProvider({ campEvidence: "pass" });
const manifest = provider.capabilityManifest();
const plan = createAzureMultiCloudShopPlan({
  resourceOptions: {
    "orders-db": [azure.with.flexiblePostgres({ sku: "GP_Standard_D2s_v3", zoneRedundantHa: true })],
    assets: [azure.with.blob({ redundancy: "ZRS", immutableStorage: true })],
    web: [azure.with.containerApp({ ingress: "external", daprEnabled: true })],
    jobs: [azure.with.serviceBus({ sessions: true })],
    "session-cache": [azure.with.cacheForRedis({ sku: "Premium" })]
  }
});

const evaluation = evaluateAzurePlan(provider, plan);
const emission = realizeAzurePlan(provider, plan);

AZURE_PROVIDER_ID satisfies "@hobo/provider-azure";
manifest.claimedCapabilities satisfies Array<"database" | "objectStore" | "compute" | "queue" | "cache">;
evaluation satisfies JsonObject;
emission satisfies JsonObject;

// @ts-expect-error Azure option blocks do not accept raw ARM/Bicep escape hatches in this contract.
azure.with.containerApp({ rawArmTemplate: { type: "Microsoft.App/containerApps" } });

// @ts-expect-error client is typed to declared Azure seed ports only.
provider.client("dns", {});
