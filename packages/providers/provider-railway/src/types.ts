import type {
	CapabilityManifest as CoreCapabilityManifest,
	CostSignal as ProviderCostSignal,
} from "@hobo/core";
import type { JsonObject } from "./json.js";

export type PortKind = string;
export type Outputs = Record<string, string>;
export type PortRequest = { port: string; features?: string[] };
export type Match =
	| { kind: "full" }
	| { kind: "partial"; missing: string[] }
	| { kind: "none" };
export type CostSignal = Pick<
	ProviderCostSignal,
	"currency" | "sku" | "unit" | "marginalPrice" | "pricingStatus"
>;
export type Capability = {
	port: string;
	satisfies(req: PortRequest): Match;
	estimateCost(req: PortRequest): CostSignal;
};
export type ResourcePlan = {
	name: string;
	port: string;
	require?: string[];
	prefer?: string[];
	options?: JsonObject;
};
export type ProviderClient = {
	port: string;
	resourceClass: string;
	providerService: string;
	bindings: Outputs;
};
export type CapabilityManifest = CoreCapabilityManifest;
export type CloudProvider = {
	id: string;
	regions: string[];
	capabilities: Capability[];
	realize(plan: ResourcePlan): { iac?: JsonObject; driver?: JsonObject };
	capabilityManifest(): CapabilityManifest;
	client(port: PortKind, outputs: Outputs): ProviderClient;
};
