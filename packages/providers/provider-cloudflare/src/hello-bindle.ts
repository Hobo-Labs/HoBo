import type { JsonObject } from "./json.js";

export const CLOUDFLARE_PROVIDER_TARGET = "cloudflare";

// A `type` alias (not an interface) so it keeps an implicit index signature
// and stays assignable to @hobo/core's opaque `TypedOptionBlock`
// (Record<string, unknown>) on ResourcePlan.options (ADR-0156).
export type TypedOptionBlock = {
	providerId: string;
	port: string;
	optionName: string;
	negotiation: "prefer" | "require";
	options: JsonObject;
};

export const cloudflare = {
	with: {
		worker(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"compute",
				"worker",
				{
					compatibilityDate: "2026-01-01",
					cpuMs: 10_000,
					memoryMb: 128,
					scriptSizeMb: 3,
				},
				options,
			);
		},
		r2(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"objectStore",
				"r2",
				{
					jurisdiction: "auto",
					s3Compatibility: "aws-sdk-v3-basic",
					publicAccess: false,
				},
				options,
			);
		},
		kv(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"kv",
				"kv",
				{
					ttlSeconds: 0,
					eventualConsistency: true,
				},
				options,
			);
		},
	},
};

export interface HelloBindleBind {
	import: string;
	providerResourceId: string;
	capability: string;
}

export interface HelloBindleBuild {
	artifactId: string;
	source: string;
	target: string;
}

export interface HelloBindleResourceNode {
	id: string;
	type: string;
	className: string;
	require: string[];
	colo: string;
	options: TypedOptionBlock[];
	build?: HelloBindleBuild;
	binds?: HelloBindleBind[];
}

// domain-view: richer in-memory hello-bindle plan; its wire form is the generated HelloBindlePlan proto in data-models/.
export interface HelloBindlePlan {
	id: string;
	context: {
		app: string;
		env: string;
		envType: string;
		provider: string;
		colo: string;
	};
	resources: HelloBindleResourceNode[];
}

export interface HelloBindlePlanOptions {
	id?: string;
	env?: string;
	colo?: string;
}

export function createHelloBindlePlan(
	options: HelloBindlePlanOptions = {},
): HelloBindlePlan {
	const colo = options.colo ?? "WNAM";
	return {
		id: options.id ?? "hello-bindle-cloudflare",
		context: {
			app: "hello-bindle",
			env: options.env ?? "preview",
			envType: "ephemeral",
			provider: "@hobo/provider-cloudflare",
			colo,
		},
		resources: [
			{
				id: "service",
				type: "compute",
				className: "worker",
				require: ["edge", "worker", "wasm-native", "http"],
				colo,
				options: [cloudflare.with.worker({ cpuMs: 10_000 })],
				build: {
					artifactId: "hello-bindle-wasm",
					source: "examples/hello-bindle",
					target: "wasm-component",
				},
				binds: [
					{
						import: "wasi:blobstore/blobstore",
						providerResourceId: "assets",
						capability: "objectStore",
					},
					{
						import: "hobo:kv/store",
						providerResourceId: "sessions",
						capability: "kv",
					},
				],
			},
			{
				id: "assets",
				type: "objectStore",
				className: "bucket",
				require: ["durable", "s3-compatible"],
				colo,
				options: [cloudflare.with.r2({ publicAccess: false })],
			},
			{
				id: "sessions",
				type: "kv",
				className: "namespace",
				require: ["eventual", "edge"],
				colo,
				options: [cloudflare.with.kv({ ttlSeconds: 3600 })],
			},
		],
	};
}

function optionBlock(
	port: string,
	builder: string,
	defaults: JsonObject,
	options: JsonObject,
): TypedOptionBlock {
	return {
		providerId: CLOUDFLARE_PROVIDER_TARGET,
		port,
		optionName: builder,
		negotiation: "prefer",
		options: { ...defaults, ...options },
	};
}
