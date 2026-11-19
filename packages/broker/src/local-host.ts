import { createHash } from "node:crypto";
import { hostname } from "node:os";

import type {
	BrokerCatalog,
	BrokerCatalogDefinition,
	BrokerPolicySet,
} from "./types.js";

// public-contract: the provider id the local machine registers under.
export const LOCAL_HOST_PROVIDER_ID = "@hobo/provider-local-host";
// public-contract: the pseudo-region derived from the machine itself.
export const LOCAL_HOST_REGION = "local";

const LOCAL_HOST_PORTS = [
	"hobo:http-service",
	"hobo:web-app",
	"hobo:object-store",
	"hobo:key-value",
	"hobo:message-queue",
	"hobo:event-store",
	"hobo:actor-host",
] as const;

function localDefinition(port: string, host: string): BrokerCatalogDefinition {
	return {
		id: `${LOCAL_HOST_PROVIDER_ID}:${port}`,
		providerId: LOCAL_HOST_PROVIDER_ID,
		port,
		features: [],
		regions: [LOCAL_HOST_REGION],
		cost: { sku: `local-host-${host}`, unit: "hour", marginalPrice: "0.00" },
		satisfies: (req) =>
			req.port === port ? { kind: "full" } : { kind: "none" },
	};
}

export function createLocalHostCatalog(
	machineName: string = hostname(),
): BrokerCatalog {
	const definitions = [
		...LOCAL_HOST_PORTS.map((port) => localDefinition(port, machineName)),
		{
			id: `${LOCAL_HOST_PROVIDER_ID}:*`,
			providerId: LOCAL_HOST_PROVIDER_ID,
			port: "*",
			features: [],
			regions: [LOCAL_HOST_REGION],
			cost: {
				sku: `local-host-${machineName}`,
				unit: "hour",
				marginalPrice: "0.00",
			},
			satisfies: () => ({ kind: "full" }),
		} satisfies BrokerCatalogDefinition,
	];
	const digest = createHash("sha256")
		.update(JSON.stringify(definitions.map((d) => d.id).sort()))
		.digest("hex");
	return {
		catalogHash: `sha256:${digest}`,
		definitions: () => definitions.map((d) => ({ ...d })),
	};
}

export function defaultLocalPolicySet(
	brokerId = `broker:local/${hostname()}`,
): BrokerPolicySet {
	return {
		schemaVersion: "hobo.broker/v1",
		brokerId,
		placementPolicies: [
			{
				id: "pp-local-default",
				scopeKind: "bindle",
				objective: "min-cost",
				allowedProviders: [],
				deniedProviders: [],
				allowedRegions: [],
				requireExplicitCamps: false,
			},
		],
		billing: {
			quota: "deployments/day",
			quotaUsed: 0,
			quotaLimit: 1000,
			budgetUsd: 0,
			spendCapUsd: 0,
		},
		delivery: {
			reconcilerMode: "conductor",
			syncMode: "auto",
			prune: false,
			engine: "in-proc",
		},
		requiredConnectorKinds: [],
	};
}
