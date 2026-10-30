import type { JsonObject } from "../json.js";
import { createPortDescriptor, type PortDescriptor } from "../ports.js";

// The canonical CloudProvider port (ADR-0156, control-plane.md "Port &
// provider interfaces"). Until ADR-0156 this contract was copy-pasted into
// each provider package because the boundary lint forbids adapter→adapter
// imports; core is the one package adapters may import, so the port lives
// here and provider packages re-export it. Wire form:
// data-models/cloud_provider_port.proto (+ CUE constraints).
//
// Naming: the capability-port string is `CapabilityPortKind` — deliberately
// NOT `PortKind`, which in core is the structural port classification
// ("runtime" | "provider" | "port"). Provider packages may keep a local
// `PortKind` alias for back-compat, but new code should say which kind it
// means.

// public-contract: extension-point id for provider plugins (extension-points.md).
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

/**
 * Capability port kind as used by the control-plane CloudProvider contract:
 * "compute" | "kv" | "objectStore" | ... — an open vocabulary (providers may
 * advertise ports Matching does not know yet), distinct from core's
 * structural `PortKind`.
 */
export type CapabilityPortKind = string;

export type Outputs = JsonObject;

/** Requested capability shape a provider must satisfy/negotiate. */
export interface PortRequest {
	port: CapabilityPortKind;
	features?: string[];
	negotiation?: "prefer" | "require";
	region?: string;
}

/** Capability-negotiation verdict: full | partial(missing) | none. */
export type Match =
	| { kind: "full" }
	| { kind: "partial"; missing: string[] }
	| { kind: "none" };

/** Plan-time marginal-cost signal the Dispatcher ranks candidates by. */
export interface CostSignal {
	currency: string;
	sku: string;
	unit: string;
	marginalPrice: string;
	/** Ranking hint provenance; financial admission still requires scoped quotes. */
	pricingStatus?: "unknown" | "estimate" | "verified-zero";
	freeTier: { unit: string; included: number; reset: string };
}

export interface Capability {
	port: CapabilityPortKind;
	satisfies(req: PortRequest): Match;
	estimateCost(req: PortRequest): CostSignal;
}

/**
 * The published `/.well-known/capability-manifest/*` documents, keyed by
 * pathname. Provider packages narrow this to their literal document set;
 * the registry accepts any pathname→serialized-JSON record.
 */
export type PublishedManifestDocuments = Record<string, string>;

/** Machine-readable capability manifest handle (control-plane.md Plan 6). */
export interface CapabilityManifest {
	providerId: string;
	published: PublishedManifestDocuments;
	capabilities: JsonObject;
	auth: JsonObject;
	cost: JsonObject;
}

/** Runtime binding client returned for `ctx.bindings`. */
export interface ProviderClient {
	port: CapabilityPortKind;
	resourceClass: string;
	providerService: string;
	bindings: Outputs;
}

/**
 * Provider-scoped typed-options block (`.with(...)`, ADR-0007). The concrete
 * shape is provider-owned; at the port boundary it is an opaque record.
 */
export type TypedOptionBlock = JsonObject;

// domain-view: structural IaC resource DTO shared across provider emit sides;
// the executing IaC adapter validates the full program wire form.
export interface IacResource {
	name: string;
	type: string;
	provider: string;
	inputs: JsonObject;
	outputs: string[];
}

// public-contract: IaC program wire-shape ids (hobo.iac-program/v1).
export const IAC_PROGRAM_API_VERSION = "hobo.iac-program/v1";
export const IAC_PROGRAM_KIND = "iac-program";

/**
 * The provider-neutral IaC program a provider's `realize()` emits. Provider
 * packages narrow `provider` to their pinned IaC backend; the executor
 * (`@hobo/cloud`) consumes this structural shape.
 */
export interface IacProgramDocument {
	apiVersion: typeof IAC_PROGRAM_API_VERSION;
	kind: typeof IAC_PROGRAM_KIND;
	provider: string;
	deploymentId: string;
	stack: string;
	resources: IacResource[];
	stackOutputs: Record<string, string>;
}

/** Build artifacts a realization needs produced before apply. */
export interface BuildSpec {
	kind: "hobo.build-spec/v1";
	artifacts: Array<{ id: string; source: string; target: string }>;
}

/** What `realize()` returns: an IaC program plus optional build work. */
export interface RealizedResources {
	iac: IacProgramDocument;
	build?: BuildSpec;
}

// Provider-neutral resource emitted by the Planner (control-plane.md Plan 8:
// ResourcePlan{ name, port, provider, options, deps, strategy }).
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
}

/**
 * The canonical provider contract. A provider package exports a
 * `create<Name>Provider(): CloudProvider` factory; registration and the
 * `provider.Registered`/`provider.Approved` lifecycle stay host-side
 * (`@hobo/cloud` catalog, `packages/hobo` installables/plugin loader).
 */
export interface CloudProvider {
	id: string;
	regions: string[];
	capabilities: Capability[];
	realize(plan: ResourcePlan): RealizedResources;
	capabilityManifest(): CapabilityManifest;
	client(port: CapabilityPortKind, outputs: Outputs): ProviderClient;
}
