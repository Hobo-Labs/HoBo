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
	type CloudflareKvGrant,
	cloudflareKvGrant,
} from "./cloudflare-kv-protocol.js";
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

export interface CloudflareKvNamespaceClaim {
	readonly bindleName: string;
	readonly resourceName: string;
	readonly namespaceEpoch: string;
	readonly resourceId: string;
}

export interface CloudflareKvGrantClaim {
	readonly namespace: CloudflareKvNamespaceClaim;
	readonly proxyResourceId: string;
	readonly mode: CloudflareKvGrant["mode"];
	readonly grantEpoch: string;
	readonly allow: readonly string[];
}

/** Resolve a stable namespace identity. The host must independently authenticate ownership. */
export function cloudflareKvNamespaceClaim(
	bindleName: string,
	resourceName: string,
	namespaceEpoch: string,
): CloudflareKvNamespaceClaim {
	if (
		!/^sha256:[a-f0-9]{64}$/u.test(namespaceEpoch) ||
		bindleName.length === 0 ||
		bindleName.length > 200 ||
		resourceName.length === 0 ||
		resourceName.length > 200
	)
		throw new AlchemyIacError(
			"KV_NAMESPACE_INVALID",
			"namespace identity is invalid",
		);
	const id = createHash("sha256")
		.update(JSON.stringify([bindleName, resourceName, namespaceEpoch]))
		.digest("hex");
	return Object.freeze({
		bindleName,
		resourceName,
		namespaceEpoch,
		resourceId: `hobo-kvns-${id}`,
	});
}

/** Exact private Worker identity for the host's independently authenticated source inventory. */
export function cloudflareKvProxySource(
	bindleName: string,
	resourceName: string,
	grant: CloudflareKvGrant & { readonly allow: readonly string[] },
): AlchemySourceRequirement {
	const fields = Object.getOwnPropertyDescriptors(grant);
	const mode = fields.mode;
	const epoch = fields.grantEpoch;
	const namespace = fields.namespaceEpoch;
	const allow = fields.allow;
	if (
		Object.getOwnPropertySymbols(grant).length !== 0 ||
		Object.keys(fields).length !== 4 ||
		mode === undefined ||
		!("value" in mode) ||
		!mode.enumerable ||
		epoch === undefined ||
		!("value" in epoch) ||
		!epoch.enumerable ||
		namespace === undefined ||
		!("value" in namespace) ||
		!namespace.enumerable ||
		allow === undefined ||
		!("value" in allow) ||
		!allow.enumerable
	)
		throw new AlchemyIacError(
			"KV_GRANT_INVALID",
			"the proxy grant must be plain data",
		);
	const checked = cloudflareKvGrant(
		mode.value,
		epoch.value,
		namespace.value,
		allow.value,
	);
	const id = createHash("sha256")
		.update(
			JSON.stringify([
				bindleName,
				resourceName,
				checked.mode,
				checked.grantEpoch,
				checked.namespaceEpoch,
				checked.allow,
			]),
		)
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
	options: CloudflareBindleMappingOptions & {
		/**
		 * Trusted host authority, bound by its closure to the exact tenant,
		 * target, stack, stage and provider account. Authenticate namespace
		 * ownership and migration and fence them through provider completion.
		 * The host composite guard must independently match that scope.
		 */
		readonly verifyNamespace: (claim: CloudflareKvNamespaceClaim) => boolean;
		/** Authenticate grant ownership, exact permissions, epoch non-reuse and retirement. */
		readonly verifyGrant: (claim: CloudflareKvGrantClaim) => boolean;
	},
) {
	const base = cloudflareBindleMappers<Requirements>(options);
	const fence = captureAlchemySourceFence(options.sourceFence);
	const verifyNamespace = options.verifyNamespace;
	const verifyGrant = options.verifyGrant;
	const sourceBinding = (
		input: AlchemyPrimitiveInput<CloudflareBindleEntrypoint, Requirements>,
		grant: CloudflareKvGrant & { readonly allow: readonly string[] },
	) => {
		if (fence === undefined)
			throw new AlchemyIacError(
				"SOURCE_FENCE_REQUIRED",
				"a trusted immutable source and environment fence is required for the KV proxy",
			);
		const namespace = cloudflareKvNamespaceClaim(
			input.bindleName,
			input.declaration.name,
			grant.namespaceEpoch,
		);
		const namespaceVerified = () => {
			try {
				return verifyNamespace(namespace) === true;
			} catch {
				return false;
			}
		};
		if (!namespaceVerified())
			throw new AlchemyIacError(
				"KV_NAMESPACE_UNVERIFIED",
				"the host did not authorize namespace ownership and migration",
			);
		const claim: AlchemySourceClaim = Object.freeze({
			...cloudflareKvProxySource(
				input.bindleName,
				input.declaration.name,
				grant,
			),
			sourceDigest: fence.sourceDigest,
			environmentDigest: fence.environmentDigest,
			proofRef: fence.proofRef,
		});
		const grantClaim: CloudflareKvGrantClaim = Object.freeze({
			namespace,
			proxyResourceId: claim.resourceId,
			mode: grant.mode,
			grantEpoch: grant.grantEpoch,
			allow: grant.allow,
		});
		const grantVerified = () => {
			try {
				return verifyGrant(grantClaim) === true;
			} catch {
				return false;
			}
		};
		if (!grantVerified())
			throw new AlchemyIacError(
				"KV_GRANT_UNVERIFIED",
				"the host did not authorize this exact grant incarnation",
			);
		if (!verifyAlchemySourceFence(fence, claim))
			throw new AlchemyIacError(
				"SOURCE_FENCE_UNVERIFIED",
				"the host did not fence this exact KV proxy source",
			);
		return {
			claim,
			namespace,
			verify: (value: AlchemySourceClaim) =>
				verifyAlchemySourceFence(fence, value) &&
				namespaceVerified() &&
				grantVerified(),
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
			const grant = cloudflareKvConfiguration(input.declaration);
			sourceBinding(input, grant);
		},
		build(input) {
			const config = cloudflareKvConfiguration(input.declaration);
			const source = sourceBinding(input, config);
			return Effect.gen(function* () {
				const namespace = yield* Namespace(source.namespace.resourceId, {});
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
