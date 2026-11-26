import {
	createHash,
	type KeyObject,
	randomUUID,
	sign,
	verify,
} from "node:crypto";
import { create, fromJson, toJson } from "@bufbuild/protobuf";
import {
	canonicalJson,
	type DurableEventStore,
	type PrincipalRef,
} from "@hobo/core";
import {
	type HostingCredentialScopeAttestation,
	HostingCredentialScopeAttestationSchema,
	type HostingCredentialScopeBinding,
	HostingCredentialScopeBindingSchema,
	type HostingCredentialScopeChallenge,
	HostingCredentialScopeChallengeSchema,
	HostingCredentialScopeClaimsSchema,
	type HostingCredentialScopeRequest,
	HostingCredentialScopeRequestSchema,
	type HostingCredentialScopeUse,
	HostingCredentialScopeUseSchema,
} from "./_generated/hosting_credential_scope_pb.js";
import {
	cloneAsJson,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
} from "./json.js";

export type HostingCredentialScopeRequestInput = Omit<
	HostingCredentialScopeRequest,
	"$typeName"
>;
export type HostingCredentialScopeIdentity = Pick<
	HostingCredentialScopeBinding,
	"tenantId" | "providerId" | "providerAccountId" | "nativeAccountRef"
>;

/** The replay record contains metadata and hashes, never credential material. */
export interface HostingCredentialScopeReplayStore {
	readonly persistence: "durable-cas";
	readonly tenantId: string;
	pinBinding(binding: HostingCredentialScopeBinding): Promise<void>;
	consume(use: HostingCredentialScopeUse): Promise<void>;
}

function clock(value: number) {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new Error("invalid credential scope clock");
}

function nonempty(value: string) {
	if (!value || value.length > 2048 || /[\s\p{Cc}]/u.test(value))
		throw new Error("invalid credential scope identity");
}

function request(value: HostingCredentialScopeRequestInput) {
	for (const field of [
		value.tenantId,
		value.providerId,
		value.providerAccountId,
		value.credentialRef,
		value.operationId,
	])
		nonempty(field);
	if (!/^[a-z][a-z0-9+.-]*:\/\/[^ @#]+$/u.test(value.credentialRef))
		throw new Error("credential scope requires an opaque credential locator");
	clock(value.nowMs);
	return create(HostingCredentialScopeRequestSchema, value);
}

function finiteJson<T>(value: T): void {
	if (
		value === null ||
		value === undefined ||
		isJsonString(value) ||
		isJsonBoolean(value)
	)
		return;
	if (isJsonNumber(value)) {
		if (!Number.isFinite(value))
			throw new Error("credential material must be finite JSON");
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) finiteJson(item);
		return;
	}
	if (isJsonObject(value)) {
		for (const item of Object.values(value)) finiteJson(item);
		return;
	}
	throw new Error("credential material must be finite JSON");
}

function freeze<T>(value: T): T {
	if (Array.isArray(value) || isJsonObject(value)) {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

/** Hashes the actual JSON credential snapshot passed to provider IO. */
export function hashHostingCredentialMaterial<T>(material: T): string {
	const snapshot = structuredClone(material);
	finiteJson(snapshot);
	const normalized = cloneAsJson(snapshot);
	if (normalized === null) throw new Error("credential material is missing");
	return `sha256:${createHash("sha256")
		.update(canonicalJson(normalized))
		.digest("hex")}`;
}

function sameScope(
	left: HostingCredentialScopeRequestInput,
	right: Pick<
		HostingCredentialScopeBinding,
		"tenantId" | "providerId" | "providerAccountId" | "credentialRef"
	>,
) {
	return (
		left.tenantId === right.tenantId &&
		left.providerId === right.providerId &&
		left.providerAccountId === right.providerAccountId &&
		left.credentialRef === right.credentialRef
	);
}

function validBinding(binding: HostingCredentialScopeBinding, nowMs: number) {
	clock(binding.observedAtMs);
	clock(binding.validUntilMs);
	for (const field of [
		binding.credentialVersion,
		binding.nativeAccountRef,
		binding.evidenceRef,
	])
		nonempty(field);
	if (
		binding.observedAtMs > nowMs ||
		binding.validUntilMs <= nowMs ||
		!/^sha256:[a-f0-9]{64}$/u.test(binding.credentialDigest)
	)
		throw new Error("credential scope binding is stale or malformed");
}

/** A configured issuer enrolls account identities and material. It cannot sign
 * an arbitrary caller-supplied account binding or a public key from a proof. */
export function createHostingCredentialScopeIssuer<T>(options: {
	readonly issuerId: string;
	readonly keyId: string;
	readonly privateKey: KeyObject;
	readonly bindings: readonly {
		readonly identity: HostingCredentialScopeIdentity;
		readonly credentialRef: string;
		readonly credentialVersion: string;
		readonly credential: T;
		readonly evidenceRef: string;
		readonly observedAtMs: number;
		readonly validUntilMs: number;
	}[];
	readonly proofTtlMs?: number;
}) {
	nonempty(options.issuerId);
	nonempty(options.keyId);
	if (
		options.privateKey.type !== "private" ||
		options.privateKey.asymmetricKeyType !== "ed25519"
	)
		throw new Error("credential scope issuer requires an Ed25519 private key");
	const issuerId = options.issuerId;
	const keyId = options.keyId;
	const privateKey = options.privateKey;
	const proofTtlMs = options.proofTtlMs ?? 60_000;
	if (
		!Number.isSafeInteger(proofTtlMs) ||
		proofTtlMs < 1 ||
		proofTtlMs > 300_000
	)
		throw new Error("credential scope proof lifetime must be bounded");
	const bindings = options.bindings.map((entry) =>
		freeze(
			create(HostingCredentialScopeBindingSchema, {
				...entry.identity,
				credentialRef: entry.credentialRef,
				credentialVersion: entry.credentialVersion,
				credentialDigest: hashHostingCredentialMaterial(entry.credential),
				evidenceRef: entry.evidenceRef,
				observedAtMs: entry.observedAtMs,
				validUntilMs: entry.validUntilMs,
			}),
		),
	);
	return {
		async attest(challenge: HostingCredentialScopeChallenge) {
			if (!challenge.request)
				throw new Error("credential scope challenge missing");
			const asked = request(challenge.request);
			nonempty(challenge.challengeId);
			const matches = bindings.filter((entry) => sameScope(asked, entry));
			if (matches.length !== 1)
				throw new Error(
					"credential scope is not uniquely enrolled by the issuer",
				);
			const binding = matches[0];
			if (!binding) throw new Error("credential scope enrollment missing");
			validBinding(binding, asked.nowMs);
			const claims = create(HostingCredentialScopeClaimsSchema, {
				schemaVersion: "hobo.hosting-credential-scope/v1",
				attestationId: randomUUID(),
				issuerId,
				keyId,
				binding,
				operationId: asked.operationId,
				challengeId: challenge.challengeId,
				issuedAtMs: asked.nowMs,
				expiresAtMs: Math.min(asked.nowMs + proofTtlMs, binding.validUntilMs),
			});
			return create(HostingCredentialScopeAttestationSchema, {
				claims,
				signature: `ed25519:${sign(
					null,
					Buffer.from(
						canonicalJson(toJson(HostingCredentialScopeClaimsSchema, claims)),
					),
					privateKey,
				).toString("base64url")}`,
			});
		},
	};
}

export function createHostingCredentialScopeVerifier(options: {
	readonly trust: readonly {
		readonly issuerId: string;
		readonly keyId: string;
		readonly publicKey: KeyObject;
		readonly identities: readonly HostingCredentialScopeIdentity[];
	}[];
	readonly replayStore: HostingCredentialScopeReplayStore;
	readonly maximumAgeMs?: number;
	readonly nowMs: () => number;
}) {
	if (options.replayStore.persistence !== "durable-cas")
		throw new Error(
			"credential scope verifier requires durable replay protection",
		);
	const maximumAgeMs = options.maximumAgeMs ?? 60_000;
	if (
		!Number.isSafeInteger(maximumAgeMs) ||
		maximumAgeMs < 1 ||
		maximumAgeMs > 300_000
	)
		throw new Error("credential scope proof age must be bounded");
	const trust = options.trust.map((entry) => {
		if (
			entry.publicKey.type !== "public" ||
			entry.publicKey.asymmetricKeyType !== "ed25519"
		)
			throw new Error(
				"credential scope verifier requires a pinned Ed25519 public key",
			);
		return {
			...entry,
			identities: entry.identities.map((id) => freeze({ ...id })),
		};
	});
	return {
		async verify(input: {
			readonly challenge: HostingCredentialScopeChallenge;
			readonly attestation: HostingCredentialScopeAttestation;
			readonly credentialVersion: string;
			readonly credentialDigest: string;
		}) {
			const asked = input.challenge.request;
			if (!asked) throw new Error("credential scope challenge missing");
			request(asked);
			const currentTime = options.nowMs();
			clock(currentTime);
			if (options.replayStore.tenantId !== asked.tenantId)
				throw new Error("credential replay store tenant mismatch");
			if (input.attestation.claims?.binding)
				validBinding(input.attestation.claims.binding, currentTime);
			if (input.attestation.claims) {
				clock(input.attestation.claims.issuedAtMs);
				clock(input.attestation.claims.expiresAtMs);
			}
			const proof = fromJson(
				HostingCredentialScopeAttestationSchema,
				toJson(HostingCredentialScopeAttestationSchema, input.attestation),
			);
			const claims = proof.claims;
			const binding = claims?.binding;
			if (!claims || !binding)
				throw new Error("credential scope proof is incomplete");
			validBinding(binding, currentTime);
			clock(claims.issuedAtMs);
			clock(claims.expiresAtMs);
			if (
				claims.schemaVersion !== "hobo.hosting-credential-scope/v1" ||
				!sameScope(asked, binding) ||
				claims.operationId !== asked.operationId ||
				claims.challengeId !== input.challenge.challengeId ||
				binding.credentialVersion !== input.credentialVersion ||
				binding.credentialDigest !== input.credentialDigest ||
				claims.issuedAtMs > currentTime ||
				asked.nowMs > currentTime ||
				claims.issuedAtMs < binding.observedAtMs ||
				currentTime - claims.issuedAtMs > maximumAgeMs ||
				claims.expiresAtMs <= currentTime ||
				claims.expiresAtMs > binding.validUntilMs ||
				claims.expiresAtMs - claims.issuedAtMs > maximumAgeMs ||
				!/^ed25519:[A-Za-z0-9_-]{86}$/u.test(proof.signature)
			)
				throw new Error(
					"credential scope proof does not match this operation and material",
				);
			const pins = trust.filter(
				(entry) =>
					entry.issuerId === claims.issuerId && entry.keyId === claims.keyId,
			);
			if (pins.length !== 1)
				throw new Error("credential scope issuer key is not uniquely trusted");
			const pin = pins[0];
			if (
				!pin?.identities.some(
					(id) =>
						id.tenantId === binding.tenantId &&
						id.providerId === binding.providerId &&
						id.providerAccountId === binding.providerAccountId &&
						id.nativeAccountRef === binding.nativeAccountRef,
				)
			)
				throw new Error(
					"credential native account is outside the trusted issuer scope",
				);
			const payload = canonicalJson(
				toJson(HostingCredentialScopeClaimsSchema, claims),
			);
			if (
				!verify(
					null,
					Buffer.from(payload),
					pin.publicKey,
					Buffer.from(proof.signature.slice(8), "base64url"),
				)
			)
				throw new Error("credential scope proof signature is invalid");
			const proofDigest = `sha256:${createHash("sha256").update(payload).update(proof.signature).digest("hex")}`;
			await options.replayStore.pinBinding(binding);
			await options.replayStore.consume(
				create(HostingCredentialScopeUseSchema, {
					issuerId: claims.issuerId,
					keyId: claims.keyId,
					attestationId: claims.attestationId,
					operationId: claims.operationId,
					proofDigest,
					consumedAtMs: currentTime,
					expiresAtMs: claims.expiresAtMs,
				}),
			);
			return freeze(structuredClone(binding));
		},
	};
}

/** A replay claim is never forgotten at expiry. Expired proofs are rejected by
 * the verifier; deleting claims could make an old proof usable after clock drift. */
export function createDurableHostingCredentialScopeReplayStore(options: {
	readonly store: DurableEventStore;
	readonly tenantId: string;
	readonly actor: PrincipalRef;
	readonly fenceToken: bigint;
}): HostingCredentialScopeReplayStore {
	nonempty(options.tenantId);
	if (options.fenceToken < 1n)
		throw new Error("credential replay requires positive owner fence");
	return {
		persistence: "durable-cas",
		tenantId: options.tenantId,
		async pinBinding(binding) {
			if (binding.tenantId !== options.tenantId)
				throw new Error("credential binding pin belongs to another tenant");
			const key = createHash("sha256")
				.update(
					canonicalJson([
						binding.providerId,
						binding.providerAccountId,
						binding.credentialRef,
						binding.credentialVersion,
					]),
				)
				.digest("hex");
			const streamId = `hosting-credential-version:${encodeURIComponent(options.tenantId)}:${key}`;
			async function pinned() {
				let previous: HostingCredentialScopeBinding | undefined;
				for await (const event of options.store.read(streamId)) {
					if (
						previous ||
						event.tenant !== options.tenantId ||
						event.streamId !== streamId ||
						event.seq !== 1
					)
						throw new Error("credential version pin history is inconsistent");
					previous = fromJson(
						HostingCredentialScopeBindingSchema,
						cloneAsJson(event.data),
					);
					if (
						previous.tenantId !== binding.tenantId ||
						previous.providerId !== binding.providerId ||
						previous.providerAccountId !== binding.providerAccountId ||
						previous.credentialRef !== binding.credentialRef ||
						previous.credentialVersion !== binding.credentialVersion ||
						previous.credentialDigest !== binding.credentialDigest ||
						previous.nativeAccountRef !== binding.nativeAccountRef
					)
						throw new Error(
							"credential version was reused with different material or native account",
						);
				}
				return previous;
			}
			if (await pinned()) return;
			try {
				await options.store.commit({
					streamId,
					append: {
						expectedSeq: 0,
						tenant: options.tenantId,
						actor: options.actor,
						fenceToken: options.fenceToken,
					},
					events: [
						{
							type: "hosting.CredentialVersionPinned",
							data: toJson(HostingCredentialScopeBindingSchema, binding),
						},
					],
				});
			} catch (error) {
				if (!(await pinned())) throw error;
			}
		},
		async consume(use) {
			for (const id of [
				use.issuerId,
				use.keyId,
				use.attestationId,
				use.operationId,
			])
				nonempty(id);
			clock(use.consumedAtMs);
			clock(use.expiresAtMs);
			if (
				use.expiresAtMs <= use.consumedAtMs ||
				!/^sha256:[a-f0-9]{64}$/u.test(use.proofDigest)
			)
				throw new Error("invalid credential replay record");
			const digest = createHash("sha256")
				.update(canonicalJson([use.issuerId, use.keyId, use.attestationId]))
				.digest("hex");
			await options.store.commit({
				streamId: `hosting-credential-use:${encodeURIComponent(options.tenantId)}:${digest}`,
				append: {
					expectedSeq: 0,
					tenant: options.tenantId,
					actor: options.actor,
					fenceToken: options.fenceToken,
				},
				events: [
					{
						type: "hosting.CredentialScopeConsumed",
						data: toJson(HostingCredentialScopeUseSchema, use),
					},
				],
			});
		},
	};
}

/** Resolve once, attest the exact snapshot, and use only that captured material
 * across phase-scoped operations. Each operation gets its own challenged proof;
 * credential rotation cannot change IO after verification. */
export async function createVerifiedHostingCredentialLease<T>(options: {
	readonly request: HostingCredentialScopeRequestInput;
	readonly resolveCredential: () => Promise<{
		readonly version: string;
		readonly material: T;
	}>;
	readonly attest: (
		challenge: HostingCredentialScopeChallenge,
	) => Promise<HostingCredentialScopeAttestation>;
	readonly verifier: ReturnType<typeof createHostingCredentialScopeVerifier>;
}) {
	const asked = freeze(request(options.request));
	const resolved = await options.resolveCredential();
	nonempty(resolved.version);
	const credentialVersion = resolved.version;
	const material = freeze(structuredClone(resolved.material));
	const attest = options.attest;
	const verifier = options.verifier;
	const credentialDigest = hashHostingCredentialMaterial(material);
	async function authorize(scope: HostingCredentialScopeRequestInput) {
		const challenge = freeze(
			create(HostingCredentialScopeChallengeSchema, {
				request: request(scope),
				challengeId: randomUUID(),
			}),
		);
		return verifier.verify({
			challenge,
			attestation: await attest(challenge),
			credentialVersion,
			credentialDigest,
		});
	}
	const binding = await authorize(asked);
	const credentialRef = `${asked.credentialRef}#hobo-version=${encodeURIComponent(credentialVersion)}`;
	return Object.freeze({
		binding,
		credentialRef,
		async resolveCredential() {
			return material;
		},
		async verifyCredentialScope(input: HostingCredentialScopeRequestInput) {
			clock(input.nowMs);
			validBinding(binding, input.nowMs);
			if (
				!sameScope({ ...input, credentialRef: asked.credentialRef }, binding) ||
				input.credentialRef !== credentialRef ||
				input.nowMs < asked.nowMs
			)
				throw new Error(
					"credential lease does not authorize this operation scope",
				);
			const observed = await authorize({
				...input,
				credentialRef: asked.credentialRef,
			});
			if (observed.nativeAccountRef !== binding.nativeAccountRef)
				throw new Error("credential lease native account changed");
		},
	});
}
