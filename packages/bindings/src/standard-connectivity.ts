/**
 * First-party connectivity implementations.
 *
 * Every entry here binds an already-provisioned capability into a workload. None
 * of them provision anything — that is the point of the split.
 */
import type { ConnectivityImplementation } from "./binding.js";

const CHECKED = "2026-08-08";

export const STANDARD_CONNECTIVITY: readonly ConnectivityImplementation[] = [
	{
		id: "cloudflare.postgres.hyperdrive/v1",
		consumesBindingProfiles: ["binding.postgresql/v1"],
		runtimeModels: ["serverless_faas", "wasm"],
		providerId: "cloudflare",
		projection: "provider-binding",
		requiresProviderResource: "cloudflare.temporary-hyperdrive/v1",
		sourceRefs: [
			{
				url: "https://developers.cloudflare.com/workers/databases/third-party-integrations/neon/",
				checkedAt: CHECKED,
			},
		],
	},
	{
		id: "cloudflare.postgres.neon-serverless/v1",
		consumesBindingProfiles: [
			"binding.neon-serverless/v1",
			"binding.postgresql/v1",
		],
		runtimeModels: ["serverless_faas", "wasm"],
		providerId: "cloudflare",
		projection: "environment-secret-ref",
		sourceRefs: [
			{
				url: "https://developers.cloudflare.com/workers/databases/third-party-integrations/neon/",
				checkedAt: CHECKED,
			},
		],
	},
	{
		id: "cloudflare.redis.upstash-rest/v1",
		consumesBindingProfiles: ["binding.redis-rest/v1"],
		runtimeModels: ["serverless_faas", "wasm"],
		providerId: "cloudflare",
		projection: "environment-secret-ref",
		sourceRefs: [
			{
				url: "https://upstash.com/docs/redis/sdks/ts/getstarted",
				checkedAt: CHECKED,
			},
		],
	},
	{
		id: "vercel.postgres.environment-ref/v1",
		consumesBindingProfiles: ["binding.postgresql/v1"],
		runtimeModels: ["serverless_faas", "paas"],
		providerId: "vercel",
		projection: "environment-secret-ref",
		sourceRefs: [
			{
				url: "https://vercel.com/docs/environment-variables",
				checkedAt: CHECKED,
			},
		],
	},
	{
		id: "netlify.postgres.environment-ref/v1",
		consumesBindingProfiles: ["binding.postgresql/v1"],
		runtimeModels: ["serverless_faas", "paas"],
		providerId: "netlify",
		projection: "environment-secret-ref",
		sourceRefs: [
			{
				url: "https://docs.netlify.com/api-and-cli-guides/cli-guides/get-started-with-cli/",
				checkedAt: CHECKED,
			},
		],
	},
	{
		id: "oci.service-binding-files/v1",
		consumesBindingProfiles: [
			"binding.postgresql/v1",
			"binding.redis-protocol/v1",
			"binding.s3/v1",
			"binding.service-files/v1",
			"binding.convex/v1",
		],
		runtimeModels: ["oci"],
		projection: "service-binding-files",
		sourceRefs: [
			{ url: "https://servicebinding.io/spec/core/1.1.0/", checkedAt: CHECKED },
		],
	},
	{
		id: "vm.service-binding-files/v1",
		consumesBindingProfiles: [
			"binding.postgresql/v1",
			"binding.redis-protocol/v1",
			"binding.service-files/v1",
		],
		runtimeModels: ["vm_iaas"],
		projection: "service-binding-files",
		sourceRefs: [
			{ url: "https://servicebinding.io/spec/core/1.1.0/", checkedAt: CHECKED },
		],
	},
	{
		id: "wasm.wasi-config-binding/v1",
		consumesBindingProfiles: ["binding.wasi-config/v1", "binding.http/v1"],
		runtimeModels: ["wasm"],
		projection: "wasi-config",
		sourceRefs: [
			{
				url: "https://github.com/WebAssembly/wasi-config",
				checkedAt: CHECKED,
			},
		],
	},
];
