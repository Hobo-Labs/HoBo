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
import { CREATE_DB_TTL, PRISMA_REGIONS } from "./cli.js";
import {
	depositSecret,
	resolveSecret,
	type SecretCustodyPort,
	type SecretResolverPort,
} from "./custody.js";
import {
	PRISMA_DEFINITION_ID,
	PRISMA_PROVIDER_ID,
	type PrismaClaimableDatabase,
	type PrismaClaimableDatabaseDriver,
} from "./driver.js";
import { isJsonString } from "./json.js";

type Composition = Parameters<typeof createClaimableResourceResolver>[0];

export function createPrismaClaimableResolver(
	options: Pick<
		Composition,
		"scope" | "repository" | "journal" | "clock" | "retire"
	> & {
		readonly driver: PrismaClaimableDatabaseDriver;
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
			if (!["idempotencyKey", "ttl", "region"].includes(field))
				throw new Error(
					"Prisma temporary product received unsupported desired fields",
				);
		const { idempotencyKey, ttl } = request.desired;
		const region = PRISMA_REGIONS.find(
			(known) => known === request.desired.region,
		);
		if (request.desired.region !== undefined && region === undefined)
			throw new Error(
				"Prisma temporary product received an unsupported region",
			);
		if (
			!isJsonString(idempotencyKey) ||
			idempotencyKey.length < 1 ||
			idempotencyKey.length > 128 ||
			(ttl !== undefined && (!isJsonString(ttl) || !CREATE_DB_TTL.test(ttl)))
		)
			throw new Error(
				"Prisma temporary product requires an explicit stable idempotency key",
			);
		const operationKey = await claimableOperationKey(
			config.scope,
			request,
			config.deriveOperationKey,
		);
		return {
			resourceRef: await claimableResourceRef(config.scope, request),
			idempotencyKey: operationKey,
			...(ttl === undefined ? undefined : { ttl }),
			...(region === undefined ? undefined : { region }),
		};
	}
	async function project(
		request: ResolveRequest,
		record: PrismaClaimableDatabase,
		action: ResolveOutcome["action"],
	): Promise<ResolveOutcome> {
		const resource = await input(request);
		const publicId = await claimablePublicResourceId(
			record.projectId,
			resource.idempotencyKey,
		);
		const nativeIdentity = await depositSecret(
			config.custody,
			record.projectId,
			{
				providerId: PRISMA_PROVIDER_ID,
				resourceRef: resource.resourceRef,
				purpose: "native-resource-id",
			},
		);
		const claim = await depositSecret(config.custody, record.claim.claimUrl, {
			providerId: PRISMA_PROVIDER_ID,
			resourceRef: `${config.scope.scopeId}/${record.resourceRef}`,
			purpose: "claim-url",
		});
		const binding = record.binding
			? await depositSecret(config.custody, JSON.stringify(record.binding), {
					providerId: PRISMA_PROVIDER_ID,
					resourceRef: `${config.scope.scopeId}/${record.resourceRef}`,
					purpose: "capability-binding",
				})
			: undefined;
		// This surface's observe reads its local CLI journal, not the provider.
		const projected: ResolveOutcome = {
			contract: RESOLVER_CONTRACT,
			action,
			physicalId: publicId,
			outputs: {
				endpointFingerprint: await claimablePublicResourceId(
					record.endpoint.host,
					resource.idempotencyKey,
				),
				nativeIdentityRef: nativeIdentity.ref,
				observedAtMs: record.observedAtMs,
				databaseName: record.databaseName,
				expiresAtMs: record.expiresAtMs,
				expirySource: record.expirySource,
				claimRef: claim.ref,
				...(binding ? { bindingRef: binding.ref } : undefined),
				ready: false,
				operationConfirmed: false,
				lifecycleStatus: "unknown",
			},
			diagnostics: [
				"Prisma temporary API has no authoritative control-plane read; independent database validation is required.",
			],
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
		for (const hidden of [record.projectId, resource.idempotencyKey])
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
				"prisma-postgres claimable provider outcome is unconfirmed; native capability details are private",
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
		providerId: PRISMA_PROVIDER_ID,
		productId: PRISMA_DEFINITION_ID,
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
				await nativeId(initial, resource.idempotencyKey);
				// The durable identity survives restart. This API has no native GET;
				// a local CLI journal cannot turn that metadata into fresh readiness.
				return {
					...initial,
					action: "adopt",
					outputs: {
						...initial.outputs,
						ready: false,
						operationConfirmed: false,
						lifecycleStatus: "unknown",
					},
				};
			});
		},
	});
}
