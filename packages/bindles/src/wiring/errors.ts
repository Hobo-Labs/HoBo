import type { BindingMeta } from "./types.js";

export class BindReferenceError extends Error {
	readonly path: string;

	constructor(path: string, message: string) {
		super(`${path}: ${message}`);
		this.name = "BindReferenceError";
		this.path = path;
	}
}

export interface ResourceHandle {
	readonly kind: "resource";
	readonly name: string;
	readonly type: string;
	readonly port: string;
	readonly clientType: string;
	manifest(): import("./types.js").ManifestResource;
}

// domain-view: mutable container endpoint bag, not the wire Endpoint message.
export interface EndpointRecord {
	scheme: string;
	port: number;
	targetPort: number;
	external: boolean;
	protocol: string;
}

export interface VolumeAnnotation {
	name: string;
	target: string;
}

export interface BindMountAnnotation {
	source: string;
	target: string;
	readOnly: boolean;
}

// domain-view: wait-for annotation stored on ComponentHandle, not the wire WaitAnnotation message.
export interface WaitForEntry {
	to: string;
	until: string;
}

export interface HealthAnnotation {
	type: string;
	path: string;
}

export type AnnotationValue =
	| string
	| EndpointRecord
	| HealthAnnotation
	| VolumeAnnotation[]
	| BindMountAnnotation[]
	| WaitForEntry[]
	| string[];

export interface HandleEndpointBag {
	[key: string]: EndpointRecord;
}

export interface HandleAnnotationBag {
	[key: string]: AnnotationValue;
}

export interface ComponentHandle {
	readonly kind: "service" | "container";
	readonly name: string;
	readonly bindings: Readonly<Record<string, BindingMeta>>;
	readonly env: Record<string, string>;
	readonly endpoints: HandleEndpointBag;
	readonly annotations: HandleAnnotationBag;
	readonly typescript: { readonly ctxBindings: string };
	binding(alias: string): BindingMeta;
	manifest(): import("./types.js").ManifestResource;
	withEndpoint?(endpoint: EndpointSpec): ComponentHandle;
	withEnvironment?(key: string, value: string): ComponentHandle;
	withVolume?(name: string, target: string): ComponentHandle;
	withHttpHealthCheck?(path: string): ComponentHandle;
	withHttpEndpoint?(
		port: number,
		options?: {
			name?: string;
			targetPort?: number;
			external?: boolean;
			protocol?: string;
		},
	): ComponentHandle;
	withArgs?(...args: readonly (string | readonly string[])[]): ComponentHandle;
	withBindMount?(
		source: string,
		target: string,
		readOnly?: boolean,
	): ComponentHandle;
	withLifetime?(lifetime: "session" | "persistent"): ComponentHandle;
	waitFor?(dependency: DependencyRef): ComponentHandle;
	waitForCompletion?(dependency: DependencyRef): ComponentHandle;
	withDnsRecord?(): never;
}

export type Handle = ResourceHandle | ComponentHandle;

type DependencyRef = string | { readonly name: string };

export type EndpointSpec = {
	readonly name?: string;
	readonly scheme: string;
	readonly port: number;
	readonly targetPort?: number;
	readonly external?: boolean;
	readonly protocol?: string;
};
