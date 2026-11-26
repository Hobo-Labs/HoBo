import type { JsonObject } from "../json.js";
import { createPortDescriptor, type PortDescriptor } from "../ports.js";

// public-contract: extension-point id for provider plugins.
export const CLOUD_PROVIDER_EXTENSION_POINT = "hobo.cloud-provider/v1";

// public-contract: WIT-style interface id of the provider port.
export const CLOUD_PROVIDER_PORT_INTERFACE = "hobo:cloud/provider@0.1.0";

export const CLOUD_PROVIDER_PORT_DESCRIPTOR: PortDescriptor =
	createPortDescriptor({
		kind: "provider",
		name: "cloud-provider",
		interface: CLOUD_PROVIDER_PORT_INTERFACE,
		stability: "preview",
	});

export type CapabilityPortKind = string;

export type Outputs = JsonObject;

export interface PortRequest {
	port: CapabilityPortKind;
	features?: string[];
	negotiation?: "prefer" | "require";
	region?: string;
}

export type Match =
	| { kind: "full" }
	| { kind: "partial"; missing: string[] }
	| { kind: "none" };

export interface CostSignal {
	currency: string;
	sku: string;
	unit: string;
	marginalPrice: string;
	pricingStatus?: "unknown" | "estimate" | "verified-zero";
	freeTier: { unit: string; included: number; reset: string };
}

export interface Capability {
	port: CapabilityPortKind;
	satisfies(req: PortRequest): Match;
	estimateCost(req: PortRequest): CostSignal;
}

export type PublishedManifestDocuments = Record<string, string>;

export interface CapabilityManifest {
	providerId: string;
	published: PublishedManifestDocuments;
	capabilities: JsonObject;
	auth: JsonObject;
	cost: JsonObject;
}

export interface ProviderClient {
	port: CapabilityPortKind;
	resourceClass: string;
	providerService: string;
	bindings: Outputs;
}

export type TypedOptionBlock = JsonObject;

// domain-view: structural IaC resource DTO shared across provider emit sides;
export interface IacResource {
	name: string;
	type: string;
	provider: string;
	inputs: JsonObject;
	outputs: string[];
}

// public-contract: IaC program wire-shape ids (hobo.iac-program/v1).
export const IAC_PROGRAM_API_VERSION = "hobo.iac-program/v1";
// public-contract: kind discriminator consumed by provider-neutral IaC executors.
export const IAC_PROGRAM_KIND = "iac-program";

export interface IacProgramDocument {
	apiVersion: typeof IAC_PROGRAM_API_VERSION;
	kind: typeof IAC_PROGRAM_KIND;
	provider: string;
	deploymentId: string;
	stack: string;
	resources: IacResource[];
	stackOutputs: Record<string, string>;
}

export interface BuildSpec {
	kind: "hobo.build-spec/v1";
	artifacts: Array<{ id: string; source: string; target: string }>;
}

export interface RealizedResources {
	iac: IacProgramDocument;
	build?: BuildSpec;
}

export interface ResourcePlan {
	name: string;
	port: CapabilityPortKind;
	provider: string;
	options?: TypedOptionBlock[];
	deps?: string[];
	strategy?: string;
	region?: string;
	deploymentId?: string;
	build?: { artifactId: string; source: string; target: string };
	realizationParameters?: JsonObject;
}

export interface CloudProvider {
	id: string;
	regions: string[];
	capabilities: Capability[];
	realize(plan: ResourcePlan): RealizedResources;
	capabilityManifest(): CapabilityManifest;
	client(port: CapabilityPortKind, outputs: Outputs): ProviderClient;
}
