import { createHash } from "node:crypto";
import { hostname } from "node:os";

import type {
	BrokerCatalog,
	BrokerCatalogDefinition,
	BrokerPolicySet,
} from "./types.js";

// The running machine as a HoBo cloud provider host. When no cloud config is
// supplied, `hobo broker up` brokers against THIS catalog: the local machine
// advertises the core runtime ports at zero marginal cost, so the whole
// resolve → receipt → deliver pipeline is testable end to end with nothing
// but the machine you are on (the same local-first spirit as `hobo dev`).

// public-contract: the provider id the local machine registers under.
export const LOCAL_HOST_PROVIDER_ID = "@hobo/provider-local-host";
// public-contract: the pseudo-region derived from the machine itself.
export const LOCAL_HOST_REGION = "local";

// The runtime ports the local host serves (the runtime-local lane's surface:
// http handlers, filesystem-backed objects, in-memory kv/queues, actor host).
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
		// The test lane satisfies any feature set for a matching port — the
		// point is exercising the pipeline, not modelling machine limits.
		satisfies: (req) =>
			req.port === port ? { kind: "full" } : { kind: "none" },
	};
}

export function createLocalHostCatalog(
	machineName: string = hostname(),
): BrokerCatalog {
	const definitions = [
		...LOCAL_HOST_PORTS.map((port) => localDefinition(port, machineName)),
		// The wildcard test-lane definition: the local machine will stand in
		// for ANY port (the sandbox spirit — out-of-scope boundaries served
		// locally), so a real project's manifest brokers without a cloud.
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

// The permissive default policy set the local test lane runs under when no
// broker config is supplied: min-cost placement, generous local budget,
// in-proc delivery, no connector requirements. Real deployments configure
// their own BrokerPolicySet — this exists so `hobo broker up` works on a
// bare machine.
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
