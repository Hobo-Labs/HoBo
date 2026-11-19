import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Providers } from "@alchemy.run/cloudflare/Providers";
import { Bucket } from "@alchemy.run/cloudflare/R2/Bucket";
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
	type CloudflareKvGrantClaim,
	type CloudflareKvNamespaceClaim,
	cloudflareNativeKvBindleMappers,
} from "./cloudflare-native-kv.js";
import {
	type CloudflareR2Grant,
	cloudflareR2Grant,
} from "./cloudflare-r2-protocol.js";
import {
	type CloudflareBindleEntrypoint,
	cloudflareR2Configuration,
} from "./cloudflare-runtime.js";
import { AlchemyIacError } from "./plan.js";
import {
	type AlchemySourceClaim,
	type AlchemySourceRequirement,
	captureAlchemySourceFence,
	registerAlchemySource,
	verifyAlchemySourceFence,
} from "./source-fence.js";

export interface CloudflareR2BucketClaim {
	readonly bindleName: string;
	readonly resourceName: string;
	readonly bucketEpoch: string;
	readonly resourceId: string;

	readonly legacyResourceId: string;
}

export interface CloudflareR2GrantClaim {
	readonly bucket: CloudflareR2BucketClaim;
	readonly proxyResourceId: string;
	readonly grantEpoch: string;
	readonly allow: readonly string[];
}

export function cloudflareR2BucketClaim(
	bindleName: string,
	resourceName: string,
	bucketEpoch: string,
): CloudflareR2BucketClaim {
	/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: identities cross the trusted-host boundary and must not be coerced. */
	if (
		typeof bindleName !== "string" ||
		bindleName.length === 0 ||
		bindleName.length > 200 ||
		bindleName.trim() !== bindleName ||
		/[\p{Cc}]/u.test(bindleName) ||
		typeof resourceName !== "string" ||
		resourceName.length === 0 ||
		resourceName.length > 200 ||
		resourceName.trim() !== resourceName ||
		/[\p{Cc}]/u.test(resourceName) ||
		typeof bucketEpoch !== "string" ||
		!/^sha256:[a-f0-9]{64}$/u.test(bucketEpoch)
	)
		throw new AlchemyIacError(
			"R2_BUCKET_INVALID",
			"bucket identity is invalid",
		);
	/* oxlint-enable anti-slop/no-runtime-typeof */
	const id = createHash("sha256")
		.update(JSON.stringify([bindleName, resourceName, bucketEpoch]))
		.digest("hex");
	return Object.freeze({
		bindleName,
		resourceName,
		bucketEpoch,
		resourceId: `hobo-r2bucket-${id}`,
		legacyResourceId: resourceName,
	});
}

export function cloudflareR2ProxySource(
	bindleName: string,
	resourceName: string,
	grant: CloudflareR2Grant & { readonly allow: readonly string[] },
): AlchemySourceRequirement {
	if (
		/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: the host grant is checked before inspecting its properties. */
		typeof grant !== "object" ||
		grant === null ||
		Array.isArray(grant) ||
		Object.getOwnPropertySymbols(grant).length !== 0
	)
		throw new AlchemyIacError(
			"R2_GRANT_INVALID",
			"a plain proxy grant is required",
		);
	const fields = Object.getOwnPropertyDescriptors(grant);
	const epoch = fields.grantEpoch;
	const bucket = fields.bucketEpoch;
	const allow = fields.allow;
	if (
		Object.keys(fields).length !== 3 ||
		epoch === undefined ||
		!("value" in epoch) ||
		!epoch.enumerable ||
		bucket === undefined ||
		!("value" in bucket) ||
		!bucket.enumerable ||
		allow === undefined ||
		!("value" in allow) ||
		!allow.enumerable
	)
		throw new AlchemyIacError(
			"R2_GRANT_INVALID",
			"a plain proxy grant is required",
		);
	const checked = cloudflareR2Grant(allow.value, epoch.value, bucket.value);
	cloudflareR2BucketClaim(bindleName, resourceName, checked.bucketEpoch);
	const id = createHash("sha256")
		.update(
			JSON.stringify([
				bindleName,
				resourceName,
				checked.bucketEpoch,
				checked.grantEpoch,
				checked.allow,
			]),
		)
		.digest("hex")
		.slice(0, 32);
	const suffix = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
	return Object.freeze({
		resourceId: `hobo-r2-${id}`,
		resourceType: "Cloudflare.Worker",
		bindleName,
		applicationName: resourceName,
		sourceKind: "cloudflare-r2-proxy",
		sourcePath: fileURLToPath(
			new URL(`./cloudflare-r2-proxy${suffix}`, import.meta.url),
		),
	});
}

export function cloudflareNativeR2BindleMappers<Requirements>(
	options: CloudflareBindleMappingOptions & {
		readonly verifyBucket: (claim: CloudflareR2BucketClaim) => boolean;

		readonly verifyGrant: (claim: CloudflareR2GrantClaim) => boolean;

		readonly kv?: {
			readonly verifyNamespace: (claim: CloudflareKvNamespaceClaim) => boolean;
			readonly verifyGrant: (claim: CloudflareKvGrantClaim) => boolean;
		};
	},
) {
	const verifyBucket = options.verifyBucket;
	const verifyGrant = options.verifyGrant;
	const kv = options.kv;
	const fence = captureAlchemySourceFence(options.sourceFence);
	const projectRoot = options.projectRoot;
	const flagshipFlags = options.flagshipFlags;
	let baseOptions: CloudflareBindleMappingOptions = {
		workerModules: options.workerModules,
	};
	if (projectRoot !== undefined) baseOptions = { ...baseOptions, projectRoot };
	if (fence !== undefined) baseOptions = { ...baseOptions, sourceFence: fence };
	if (flagshipFlags !== undefined)
		baseOptions = { ...baseOptions, flagshipFlags };
	const base =
		kv === undefined
			? cloudflareBindleMappers<Requirements>(baseOptions)
			: cloudflareNativeKvBindleMappers<Requirements>({
					...baseOptions,
					verifyNamespace: kv.verifyNamespace,
					verifyGrant: kv.verifyGrant,
				});
	const sourceBinding = (
		input: AlchemyPrimitiveInput<CloudflareBindleEntrypoint, Requirements>,
		grant: CloudflareR2Grant & { readonly allow: readonly string[] },
	) => {
		if (fence === undefined)
			throw new AlchemyIacError(
				"SOURCE_FENCE_REQUIRED",
				"a trusted immutable source and environment fence is required for the R2 proxy",
			);
		const bucket = cloudflareR2BucketClaim(
			input.bindleName,
			input.declaration.name,
			grant.bucketEpoch,
		);
		const bucketVerified = () => {
			try {
				return verifyBucket(bucket) === true;
			} catch {
				return false;
			}
		};
		if (!bucketVerified())
			throw new AlchemyIacError(
				"R2_BUCKET_UNVERIFIED",
				"the host did not authorize bucket ownership and migration",
			);
		const claim: AlchemySourceClaim = Object.freeze({
			...cloudflareR2ProxySource(
				input.bindleName,
				input.declaration.name,
				grant,
			),
			sourceDigest: fence.sourceDigest,
			environmentDigest: fence.environmentDigest,
			proofRef: fence.proofRef,
		});
		const grantClaim: CloudflareR2GrantClaim = Object.freeze({
			bucket,
			proxyResourceId: claim.resourceId,
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
				"R2_GRANT_UNVERIFIED",
				"the host did not authorize this exact grant incarnation",
			);
		if (!verifyAlchemySourceFence(fence, claim))
			throw new AlchemyIacError(
				"SOURCE_FENCE_UNVERIFIED",
				"the host did not fence this exact R2 proxy source",
			);
		return {
			claim,
			bucket,
			verify: (value: AlchemySourceClaim) =>
				verifyAlchemySourceFence(fence, value) &&
				bucketVerified() &&
				grantVerified(),
		};
	};
	const bucket: AlchemyPrimitiveMapper<
		CloudflareBindleEntrypoint,
		Requirements,
		Providers
	> = {
		resourceTypes: ["Cloudflare.R2.Bucket", "Cloudflare.Worker"],
		operations: ["read", "write", "delete"],
		annotations: ["cloudflare:bounded-r2"],
		bindsEntrypoint: false,
		limitations: [
			"Opt-in bounded JavaScript objects only; WASI, blob events, subscriptions, presigned URLs, ranges and multipart are unsupported.",
		],
		validate(input) {
			base.bucket.validate?.(input);
			const grant = cloudflareR2Configuration(input.declaration);
			sourceBinding(input, grant);
		},
		build(input) {
			const grant = cloudflareR2Configuration(input.declaration);
			const source = sourceBinding(input, grant);
			return Effect.gen(function* () {
				const objectStore = yield* Bucket(source.bucket.resourceId, {
					publicAccess: false,
				});
				const proxy = yield* Worker(source.claim.resourceId, {
					main: source.claim.sourcePath,
					workersDev: false,
					domain: null,
					routes: [],
					env: {
						HOBO_R2_BUCKET: objectStore,
						HOBO_R2_ALLOW: grant.allow.join(","),
					},
				});
				registerAlchemySource(proxy, source);
				return {
					primary: proxy,
					resources: [objectStore, proxy],
					boundDependencies: [],
				};
			});
		},
	};
	return { ...base, bucket };
}
