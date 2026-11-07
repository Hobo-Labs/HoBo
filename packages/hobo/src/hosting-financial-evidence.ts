import { createHash, type KeyObject, verify } from "node:crypto";
import { create, fromJson, toJson } from "@bufbuild/protobuf";
import {
	HostingDestinationLiabilitySchema,
	type HostingOperationRequest,
} from "@hobo/cloud";
import {
	canonicalJson,
	type DurableEventStore,
	type HttpTransport,
	type PrincipalRef,
	parseResourceLifecycleObservation,
	type ResourceLifecycleContext,
	type ResourceLifecycleObservation,
} from "@hobo/core";
import {
	type HostingFinancialEvidenceAttestation,
	HostingFinancialEvidenceAttestationSchema,
	type HostingFinancialEvidenceClaims,
	HostingFinancialEvidenceClaimsSchema,
	HostingFinancialEvidenceUseSchema,
	type HostingFinancialResourceBinding,
} from "./_generated/hosting_financial_evidence_pb.js";
import { isJsonNumber, parseJsonObject } from "./json.js";
import type {
	HostingOperatingLiabilityReader,
	HostingResourceLifecycleReader,
} from "./resolver-hosting-provider.js";

export type HostingFinancialResourceScope = Omit<
	HostingFinancialResourceBinding,
	"$typeName"
>;

/** Install an independently operated billing/prepaid/expiry integration. The
 * issuer key and its exact account/resource scope are configuration, never data
 * accepted from an HTTP response. No provider acknowledgement implies finality. */
export interface HostingFinancialEvidenceSource {
	readonly issuerId: string;
	readonly keyId: string;
	readonly publicKey: KeyObject;
	readonly tenantId: string;
	readonly providerId: string;
	readonly providerAccountId: string;
	readonly currency: string;
	readonly endpoint: string;
	readonly resources: readonly HostingFinancialResourceScope[];
}

function safe(value: number, label: string) {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new Error(`${label} must be a safe nonnegative integer`);
}
function name(value: string) {
	if (!value || value.length > 2048 || /[\s\p{Cc}]/u.test(value))
		throw new Error("invalid financial evidence identity");
}
function digest(value: string) {
	if (!/^sha256:[a-f0-9]{64}$/u.test(value))
		throw new Error("financial evidence requires an exact sha256 digest");
}
function evidenceLocator(value: string) {
	name(value);
	const locator = new URL(value);
	if (
		!/^[a-z][a-z0-9+.-]*:/u.test(value) ||
		locator.username ||
		locator.password ||
		locator.search ||
		locator.hash ||
		["postgres:", "postgresql:", "redis:", "rediss:"].includes(locator.protocol)
	)
		throw new Error(
			"financial evidence references must be public metadata locators without credentials",
		);
}
function hash(value: string) {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function bindingKey(binding: HostingFinancialResourceScope) {
	return canonicalJson([
		binding.artifactId,
		binding.resourceName,
		binding.productId,
		binding.resourceId,
	]);
}
function canonicalBinding(binding: HostingFinancialResourceScope) {
	for (const field of [
		binding.resourceName,
		binding.productId,
		binding.resourceId,
	])
		name(field);
	digest(binding.artifactId);
	digest(binding.artifactDigest);
	if (binding.physicalId) {
		name(binding.physicalId);
		if (/^[a-z][a-z0-9+.-]*:\/\//u.test(binding.physicalId))
			evidenceLocator(binding.physicalId);
	}
	return Object.freeze({ ...binding });
}
export function hostingFinancialEvidenceSigningPayload(
	claims: HostingFinancialEvidenceClaims,
): string {
	return canonicalJson(toJson(HostingFinancialEvidenceClaimsSchema, claims));
}

/** Signed readbacks are kept in a durable, monotonic evidence journal. Reusing
 * exactly the same proof for the same operation is an idempotent read. A proof
 * ID cannot be reassigned, an old observation cannot replace a newer one, and
 * missing/expired/nonfinal evidence never releases financial exposure. */
export function createHostingFinancialEvidenceReader(options: {
	readonly store: DurableEventStore;
	readonly tenantId: string;
	readonly actor: PrincipalRef;
	readonly fenceToken: bigint;
	readonly transport: HttpTransport;
	readonly sources: readonly HostingFinancialEvidenceSource[];
	readonly nowMs: () => number;
	readonly maximumAgeMs?: number;
	readonly allowInsecureLoopback?: boolean;
}) {
	name(options.tenantId);
	if (options.fenceToken < 1n)
		throw new Error(
			"financial evidence requires a positive durable writer fence",
		);
	const maximumAgeMs = options.maximumAgeMs ?? 60_000;
	safe(maximumAgeMs, "financial evidence maximum age");
	if (maximumAgeMs < 1 || maximumAgeMs > 300_000)
		throw new Error("financial evidence maximum age must be bounded");
	const sources = options.sources.map((source) => {
		if (!/^[A-Z]{3}$/u.test(source.currency))
			throw new Error(
				"financial source requires an explicit commitment currency",
			);
		for (const id of [
			source.issuerId,
			source.keyId,
			source.tenantId,
			source.providerId,
			source.providerAccountId,
		])
			name(id);
		if (
			source.tenantId !== options.tenantId ||
			source.publicKey.type !== "public" ||
			source.publicKey.asymmetricKeyType !== "ed25519"
		)
			throw new Error(
				"financial evidence requires an account-scoped pinned Ed25519 public key",
			);
		const endpoint = new URL(source.endpoint);
		if (
			(endpoint.protocol !== "https:" &&
				!(
					options.allowInsecureLoopback &&
					endpoint.protocol === "http:" &&
					["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
				)) ||
			endpoint.username ||
			endpoint.password ||
			endpoint.search ||
			endpoint.hash
		)
			throw new Error(
				"financial evidence requires a fixed HTTPS endpoint without credentials",
			);
		const resources = source.resources.map(canonicalBinding);
		if (new Set(resources.map(bindingKey)).size !== resources.length)
			throw new Error("financial resource scope must be unique");
		return Object.freeze({ ...source, endpoint: endpoint.href, resources });
	});
	if (
		new Set(
			sources.map((row) =>
				canonicalJson([
					row.issuerId,
					row.keyId,
					row.providerId,
					row.providerAccountId,
				]),
			),
		).size !== sources.length
	)
		throw new Error("financial issuer/account scope must be unique");
	function scopedBinding(
		source: HostingFinancialEvidenceSource,
		binding: HostingFinancialResourceBinding | undefined,
	) {
		if (!binding)
			throw new Error("financial evidence resource binding is missing");
		canonicalBinding(binding);
		const expected = source.resources.find(
			(row) => bindingKey(row) === bindingKey(binding),
		);
		if (
			!expected ||
			expected.artifactDigest !== binding.artifactDigest ||
			(expected.physicalId && expected.physicalId !== binding.physicalId)
		)
			throw new Error(
				"financial evidence resource is outside the configured artifact and physical scope",
			);
		return binding;
	}
	function lifecycle(
		source: HostingFinancialEvidenceSource,
		claims: HostingFinancialEvidenceClaims,
		binding: HostingFinancialResourceBinding | undefined,
		text: string,
		nowMs: number,
	) {
		const scope = scopedBinding(source, binding);
		const raw = parseJsonObject(text);
		if (
			raw.physicalId !== scope.physicalId &&
			(raw.physicalId || scope.physicalId)
		)
			throw new Error(
				"financial lifecycle physical identity differs from its signed binding",
			);
		const absent = raw.status === "absent";
		const context: ResourceLifecycleContext = {
			tenantId: source.tenantId,
			providerId: source.providerId,
			providerAccountId: source.providerAccountId,
			productId: scope.productId,
			resourceId: scope.resourceId,
			operationId: claims.operationId,
			nowMs,
			maxAgeMs: maximumAgeMs,
		};
		if (scope.physicalId)
			Object.assign(context, { physicalId: scope.physicalId });
		if (!absent)
			Object.assign(context, { artifactDigest: scope.artifactDigest });
		const observation = parseResourceLifecycleObservation(raw, context);
		for (const ref of [
			observation.evidenceRef,
			observation.healthEvidenceRef,
			observation.usageEvidenceRef,
		])
			if (ref) evidenceLocator(ref);
		return observation;
	}
	function validate(
		source: HostingFinancialEvidenceSource,
		proof: HostingFinancialEvidenceAttestation,
		request: HostingOperationRequest,
		nowMs: number,
	) {
		const claims = proof.claims;
		if (!claims) throw new Error("financial evidence claims missing");
		for (const field of [
			claims.proofId,
			claims.issuerId,
			claims.keyId,
			claims.operationId,
		])
			name(field);
		safe(claims.issuedAtMs, "financial proof issue time");
		safe(claims.expiresAtMs, "financial proof expiry");
		digest(claims.operationDigest);
		digest(claims.planDigest);
		if (
			claims.schemaVersion !== "hobo.hosting-financial-evidence/v1" ||
			request.plan.tenantId !== source.tenantId ||
			claims.issuerId !== source.issuerId ||
			claims.keyId !== source.keyId ||
			claims.tenantId !== source.tenantId ||
			claims.providerId !== source.providerId ||
			claims.providerAccountId !== source.providerAccountId ||
			claims.currency !== source.currency ||
			claims.currency !== request.plan.commitment?.currency ||
			claims.operationId !== request.operation.operationId ||
			claims.operationDigest !== request.operation.operationDigest ||
			claims.planDigest !== request.plan.planDigest ||
			claims.issuedAtMs > nowMs ||
			nowMs - claims.issuedAtMs > maximumAgeMs ||
			claims.expiresAtMs <= nowMs ||
			claims.expiresAtMs - claims.issuedAtMs > maximumAgeMs
		)
			throw new Error(
				"financial evidence is stale or has foreign operation/account scope",
			);
		const payload = hostingFinancialEvidenceSigningPayload(claims);
		if (
			!/^ed25519:[A-Za-z0-9_-]{86}$/u.test(proof.signature) ||
			!verify(
				null,
				Buffer.from(payload),
				source.publicKey,
				Buffer.from(proof.signature.slice(8), "base64url"),
			)
		)
			throw new Error("financial evidence signature is invalid");
		const keys = new Set<string>();
		const observations = claims.lifecycles.map((entry) => {
			const binding = scopedBinding(source, entry.binding);
			const key = `lifecycle:${bindingKey(binding)}`;
			if (keys.has(key))
				throw new Error("duplicate financial evidence resource");
			keys.add(key);
			return {
				binding,
				observation: lifecycle(
					source,
					claims,
					binding,
					entry.observationJson,
					nowMs,
				),
			};
		});
		const liabilities = claims.liabilities.map((entry) => {
			const binding = scopedBinding(source, entry.binding);
			const key = `liability:${bindingKey(binding)}`;
			if (keys.has(key))
				throw new Error("duplicate financial evidence resource");
			keys.add(key);
			const raw = parseJsonObject(entry.liabilityJson);
			if (!isJsonNumber(raw.maximumMicros) || !isJsonNumber(raw.expiresAtMs))
				throw new Error(
					"financial liability requires explicit integer money and expiry",
				);
			safe(raw.maximumMicros, "native liability money");
			safe(raw.expiresAtMs, "native liability expiry");
			const liability = fromJson(HostingDestinationLiabilitySchema, raw);
			evidenceLocator(liability.evidenceRef);
			if (
				liability.resourceName !== binding.resourceName ||
				liability.providerId !== source.providerId ||
				liability.providerAccountId !== source.providerAccountId ||
				liability.artifactDigest !== binding.artifactDigest ||
				!/^[a-z][a-z0-9+.-]*:[^\s]+$/u.test(liability.evidenceRef) ||
				(liability.mode !== "provider-funded-zero" &&
					liability.mode !== "native-finite-term") ||
				(liability.mode === "provider-funded-zero" &&
					liability.maximumMicros !== 0) ||
				(liability.mode === "native-finite-term" && liability.expiresAtMs === 0)
			)
				throw new Error(
					"financial liability is not an independently scoped enforceable bound",
				);
			return { binding, liability, finalized: entry.finalized };
		});
		return {
			claims,
			observations,
			liabilities,
			proofDigest: hash(payload + proof.signature),
		};
	}
	async function append(
		streamId: string,
		proof: HostingFinancialEvidenceAttestation,
		proofDigest: string,
		nowMs: number,
		expectedSeq: number,
	) {
		const entry = create(HostingFinancialEvidenceUseSchema, {
			proofDigest,
			attestation: proof,
			acceptedAtMs: nowMs,
		});
		await options.store.commit({
			streamId,
			append: {
				expectedSeq,
				tenant: options.tenantId,
				actor: options.actor,
				fenceToken: options.fenceToken,
			},
			events: [
				{
					type: "hosting.FinancialEvidenceAccepted",
					data: toJson(HostingFinancialEvidenceUseSchema, entry),
				},
			],
		});
	}
	async function accept(
		source: HostingFinancialEvidenceSource,
		proof: HostingFinancialEvidenceAttestation,
		request: HostingOperationRequest,
		nowMs: number,
	) {
		const current = validate(source, proof, request, nowMs);
		const claimStream = `hosting-financial-proof:${encodeURIComponent(options.tenantId)}:${hash(canonicalJson([source.issuerId, source.keyId, current.claims.proofId])).slice(7)}`;
		let previousDigest: string | undefined;
		for await (const event of options.store.read(claimStream)) {
			if (
				event.tenant !== options.tenantId ||
				event.streamId !== claimStream ||
				event.seq !== 1
			)
				throw new Error("foreign financial replay journal");
			previousDigest = fromJson(
				HostingFinancialEvidenceUseSchema,
				JSON.parse(JSON.stringify(event.data)),
			).proofDigest;
		}
		if (previousDigest && previousDigest !== current.proofDigest)
			throw new Error("financial proof ID was reused with different evidence");
		if (!previousDigest) {
			try {
				await append(claimStream, proof, current.proofDigest, nowMs, 0);
			} catch (error) {
				let recovered: string | undefined;
				for await (const event of options.store.read(claimStream))
					recovered = fromJson(
						HostingFinancialEvidenceUseSchema,
						JSON.parse(JSON.stringify(event.data)),
					).proofDigest;
				if (recovered !== current.proofDigest) throw error;
			}
		}
		const streamId = `hosting-financial-operation:${encodeURIComponent(options.tenantId)}:${hash(canonicalJson([source.issuerId, source.keyId, source.providerId, source.providerAccountId, current.claims.operationId])).slice(7)}`;
		for (let attempt = 0; attempt < 3; attempt++) {
			let seq = 0;
			let duplicate = false;
			let newestIssue = 0;
			const priorLiabilities = new Map<
				string,
				{ text: string; finalized: boolean }
			>();
			const latest = new Map<string, { observedAtMs: number; text: string }>();
			for await (const event of options.store.read(streamId)) {
				if (
					event.tenant !== options.tenantId ||
					event.streamId !== streamId ||
					event.seq !== seq + 1
				)
					throw new Error("foreign financial evidence history");
				const entry = fromJson(
					HostingFinancialEvidenceUseSchema,
					JSON.parse(JSON.stringify(event.data)),
				);
				if (!entry.attestation?.claims)
					throw new Error("incomplete financial evidence history");
				if (entry.attestation.claims.issuedAtMs > newestIssue)
					newestIssue = entry.attestation.claims.issuedAtMs;
				for (const row of entry.attestation.claims.liabilities) {
					priorLiabilities.set(bindingKey(scopedBinding(source, row.binding)), {
						text: canonicalJson(parseJsonObject(row.liabilityJson)),
						finalized: row.finalized,
					});
				}
				if (entry.proofDigest === current.proofDigest) duplicate = true;
				for (const row of entry.attestation.claims.lifecycles) {
					const binding = scopedBinding(source, row.binding),
						raw = parseJsonObject(row.observationJson);
					if (!isJsonNumber(raw.observedAtMs))
						throw new Error("invalid financial evidence history time");
					latest.set(bindingKey(binding), {
						observedAtMs: raw.observedAtMs,
						text: row.observationJson,
					});
				}
				seq = event.seq;
			}
			if (current.claims.issuedAtMs < newestIssue)
				throw new Error("financial proof regresses the accepted issue time");
			for (const row of current.claims.liabilities) {
				const prior = priorLiabilities.get(
					bindingKey(scopedBinding(source, row.binding)),
				);
				if (
					prior &&
					(prior.text !== canonicalJson(parseJsonObject(row.liabilityJson)) ||
						(prior.finalized && !row.finalized))
				)
					throw new Error(
						"financial entitlement changes or finality regresses",
					);
			}
			for (const row of current.claims.lifecycles) {
				const previous = latest.get(
						bindingKey(scopedBinding(source, row.binding)),
					),
					raw = parseJsonObject(row.observationJson);
				if (
					previous &&
					(!isJsonNumber(raw.observedAtMs) ||
						raw.observedAtMs < previous.observedAtMs ||
						(raw.observedAtMs === previous.observedAtMs &&
							row.observationJson !== previous.text))
				)
					throw new Error(
						"financial observation regresses or changes at the same timestamp",
					);
				if (previous) {
					const prior = parseJsonObject(previous.text);
					if (prior.physicalId && raw.physicalId !== prior.physicalId)
						throw new Error("financial resource physical identity changed");
					if (
						prior.usageFinal === true &&
						(raw.usageFinal !== true ||
							raw.settledMicros !== prior.settledMicros ||
							raw.status !== prior.status)
					)
						throw new Error(
							"financial final usage cannot be revoked or changed",
						);
				}
			}
			if (duplicate) return current;
			try {
				await append(streamId, proof, current.proofDigest, nowMs, seq);
				return current;
			} catch (error) {
				if (attempt === 2) throw error;
			}
		}
		throw new Error("financial evidence journal contention");
	}
	async function read(
		source: HostingFinancialEvidenceSource,
		request: HostingOperationRequest,
	) {
		const nowMs = options.nowMs();
		safe(nowMs, "financial evidence clock");
		const response = await options.transport({
			method: "POST",
			url: source.endpoint,
			headers: {
				"content-type": "application/json",
				accept: "application/json",
			},
			body: canonicalJson({
				schemaVersion: "hobo.hosting-financial-query/v1",
				tenantId: source.tenantId,
				providerId: source.providerId,
				providerAccountId: source.providerAccountId,
				operationId: request.operation.operationId,
				operationDigest: request.operation.operationDigest,
				planDigest: request.plan.planDigest,
			}),
			timeoutMs: 15000,
			maxResponseBytes: 512 * 1024,
		});
		if (response.status === 404) return undefined;
		if (
			response.status !== 200 ||
			Buffer.byteLength(response.body) > 512 * 1024
		)
			throw new Error(
				"financial evidence integration did not return a bounded authoritative proof",
			);
		const proof = fromJson(
			HostingFinancialEvidenceAttestationSchema,
			parseJsonObject(response.body),
		);
		const observedAt = options.nowMs();
		safe(observedAt, "financial response clock");
		return accept(source, proof, request, observedAt);
	}
	const observeOperatingLiability: HostingOperatingLiabilityReader = async (
		input,
	) => {
		const matching = sources.filter(
			(source) =>
				source.tenantId === input.request.plan.tenantId &&
				source.providerId === input.node.provider &&
				source.resources.some(
					(binding) =>
						binding.artifactId === input.artifactId &&
						binding.resourceName === input.node.name &&
						binding.resourceId === input.resourceId,
				),
		);
		if (matching.length !== 1 || !matching[0])
			throw new Error(
				"financial liability integration is not uniquely configured",
			);
		const evidence = await read(matching[0], input.request);
		const rows = evidence?.liabilities.filter(
			(row) =>
				row.binding.artifactId === input.artifactId &&
				row.binding.resourceName === input.node.name &&
				row.binding.resourceId === input.resourceId &&
				(!input.physicalId || row.binding.physicalId === input.physicalId),
		);
		if (rows?.length !== 1 || !rows[0])
			throw new Error(
				"native liability evidence is missing for the exact destination",
			);
		return { liability: rows[0].liability, finalized: rows[0].finalized };
	};
	const observeLifecycle: HostingResourceLifecycleReader = async (input) => {
		const matching = sources.filter(
			(source) =>
				source.tenantId === input.context.tenantId &&
				source.providerId === input.context.providerId &&
				source.providerAccountId === input.context.providerAccountId &&
				source.resources.some(
					(binding) =>
						binding.artifactId === input.artifactId &&
						binding.productId === input.context.productId &&
						binding.resourceId === input.context.resourceId,
				),
		);
		if (matching.length !== 1 || !matching[0])
			throw new Error(
				"financial lifecycle integration is not uniquely configured",
			);
		const evidence = await read(matching[0], input.request);
		const rows = evidence?.observations.filter(
			(row) =>
				row.binding.artifactId === input.artifactId &&
				row.binding.productId === input.context.productId &&
				row.binding.resourceId === input.context.resourceId,
		);
		if (rows?.length !== 1 || !rows[0])
			throw new Error(
				"native lifecycle evidence is missing for the exact resource",
			);
		const observed = rows[0].observation;
		const { artifactDigest: expectedArtifact, ...scope } = input.context;
		const currentScope = { ...scope, nowMs: options.nowMs() };
		return parseResourceLifecycleObservation(
			observed,
			observed.status === "absent" || !expectedArtifact
				? currentScope
				: { ...currentScope, artifactDigest: expectedArtifact },
		);
	};
	return {
		billing: {
			async observe(
				request: HostingOperationRequest,
			): Promise<readonly ResourceLifecycleObservation[]> {
				if (request.plan.tenantId !== options.tenantId)
					throw new Error("financial reader tenant mismatch");
				const all: ResourceLifecycleObservation[] = [];
				for (const source of sources) {
					const selected = source.resources.filter((row) =>
						[request.plan.sourcePlanId, request.plan.targetPlanId].includes(
							row.artifactId,
						),
					);
					if (!selected.length) continue;
					const evidence = await read(source, request);
					if (!evidence) return [];
					for (const binding of selected) {
						const observed = evidence.observations.find(
							(row) => bindingKey(row.binding) === bindingKey(binding),
						);
						if (!observed)
							throw new Error(
								"financial billing proof does not cover every configured source and destination resource",
							);
						all.push(observed.observation);
					}
				}
				const native = new Map<string, ResourceLifecycleObservation>();
				for (const observation of all) {
					const key = canonicalJson([
						observation.tenantId,
						observation.providerId,
						observation.providerAccountId,
						observation.productId,
						observation.resourceId,
						observation.physicalId,
					]);
					const previous = native.get(key);
					if (previous) {
						if (
							previous.settledMicros !== observation.settledMicros ||
							previous.usageFinal !== observation.usageFinal ||
							previous.billable !== observation.billable ||
							previous.status !== observation.status ||
							previous.operationTerminal !== observation.operationTerminal ||
							previous.artifactDigest !== observation.artifactDigest ||
							previous.usageEvidenceRef !== observation.usageEvidenceRef
						)
							throw new Error(
								"shared native resource has conflicting financial amount or finality",
							);
						if (observation.observedAtMs > previous.observedAtMs)
							native.set(key, observation);
					} else native.set(key, observation);
				}
				return [...native.values()];
			},
		},
		observeOperatingLiability,
		observeLifecycle,
	};
}
