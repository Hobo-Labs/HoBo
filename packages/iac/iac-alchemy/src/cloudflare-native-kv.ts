import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Namespace } from "@alchemy.run/cloudflare/KV/Namespace";
import type { Providers } from "@alchemy.run/cloudflare/Providers";
import { Worker } from "@alchemy.run/cloudflare/Workers/Worker";
import * as Effect from "effect/Effect";
import type {
	AlchemyPrimitiveInput,
	AlchemyPrimitiveMapper,
} from "./bindle.js";
import {
	type CloudflareBindleMappingOptions,
	cloudflareBindleMappers,
} from "./cloudflare.js";
import {
	type CloudflareBindleEntrypoint,
	cloudflareKvConfiguration,
} from "./cloudflare-runtime.js";
import { AlchemyIacError } from "./plan.js";
import {
	type AlchemySourceClaim,
	type AlchemySourceRequirement,
	captureAlchemySourceFence,
	registerAlchemySource,
	verifyAlchemySourceFence,
} from "./source-fence.js";

/** Exact private Worker identity for the host's independently authenticated source inventory. */
export function cloudflareKvProxySource(
	bindleName: string,
	resourceName: string,
): AlchemySourceRequirement {
	const id = createHash("sha256")
		.update(JSON.stringify([bindleName, resourceName]))
		.digest("hex")
		.slice(0, 32);
	const suffix = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
	return Object.freeze({
		resourceId: `hobo-kv-${id}`,
		resourceType: "Cloudflare.Worker",
		bindleName,
		applicationName: resourceName,
		sourceKind: "cloudflare-kv-proxy",
		sourcePath: fileURLToPath(
			new URL(`./cloudflare-kv-proxy${suffix}`, import.meta.url),
		),
	});
}

/**
 * Opt in to a bounded, eventual JavaScript KV subset. The native namespace is
 * held by a private service Worker, never by the application Worker.
 */
export function cloudflareNativeKvBindleMappers<Requirements>(
	options: CloudflareBindleMappingOptions,
) {
	const base = cloudflareBindleMappers<Requirements>(options);
	const fence = captureAlchemySourceFence(options.sourceFence);
	const sourceBinding = (
		input: AlchemyPrimitiveInput<CloudflareBindleEntrypoint, Requirements>,
	) => {
		if (fence === undefined)
			throw new AlchemyIacError(
				"SOURCE_FENCE_REQUIRED",
				"a trusted immutable source and environment fence is required for the KV proxy",
			);
		const claim: AlchemySourceClaim = Object.freeze({
			...cloudflareKvProxySource(input.bindleName, input.declaration.name),
			sourceDigest: fence.sourceDigest,
			environmentDigest: fence.environmentDigest,
			proofRef: fence.proofRef,
		});
		if (!verifyAlchemySourceFence(fence, claim))
			throw new AlchemyIacError(
				"SOURCE_FENCE_UNVERIFIED",
				"the host did not fence this exact KV proxy source",
			);
		return {
			claim,
			verify: (value: AlchemySourceClaim) =>
				verifyAlchemySourceFence(fence, value),
		};
	};
	const kv: AlchemyPrimitiveMapper<
		CloudflareBindleEntrypoint,
		Requirements,
		Providers
	> = {
		resourceTypes: ["Cloudflare.KV.Namespace", "Cloudflare.Worker"],
		operations: ["get", "set", "delete"],
		annotations: ["cloudflare:eventual-kv"],
		bindsEntrypoint: false,
		limitations: [
			"Worker JavaScript only; eventual visibility and read-only or write-only grants; WASI guests and read-your-writes are unsupported.",
		],
		validate(input) {
			base.kv.validate?.(input);
			cloudflareKvConfiguration(input.declaration);
			sourceBinding(input);
		},
		build(input) {
			const config = cloudflareKvConfiguration(input.declaration);
			const source = sourceBinding(input);
			return Effect.gen(function* () {
				const namespace = yield* Namespace(input.declaration.name, {});
				const proxy = yield* Worker(source.claim.resourceId, {
					main: source.claim.sourcePath,
					workersDev: false,
					domain: null,
					routes: [],
					env: {
						HOBO_KV_NAMESPACE: namespace,
						HOBO_KV_MODE: config.mode,
						HOBO_KV_ALLOW: config.allow.join(","),
					},
				});
				registerAlchemySource(proxy, source);
				return {
					primary: proxy,
					resources: [namespace, proxy],
					boundDependencies: [],
				};
			});
		},
	};
	return { ...base, kv };
}
