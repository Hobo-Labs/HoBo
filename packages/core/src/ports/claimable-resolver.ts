import { cloneAsJson } from "../json.js";
import type {
	ResourceLifecycleContext,
	ResourceLifecycleObservation,
	ResourceMutationJournal,
} from "./resource-lifecycle.js";
import { parseResourceLifecycleObservation } from "./resource-lifecycle.js";
import type {
	ResolveOutcome,
	ResolveRequest,
	ResourceResolver,
} from "./resource-resolver.js";
import {
	parseResolveOutcome,
	parseResolveRequest,
} from "./resource-resolver.js";

/** Behavioral repository. Persisted values use the provider's generated record
 * codec; observations use ResourceLifecycleObservationRecord. Initial records
 * are immutable and observations advance monotonically under durable CAS. */
// domain-view: behavioral persistence port, not a parallel wire schema.
export interface ResourceRecordRepository<T> {
	readonly persistence: "durable-cas";
	read(key: string): Promise<T | undefined>;
	write(key: string, record: T): Promise<void>;
	readObservation(
		key: string,
	): Promise<ResourceLifecycleObservation | undefined>;
	writeObservation(
		key: string,
		observation: ResourceLifecycleObservation,
	): Promise<void>;
}

export type ClaimableResolverScope = Pick<
	ResourceLifecycleContext,
	"tenantId" | "providerAccountId"
> & {
	/** A deployment incarnation, never just the tenant or logical resource id. */
	readonly scopeId: string;
};

/** Separate logical resources and deployment incarnations at the provider's
 * idempotency boundary as well as in HoBo's journal. UUIDv4 layout supports the
 * anonymous Redis API, whose native database id is its idempotency key. */
async function sha256Hex(value: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export type ClaimableOperationKeyDeriver = (
	scope: ClaimableResolverScope,
	request: ResolveRequest,
) => Promise<string>;

/** Capture private host key bytes once. Public scope/author inputs alone must
 * never determine an anonymous resource's bearer-capability id. */
export function createClaimableOperationKeyDeriver(
	secret: Uint8Array,
): ClaimableOperationKeyDeriver {
	if (secret.byteLength < 32)
		throw new Error(
			"claimable operation keys require at least 256 private host-key bits",
		);
	const captured = new Uint8Array(secret);
	const key = globalThis.crypto.subtle
		.importKey("raw", captured, { name: "HMAC", hash: "SHA-256" }, false, [
			"sign",
		])
		.finally(() => captured.fill(0));
	return async (scope, request) => {
		const material = JSON.stringify([
			"hobo.claimable.operation-key/v2",
			scope.tenantId,
			scope.providerAccountId,
			scope.scopeId,
			request.ref.productId,
			request.ref.logicalId,
			request.desired.idempotencyKey,
		]);
		const signature = await globalThis.crypto.subtle.sign(
			"HMAC",
			await key,
			new TextEncoder().encode(material),
		);
		const digest = Array.from(new Uint8Array(signature), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		const variant = (
			(Number.parseInt(digest.slice(16, 17), 16) & 3) |
			8
		).toString(16);
		const hex = `${digest.slice(0, 12)}4${digest.slice(13, 16)}${variant}${digest.slice(17, 32)}`;
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	};
}

export async function claimableOperationKey(
	scope: ClaimableResolverScope,
	request: ResolveRequest,
	derive: ClaimableOperationKeyDeriver,
): Promise<string> {
	if (!derive)
		throw new Error(
			"a private host-backed claimable operation-key deriver is required",
		);
	let key: string;
	try {
		key = await derive(scope, request);
	} catch {
		throw new Error("private operation-key derivation is unavailable");
	}
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
			key,
		)
	)
		throw new Error(
			"private operation-key derivation returned an invalid identifier",
		);
	return key;
}

/** Public routing handle; the secret operation key prevents offline native-id guessing. */
export async function claimablePublicResourceId(
	nativeId: string,
	operationKey: string,
): Promise<string> {
	return `claimable:${await sha256Hex(JSON.stringify(["hobo.claimable.public-id/v1", operationKey, nativeId]))}`;
}

/** Non-secret custody metadata is separate from provider-native bearer ids. */
export async function claimableResourceRef(
	scope: ClaimableResolverScope,
	request: ResolveRequest,
): Promise<string> {
	return `claimable:${await sha256Hex(JSON.stringify([scope.tenantId, scope.providerAccountId, scope.scopeId, request.ref.productId, request.ref.logicalId]))}`;
}

/** Compose a provider's actual driver with durable once-only create custody.
 * A crash between provider allocation and local acknowledgement is uncertain;
 * it must never cause a second anonymous allocation. */
export function createClaimableResourceResolver(options: {
	readonly providerId: string;
	readonly productId: string;
	readonly scope: ClaimableResolverScope;
	readonly repository: ResourceRecordRepository<ResolveOutcome>;
	readonly journal: ResourceMutationJournal;
	readonly clock: () => number;
	readonly maxObservationAgeMs?: number;
	readonly bindingFingerprint?: (request: ResolveRequest) => Promise<string>;
	/** Validate product-specific inputs before claiming a mutation intent. */
	readonly validate?: (request: ResolveRequest) => void | Promise<void>;
	readonly provision: (request: ResolveRequest) => Promise<ResolveOutcome>;
	readonly observe: (
		request: ResolveRequest,
		initial: ResolveOutcome,
	) => Promise<ResolveOutcome>;
	/** Only providers documenting create idempotency may re-enter after an uncertain write. */
	readonly providerIdempotentCreate?: boolean;
	readonly retire?: (
		request: ResolveRequest,
		initial: ResolveOutcome,
		context: ResourceLifecycleContext,
	) => Promise<ResourceLifecycleObservation>;
}): ResourceResolver {
	const config = Object.freeze({ ...options });
	const scope = Object.freeze({ ...config.scope });
	for (const value of [
		scope.tenantId,
		scope.providerAccountId,
		scope.scopeId,
		config.providerId,
		config.productId,
	]) {
		if (
			!value ||
			value.length > 512 ||
			[...value].some((character) => character.charCodeAt(0) < 32)
		)
			throw new Error(
				"claimable resolver requires a bounded deployment and provider scope",
			);
	}
	if (
		config.repository.persistence !== "durable-cas" ||
		config.journal.persistence !== "durable-cas"
	)
		throw new Error(
			"claimable resolver requires durable CAS custody and mutation journal",
		);
	const maxAgeMs = config.maxObservationAgeMs ?? 60_000;
	if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0)
		throw new Error("claimable observation freshness must be bounded");

	async function identify(input: ResolveRequest) {
		const request = parseResolveRequest(cloneAsJson(input));
		if (request.ref.productId !== config.productId)
			throw new Error("claimable resolver received a foreign product");
		await config.validate?.(request);
		const key = JSON.stringify([
			scope.tenantId,
			config.providerId,
			scope.providerAccountId,
			scope.scopeId,
			config.productId,
			request.ref.logicalId,
		]);
		const bindingFingerprint = await config.bindingFingerprint?.(request);
		const requestDigest = `sha256:${await sha256Hex(JSON.stringify({ key, desired: request.desired, credentialRef: request.credentialRef, bindingFingerprint }))}`;
		const mutationId = `claimable:${await sha256Hex(key)}`;
		return { request, key, requestDigest, mutationId };
	}
	function outcome(
		input: ResolveOutcome,
		request: ResolveRequest,
		initial?: ResolveOutcome,
	) {
		const parsed = parseResolveOutcome(cloneAsJson(input));
		const pinned = request.ref.physicalId ?? initial?.physicalId;
		if (pinned && parsed.physicalId !== pinned)
			throw new Error("claimable observation changed physical identity");
		return parsed;
	}
	function retirementContext(
		request: ResolveRequest,
		mutationId: string,
		initial: ResolveOutcome,
	): ResourceLifecycleContext {
		return {
			...scope,
			providerId: config.providerId,
			productId: config.productId,
			resourceId: request.ref.logicalId,
			operationId: mutationId,
			physicalId: initial.physicalId,
			nowMs: config.clock(),
			maxAgeMs,
		};
	}
	function terminalRetirement(
		evidence: ResourceLifecycleObservation,
		context: ResourceLifecycleContext,
	) {
		const observed = parseResourceLifecycleObservation(evidence, context);
		if (
			observed.status !== "absent" ||
			!observed.operationTerminal ||
			!observed.usageFinal
		)
			throw new Error(
				"claimable retirement lacks terminal absence and final usage",
			);
		return observed;
	}

	return {
		providerId: config.providerId,
		productId: config.productId,
		async reconcile(input) {
			const { request, key, mutationId, requestDigest } = await identify(input);
			const claim = await config.journal.claim({ mutationId, requestDigest });
			const initial = await config.repository.read(key);
			if (initial) {
				if (await config.repository.readObservation(key))
					throw new Error(
						"claimable deployment incarnation is already retired; resurrection is forbidden",
					);
				return outcome(
					await config.observe(request, initial),
					request,
					initial,
				);
			}
			if (request.ref.physicalId)
				throw new Error(
					"claimable physical identity has no durable ownership record",
				);
			if (claim.status !== "claimed" && !config.providerIdempotentCreate)
				throw new Error(
					"claimable allocation is uncertain; re-creation is forbidden",
				);
			try {
				const created = outcome(await config.provision(request), request);
				await config.repository.write(key, created);
				await config.journal.acknowledge(mutationId, requestDigest);
				return created;
			} catch (error) {
				await config.journal.uncertain(mutationId, requestDigest);
				throw error;
			}
		},
		async read(input) {
			const { request, key, mutationId } = await identify(input);
			const initial = await config.repository.read(key);
			if (!initial) return undefined;
			const retired = await config.repository.readObservation(key);
			if (retired) {
				if (
					request.ref.physicalId &&
					request.ref.physicalId !== initial.physicalId
				)
					throw new Error("claimable observation changed physical identity");
				const observed = terminalRetirement(
					retired,
					retirementContext(request, mutationId, initial),
				);
				return outcome(
					{
						...initial,
						action: "delete",
						outputs: {
							...initial.outputs,
							ready: false,
							operationConfirmed: true,
							absenceConfirmed: true,
							operationTerminal: true,
							lifecycleStatus: "absent",
							observedAtMs: observed.observedAtMs,
							evidenceRef: observed.evidenceRef,
							usageFinal: true,
							settledMicros: observed.settledMicros,
							usageEvidenceRef: observed.usageEvidenceRef,
						},
					},
					request,
					initial,
				);
			}
			return outcome(await config.observe(request, initial), request, initial);
		},
		async delete(input) {
			const { request, key, mutationId, requestDigest } = await identify(input);
			const initial = await config.repository.read(key);
			if (!initial)
				throw new Error("claimable deletion has no durable ownership record");
			if (
				request.ref.physicalId &&
				request.ref.physicalId !== initial.physicalId
			)
				throw new Error("claimable deletion changed physical identity");
			if (!config.retire)
				throw new Error(
					"anonymous provider exposes no verified delete operation; expiry alone cannot prove retirement",
				);
			const creation = await config.journal.claim({
				mutationId,
				requestDigest,
			});
			if (creation.status === "claimed")
				throw new Error(
					"claimable retirement lacks its original immutable creation intent",
				);
			const context = retirementContext(request, mutationId, initial);
			const retireId = `${mutationId}:retire`;
			const retireDigest = `sha256:${await sha256Hex(JSON.stringify({ requestDigest, physicalId: initial.physicalId, action: "retire" }))}`;
			const prior = await config.repository.readObservation(key);
			if (prior) {
				terminalRetirement(prior, context);
				await config.journal.acknowledge(retireId, retireDigest);
				return;
			}
			const claim = await config.journal.claim({
				mutationId: retireId,
				requestDigest: retireDigest,
			});
			if (claim.status !== "claimed")
				throw new Error(
					"claimable retirement is uncertain; destructive replay is forbidden",
				);
			try {
				const evidence = await config.retire(request, initial, context);
				const observed = terminalRetirement(evidence, {
					...context,
					nowMs: config.clock(),
				});
				if (observed.observedAtMs < context.nowMs)
					throw new Error(
						"claimable retirement evidence predates its destructive attempt",
					);
				await config.repository.writeObservation(key, observed);
				await config.journal.acknowledge(retireId, retireDigest);
			} catch (error) {
				await config.journal.uncertain(retireId, retireDigest);
				throw error;
			}
		},
	};
}
