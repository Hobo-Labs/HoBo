/**
 * Receipts and facts — the serialized outputs that leave this package.
 *
 * These are the artifacts that end up in a plan, an event log, and a support
 * bundle, so they are built by projection from the record rather than by
 * spreading it: a spread quietly republishes whatever a future field holds.
 * {@link assertNoCredentialMaterial} then re-checks the result, because the
 * cost of being wrong here is a bearer token in an append-only log.
 */

import { parseSecretRef } from "@hobo/bindings";
import {
	type ClaimableOperationKeyDeriver,
	type ClaimableResolverScope,
	claimableOperationKey,
	claimablePublicResourceId,
	claimableResourceRef,
	type ResolveRequest,
} from "@hobo/core";
import type {
	UpstashClaimSummary as UpstashClaimSummaryWire,
	UpstashNonSecretEndpoint as UpstashNonSecretEndpointWire,
	UpstashProviderFact as UpstashProviderFactWire,
	UpstashProvisionReceipt as UpstashProvisionReceiptWire,
} from "./_generated/temporary_redis_pb.js";
import { depositSecret, type SecretCustodyPort } from "./custody.js";
import { UPSTASH_BINDING_PROFILE_REFS } from "./definition.js";
import type { UpstashClaimState, UpstashTemporaryRedis } from "./driver.js";
import { UpstashProviderError } from "./errors.js";
import {
	isJsonObject,
	isJsonString,
	type JsonValue,
	parseJsonValue,
} from "./json.js";
import type { DomainView } from "./wire.js";

// domain-view: this surface has exactly one transport, so it is a literal here
// rather than the free string a proto3 scalar allows.
export type UpstashReceiptEndpoint = DomainView<
	UpstashNonSecretEndpointWire,
	{ transport: "https-rest" }
>;

// domain-view: `state` uses the CUE vocabulary rather than the numeric proto
// enum, and the outstanding-action ids are read-only because a receipt is a
// serialized output, not a working record.
export type UpstashReceiptClaimSummary = DomainView<
	UpstashClaimSummaryWire,
	{
		state: UpstashClaimState;
		boundary: "resource";
		atomicity: "single-resource";
		blockingActionIds: readonly string[];
	}
>;

// domain-view: the locators are optional under exactOptionalPropertyTypes, so
// an absent secret cannot be spelled as the empty string a proto3 scalar
// allows; the endpoint, claim summary, and limits are required here because a
// receipt without them is not a receipt.
export type UpstashProvisionReceipt = DomainView<
	UpstashProvisionReceiptWire,
	{
		schemaVersion: "hobo.provider-upstash.receipt/v2";
		endpoint: UpstashReceiptEndpoint;
		credentialRef?: string;
		restUrlRef?: string;
		expiresAtMs: number;
		expirySource: "provider-reported";
		observedAtMs: number;
		claim: UpstashReceiptClaimSummary;
		limits: UpstashTemporaryRedis["limits"];
		bindingProfiles: readonly string[];
		/** Empty by design; this surface publishes no export path. */
		migrationProfiles: readonly string[];
		teardown: "expiry-only";
	}
>;

// domain-view: `kind` is the exact five-member union of fact names, which the
// wire form can only approximate with an open enum, and `detail` keeps the
// scalar types a projection reads before the wire form flattens them all to
// strings.
export type UpstashProviderFact = DomainView<
	UpstashProviderFactWire,
	{
		kind:
			| "provider.upstash.database.provisioned"
			| "provider.upstash.database.adopted"
			| "provider.upstash.claim.pending-rotation"
			| "provider.upstash.claim.completed"
			| "provider.upstash.lease.expired";
		occurredAtMs: number;
		detail: Readonly<Record<string, string | number | boolean>>;
	}
>;

/**
 * Shapes that must never appear in a serialized output.
 *
 * The last rule is the one that matters for this provider: an Upstash REST
 * token has no prefix to match on, so it is caught structurally as a long
 * unbroken run of token characters. Known native capability values receive a
 * separate normalized check; typed custody locators and opaque public hashes
 * are safe handles rather than token strings.
 */
const FORBIDDEN: readonly {
	readonly name: string;
	readonly pattern: RegExp;
}[] = [
	{ name: "redis-uri", pattern: /rediss?:\/\//iu },
	{ name: "bearer-token", pattern: /Bearer\s+\S+/iu },
	{
		name: "token-assignment",
		pattern: /\b(?:token|password|pwd)\s*[=:]\s*"?[^\s"',}]{8,}/iu,
	},
	{
		name: "upstash-rest-token-env",
		pattern: /UPSTASH_REDIS_REST_TOKEN\s*[=:]/iu,
	},
	{ name: "userinfo-pair", pattern: /\/\/[^/\s:@]+:[^/\s:@]+@/u },
	{ name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
	{ name: "opaque-blob", pattern: /[A-Za-z0-9_-]{40,}/u },
];

export type CredentialScanHit = {
	readonly rule: string;
	readonly excerpt: string;
};

function jsonView(
	value: JsonValue | UpstashProvisionReceipt | readonly UpstashProviderFact[],
): JsonValue {
	return parseJsonValue(JSON.stringify(value));
}

/** Scan any JSON-serializable value for credential material. */
export function scanForCredentialMaterial(
	value: JsonValue,
): readonly CredentialScanHit[] {
	const serialized = JSON.stringify(scannable(value)) ?? "";
	const hits: CredentialScanHit[] = [];
	for (const rule of FORBIDDEN) {
		const match = rule.pattern.exec(serialized);
		if (match === null) continue;
		const start = Math.max(0, match.index - 12);
		hits.push({
			rule: rule.name,
			// Eight characters is enough to locate the field and not enough to
			// be a usable credential.
			excerpt: `…${serialized.slice(start, match.index + 8).replace(/[^\x20-\x7e]/gu, " ")}…`,
		});
	}
	return hits;
}

/** Valid typed handles may contain long content hashes. They are locators,
 * while known native capability values are separately checked at projection. */
function scannable(value: JsonValue): JsonValue {
	if (isJsonString(value)) {
		if (/^claimable:[0-9a-f]{64}$/u.test(value)) return "[opaque-resource]";
		try {
			parseSecretRef(value);
			return "[custody-reference]";
		} catch {
			return value;
		}
	}
	if (Array.isArray(value)) return value.map(scannable);
	if (isJsonObject(value)) {
		const mapped: { [key: string]: JsonValue } = {};
		for (const [key, entry] of Object.entries(value))
			mapped[key] = scannable(entry);
		return mapped;
	}
	return value;
}

export function assertNoCredentialMaterial(
	value: JsonValue,
	what: string,
): void {
	const hits = scanForCredentialMaterial(value);
	if (hits.length === 0) return;
	throw new UpstashProviderError(
		"SECRET_REFERENCE_INVALID",
		`${what} contains credential-shaped material (${hits.map((hit) => hit.rule).join(", ")}) and was not emitted`,
	);
}

// domain-view: behavioral custody and private key ports, not a wire record.
export type PublicSerializationOptions = {
	readonly custody: SecretCustodyPort;
	readonly deriveOperationKey: ClaimableOperationKeyDeriver;
	readonly scope: ClaimableResolverScope;
};

async function publicIdentity(
	record: UpstashTemporaryRedis,
	options: PublicSerializationOptions,
) {
	if (!options?.custody || !options.deriveOperationKey || !options.scope)
		throw new Error(
			"private custody and host-secret-backed key derivation are required",
		);
	const request: ResolveRequest = {
		ref: {
			slot: "kv",
			productId: record.definitionId,
			logicalId: record.resourceRef,
		},
		desired: { idempotencyKey: "public-receipt/v2" },
		credentialRef: "hobo-secret://public/serializer",
	};
	const resourceRef = await claimableResourceRef(options.scope, request);
	const key = await claimableOperationKey(
		options.scope,
		request,
		options.deriveOperationKey,
	);
	const nativeIdentity = await depositSecret(
		options.custody,
		record.databaseId,
		{ providerId: "upstash", resourceRef, purpose: "native-resource-id" },
	);
	const claim = await depositSecret(options.custody, record.claim.claimUrl, {
		providerId: "upstash",
		resourceRef,
		purpose: "claim-url",
	});
	return {
		resourceRef,
		opaquePhysicalId: await claimablePublicResourceId(record.databaseId, key),
		nativeIdentityRef: nativeIdentity.ref,
		claimRef: claim.ref,
	};
}

function normalizeCapabilityText(value: string): string {
	let decoded = value;
	for (;;) {
		const next = decoded.replace(/%[0-9a-f]{2}/giu, (byte) =>
			String.fromCharCode(Number.parseInt(byte.slice(1), 16)),
		);
		if (next === decoded) return decoded.toLowerCase().replaceAll("-", "");
		decoded = next;
	}
}

function assertNoNativeCapability(
	value: JsonValue,
	record: UpstashTemporaryRedis,
): void {
	const serialized = normalizeCapabilityText(JSON.stringify(value));
	for (const native of [record.databaseId, record.claim.claimUrl]) {
		const normalized = normalizeCapabilityText(native);
		if (normalized && serialized.includes(normalized))
			throw new Error("public output contains a native capability");
	}
	assertNoCredentialMaterial(value, "the Upstash public artifact");
}

/** Public output is async because native ids and claim URLs enter custody first. */
export async function toProvisionReceipt(
	record: UpstashTemporaryRedis,
	options: PublicSerializationOptions,
): Promise<UpstashProvisionReceipt> {
	try {
		const identity = await publicIdentity(record, options);
		const receipt: UpstashProvisionReceipt = {
			schemaVersion: "hobo.provider-upstash.receipt/v2",
			definitionId: record.definitionId,
			providerId: record.providerId,
			resourceRef: identity.resourceRef,
			opaquePhysicalId: identity.opaquePhysicalId,
			nativeIdentityRef: identity.nativeIdentityRef,
			endpoint: {
				host: record.restEndpointHost,
				port: 443,
				tls: true,
				transport: "https-rest",
			},
			...(record.credentialRef !== undefined
				? { credentialRef: record.credentialRef }
				: undefined),
			...(record.restUrlRef !== undefined
				? { restUrlRef: record.restUrlRef }
				: undefined),
			...(record.redisProtocolUrlRef !== undefined
				? { redisProtocolUrlRef: record.redisProtocolUrlRef }
				: undefined),
			expiresAtIso: record.expiresAtIso,
			expiresAtMs: record.expiresAtMs,
			statedTtlDays: record.statedTtlDays,
			expirySource: record.expirySource,
			observedAtMs: record.observedAtMs,
			adopted: record.adopted,
			claim: {
				state: record.claim.state,
				boundary: record.claim.boundary,
				atomicity: record.claim.atomicity,
				claimRef: identity.claimRef,
				blockingActionIds: record.claim.actions
					.filter((action) => action.blocking && !action.completed)
					.map((action) => action.id),
			},
			limits: record.limits,
			bindingProfiles: [...UPSTASH_BINDING_PROFILE_REFS],
			migrationProfiles: [],
			teardown: "expiry-only",
		};
		assertNoNativeCapability(jsonView(receipt), record);
		return receipt;
	} catch {
		throw new UpstashProviderError(
			"SECRET_REFERENCE_INVALID",
			"public Upstash serialization requires private custody and refuses credential-shaped or native capability material",
		);
	}
}

export async function toProviderFacts(
	record: UpstashTemporaryRedis,
	options: PublicSerializationOptions,
): Promise<readonly UpstashProviderFact[]> {
	try {
		const receipt = await toProvisionReceipt(record, options);
		const base = {
			schemaVersion: "hobo.provider-upstash.fact/v2",
			occurredAtMs: record.observedAtMs,
			resourceRef: receipt.resourceRef,
			opaquePhysicalId: receipt.opaquePhysicalId,
			nativeIdentityRef: receipt.nativeIdentityRef,
		};
		const facts: UpstashProviderFact[] = [
			{
				...base,
				kind: record.adopted
					? "provider.upstash.database.adopted"
					: "provider.upstash.database.provisioned",
				detail: {
					restEndpointHost: receipt.endpoint.host,
					expirySource: receipt.expirySource,
					expiresAtIso: receipt.expiresAtIso,
					credentialRef: receipt.credentialRef ?? "",
					claimRef: receipt.claim.claimRef,
				},
			},
		];
		if (record.claim.state === "claimed-pending-rotation")
			facts.push({
				...base,
				kind: "provider.upstash.claim.pending-rotation",
				detail: {
					reason:
						"the claim ceremony is attested, but the pre-claim REST token keeps working until an owner resets it in the console",
				},
			});
		if (record.claim.state === "complete")
			facts.push({
				...base,
				kind: "provider.upstash.claim.completed",
				detail: {},
			});
		if (record.claim.state === "expired")
			facts.push({
				...base,
				kind: "provider.upstash.lease.expired",
				detail: { expiresAtIso: receipt.expiresAtIso },
			});
		assertNoNativeCapability(jsonView(facts), record);
		return facts;
	} catch {
		throw new UpstashProviderError(
			"SECRET_REFERENCE_INVALID",
			"public Upstash serialization requires private custody and refuses credential-shaped or native capability material",
		);
	}
}
