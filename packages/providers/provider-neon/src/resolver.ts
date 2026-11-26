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
import { validateCreateDatabaseInput } from "./client.js";
import {
	depositSecret,
	resolveSecret,
	type SecretCustodyPort,
	type SecretResolverPort,
} from "./custody.js";
import {
	NEON_DEFINITION_ID,
	NEON_PROVIDER_ID,
	type NeonClaimableDatabase,
	type NeonClaimableDatabaseDriver,
} from "./driver.js";
import { isJsonString } from "./json.js";

type Composition = Parameters<typeof createClaimableResourceResolver>[0];

/** The actual claimable driver exposed through HoBo's resolver protocol. */
export function createNeonClaimableResolver(
	options: Pick<
		Composition,
		"scope" | "repository" | "journal" | "clock" | "retire"
	> & {
		readonly driver: NeonClaimableDatabaseDriver;
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
		for (const field of Object.keys(request.desired))
			if (
				!["idempotencyKey", "ref", "enableLogicalReplication"].includes(field)
			)
				throw new Error(
					"Neon claimable product received unsupported desired fields",
				);
		const { idempotencyKey, ref, enableLogicalReplication } = request.desired;
		if (
			!isJsonString(idempotencyKey) ||
			idempotencyKey.length < 1 ||
			idempotencyKey.length > 128 ||
			!isJsonString(ref) ||
			(enableLogicalReplication !== undefined &&
				enableLogicalReplication !== true &&
				enableLogicalReplication !== false)
		)
			throw new Error(
				"Neon claimable product requires an explicit stable idempotency key and referrer",
			);
		const operationKey = await claimableOperationKey(
			config.scope,
			request,
			config.deriveOperationKey,
		);
		validateCreateDatabaseInput({ ref, idempotencyKey: operationKey });
		return {
			resourceRef: await claimableResourceRef(config.scope, request),
			idempotencyKey: operationKey,
			ref,
			...(enableLogicalReplication === undefined
				? undefined
				: { enableLogicalReplication }),
		};
	}
	async function project(
		request: ResolveRequest,
		record: NeonClaimableDatabase,
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
				providerId: NEON_PROVIDER_ID,
				resourceRef: resource.resourceRef,
				purpose: "native-resource-id",
			},
		);
		const claim = await depositSecret(config.custody, record.claim.claimUrl, {
			providerId: NEON_PROVIDER_ID,
			resourceRef: `${config.scope.scopeId}/${record.resourceRef}`,
			purpose: "claim-url",
		});
		const binding = record.binding
			? await depositSecret(config.custody, JSON.stringify(record.binding), {
					providerId: NEON_PROVIDER_ID,
					resourceRef: `${config.scope.scopeId}/${record.resourceRef}`,
					purpose: "capability-binding",
				})
			: undefined;
		const ready =
			record.providerStatus === "UNCLAIMED" &&
			record.expiresAtMs > config.clock();
		const projected: ResolveOutcome = {
			contract: RESOLVER_CONTRACT,
			action,
			physicalId: publicId,
			outputs: {
				endpointFingerprint: await claimablePublicResourceId(
					record.endpoints.pooled.host,
					resource.idempotencyKey,
				),
				nativeIdentityRef: nativeIdentity.ref,
				observedAtMs: record.observedAtMs,
				databaseName: record.databaseName,
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
				"neon claimable provider outcome is unconfirmed; native capability details are private",
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
		providerId: NEON_PROVIDER_ID,
		productId: NEON_DEFINITION_ID,
		async validate(request) {
			await input(request);
		},
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
				const record = await config.driver.observe({
					databaseId: native,
					resourceRef: resource.resourceRef,
				});
				if (
					(await claimablePublicResourceId(
						record.endpoints.pooled.host,
						resource.idempotencyKey,
					)) !== initial.outputs.endpointFingerprint
				)
					throw new Error("native endpoint changed");
				return project(request, record, "adopt");
			});
		},
	});
}
