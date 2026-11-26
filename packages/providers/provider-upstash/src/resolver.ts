import { parseSecretRef } from "@hobo/bindings";
import {
	type ClaimableOperationKeyDeriver,
	claimableOperationKey,
	claimablePublicResourceId,
	claimableResourceRef,
	createClaimableResourceResolver,
	RESOLVER_CONTRACT,
	type ResolveOutcome,
	type ResolveRequest,
} from "@hobo/core";
import {
	depositSecret,
	resolveSecret,
	type SecretCustodyPort,
	type SecretResolverPort,
} from "./custody.js";
import { UPSTASH_DEFINITION_ID, UPSTASH_PROVIDER_ID } from "./definition.js";
import type {
	UpstashTemporaryRedis,
	UpstashTemporaryRedisDriver,
} from "./driver.js";
import { isJsonString } from "./json.js";

type Composition = Parameters<typeof createClaimableResourceResolver>[0];

export function createUpstashTemporaryRedisResolver(
	options: Pick<
		Composition,
		"scope" | "repository" | "journal" | "clock" | "retire"
	> & {
		readonly driver: UpstashTemporaryRedisDriver;
		readonly custody: SecretCustodyPort;
		readonly secretResolver: SecretResolverPort;
		readonly deriveOperationKey: ClaimableOperationKeyDeriver;
	},
) {
	const config = Object.freeze({
		...options,
		scope: Object.freeze({ ...options.scope }),
	});

	async function input(request: ResolveRequest) {
		if (
			Object.keys(request.desired).some(
				(field) => field !== "idempotencyKey",
			) ||
			!isJsonString(request.desired.idempotencyKey) ||
			request.desired.idempotencyKey.length < 1 ||
			request.desired.idempotencyKey.length > 128
		)
			throw new Error(
				"Upstash temporary product requires only its stable UUID idempotency key",
			);
		const operationKey = await claimableOperationKey(
			config.scope,
			request,
			config.deriveOperationKey,
		);
		return {
			resourceRef: await claimableResourceRef(config.scope, request),
			idempotencyKey: operationKey,
		};
	}
	async function project(
		request: ResolveRequest,
		record: UpstashTemporaryRedis,
		action: ResolveOutcome["action"],
	): Promise<ResolveOutcome> {
		const resource = await input(request);
		const publicId = await claimablePublicResourceId(
			record.databaseId,
			resource.idempotencyKey,
		);
		const nativeIdentity = await depositSecret(
			config.custody,
			record.databaseId,
			{
				providerId: UPSTASH_PROVIDER_ID,
				resourceRef: resource.resourceRef,
				purpose: "native-resource-id",
			},
		);
		const claim = await depositSecret(config.custody, record.claim.claimUrl, {
			providerId: UPSTASH_PROVIDER_ID,
			resourceRef: `${config.scope.scopeId}/${record.resourceRef}`,
			purpose: "claim-url",
		});
		const binding = record.binding
			? await depositSecret(config.custody, JSON.stringify(record.binding), {
					providerId: UPSTASH_PROVIDER_ID,
					resourceRef: `${config.scope.scopeId}/${record.resourceRef}`,
					purpose: "capability-binding",
				})
			: undefined;
		const ready = record.expiresAtMs > config.clock();
		const projected: ResolveOutcome = {
			contract: RESOLVER_CONTRACT,
			action,
			physicalId: publicId,
			outputs: {
				endpointFingerprint: await claimablePublicResourceId(
					record.restEndpointHost,
					resource.idempotencyKey,
				),
				nativeIdentityRef: nativeIdentity.ref,
				observedAtMs: record.observedAtMs,
				expiresAtMs: record.expiresAtMs,
				expirySource: record.expirySource,
				claimRef: claim.ref,
				...(binding ? { bindingRef: binding.ref } : undefined),
				ready,
				operationConfirmed: ready,
				lifecycleStatus: ready ? "ready" : "unknown",
			},
			diagnostics: [],
		};
		let serialized = JSON.stringify(projected);
		for (;;) {
			const decoded = serialized.replace(/%[a-f0-9]{2}/giu, (encoded) =>
				String.fromCharCode(Number.parseInt(encoded.slice(1), 16)),
			);
			if (decoded === serialized) break;
			serialized = decoded;
		}
		serialized = serialized.toLowerCase().replaceAll("-", "");
		for (const hidden of [record.databaseId, resource.idempotencyKey])
			if (serialized.includes(hidden.toLowerCase().replaceAll("-", "")))
				throw new Error(
					"anonymous provider custody returned a capability-bearing public locator",
				);
		return projected;
	}
	async function privateCall<T>(work: () => Promise<T>): Promise<T> {
		try {
			return await work();
		} catch {
			throw new Error(
				"upstash claimable provider outcome is unconfirmed; native capability details are private",
			);
		}
	}
	async function nativeId(
		initial: ResolveOutcome,
		operationKey: string,
	): Promise<string> {
		const ref = initial.outputs.nativeIdentityRef;
		if (!isJsonString(ref))
			throw new Error("anonymous resource lacks native identity custody");
		const native = (
			await resolveSecret(config.secretResolver, parseSecretRef(ref).ref)
		).expose();
		if (
			(await claimablePublicResourceId(native, operationKey)) !==
			initial.physicalId
		)
			throw new Error("anonymous native identity custody changed");
		return native;
	}
	const retire = config.retire;

	return createClaimableResourceResolver({
		...config,
		...(retire
			? {
					retire: (request, initial, context) =>
						privateCall(() => retire(request, initial, context)),
				}
			: undefined),
		async bindingFingerprint(request) {
			const resource = await input(request);
			return claimablePublicResourceId(
				"operation-binding",
				resource.idempotencyKey,
			);
		},
		providerId: UPSTASH_PROVIDER_ID,
		productId: UPSTASH_DEFINITION_ID,
		async validate(request) {
			await input(request);
		},
		providerIdempotentCreate: true,
		async provision(request) {
			return privateCall(async () =>
				project(
					request,
					await config.driver.provision(await input(request)),
					"create",
				),
			);
		},
		async observe(request, initial) {
			return privateCall(async () => {
				const resource = await input(request);
				const native = await nativeId(initial, resource.idempotencyKey);
				await config.driver.observeMetrics(native);
				const ready = Number(initial.outputs.expiresAtMs) > config.clock();
				return {
					...initial,
					action: "adopt",
					outputs: {
						...initial.outputs,
						ready,
						operationConfirmed: ready,
						lifecycleStatus: ready ? "ready" : "unknown",
						observedAtMs: config.clock(),
					},
				};
			});
		},
	});
}
