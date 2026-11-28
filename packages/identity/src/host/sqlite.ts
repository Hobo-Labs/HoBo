import { createHmac, timingSafeEqual } from "node:crypto";
import * as Domain from "@alchemy.run/domain";
import {
	createSqliteDomainPlatform,
	type SqliteDomainPlatformOptions,
	type SqliteDriver,
} from "@hobo/storage-sqlite";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
	AUTH_ONBOARDING_ACTOR_HEADER,
	AuthActor,
	AuthOnboarding,
	AuthOnboardingHandlers,
	AuthSessionMiddleware,
	type BetterAuthIssuerPort,
	CurrentAuthActor,
	type OwnerVaultPort,
	UnauthorizedAuthRequest,
} from "../domain/index.js";

export type OwnerVaultPortService = Layer.Success<
	ReturnType<typeof OwnerVaultPort.toLayer>
>;

export type BetterAuthIssuerPortService = Layer.Success<
	ReturnType<typeof BetterAuthIssuerPort.toLayer>
>;

const ACTOR_PROOF_DOMAIN = "hobo-auth-actor-proof:v1:";
const DEFAULT_ACTOR_PROOF_TTL_MS = 15 * 60 * 1000;
const MIN_SIGNING_KEY_LENGTH = 16;

const SignedAuthActorEnvelope = Schema.Struct({
	actor: AuthActor,
	exp: Schema.Int,
});
const SignedAuthActorEnvelopeJsonCodec = Schema.fromJsonString(
	SignedAuthActorEnvelope,
);
const encodeSignedAuthActorEnvelope = Schema.encodeUnknownSync(
	SignedAuthActorEnvelopeJsonCodec,
);
const decodeSignedAuthActorEnvelopeOption = Schema.decodeUnknownOption(
	SignedAuthActorEnvelopeJsonCodec,
);

function requireValidSigningKey(
	signingKey: Redacted.Redacted<string>,
): string | null {
	const raw = Redacted.value(signingKey);
	return raw.length >= MIN_SIGNING_KEY_LENGTH ? raw : null;
}

function computeProofMac(payloadB64: string, keyValue: string): string {
	return createHmac("sha256", keyValue)
		.update(ACTOR_PROOF_DOMAIN)
		.update(payloadB64)
		.digest("base64url");
}

export function signAuthActorProof(
	actorValue: AuthActor,
	signingKey: Redacted.Redacted<string>,
	options?: Readonly<{ nowMs?: number; ttlMs?: number }>,
): string {
	if (actorValue._tag === "System") {
		throw new Error("System actor cannot be signed as an HTTP proof");
	}
	const keyValue = requireValidSigningKey(signingKey);
	if (keyValue === null) {
		throw new Error(
			`signing key must be at least ${MIN_SIGNING_KEY_LENGTH} characters`,
		);
	}
	const nowMs = options?.nowMs ?? Date.now();
	const ttlMs = Math.max(1_000, options?.ttlMs ?? DEFAULT_ACTOR_PROOF_TTL_MS);
	const encoded = Buffer.from(
		encodeSignedAuthActorEnvelope({ actor: actorValue, exp: nowMs + ttlMs }),
		"utf8",
	).toString("base64url");
	const mac = computeProofMac(encoded, keyValue);
	return `${encoded}.${mac}`;
}

export function verifyAuthActorProof(
	rawHeader: string,
	signingKey: Redacted.Redacted<string>,
	options?: Readonly<{ nowMs?: number }>,
): Option.Option<AuthActor> {
	const keyValue = requireValidSigningKey(signingKey);
	if (keyValue === null) return Option.none();
	const parts = rawHeader.split(".");
	if (parts.length !== 2) return Option.none();
	const [payloadB64, providedMac] = parts;
	if (!payloadB64 || !providedMac) return Option.none();
	const expectedMac = computeProofMac(payloadB64, keyValue);
	const left = Buffer.from(providedMac, "utf8");
	const right = Buffer.from(expectedMac, "utf8");
	if (left.length !== right.length || !timingSafeEqual(left, right)) {
		return Option.none();
	}
	const decodedJson = Buffer.from(payloadB64, "base64url").toString("utf8");
	const envelope = decodeSignedAuthActorEnvelopeOption(decodedJson);
	if (Option.isNone(envelope)) return Option.none();
	const nowMs = options?.nowMs ?? Date.now();
	if (envelope.value.exp <= nowMs) return Option.none();
	if (envelope.value.actor._tag === "System") return Option.none();
	return Option.some(envelope.value.actor);
}

export function createSignedAuthSessionMiddlewareLayer(
	signingKey: Redacted.Redacted<string>,
): Layer.Layer<AuthSessionMiddleware> {
	return Layer.succeed(AuthSessionMiddleware, (effect, { headers }) => {
		const rawHeader = Headers.get(headers, AUTH_ONBOARDING_ACTOR_HEADER);
		if (Option.isNone(rawHeader)) {
			return Effect.fail(
				new UnauthorizedAuthRequest({
					reason: `missing ${AUTH_ONBOARDING_ACTOR_HEADER} header`,
				}),
			);
		}
		const verified = verifyAuthActorProof(rawHeader.value, signingKey);
		if (Option.isNone(verified)) {
			return Effect.fail(
				new UnauthorizedAuthRequest({
					reason: "invalid or tampered actor proof",
				}),
			);
		}
		return Effect.provideService(effect, CurrentAuthActor, verified.value);
	});
}

export function createAuthOnboardingInMemoryLayer<
	VaultErr,
	VaultReq,
	IssuerErr,
	IssuerReq,
	MiddlewareErr,
	MiddlewareReq,
>(
	vaultPort: Layer.Layer<OwnerVaultPortService, VaultErr, VaultReq>,
	issuerPort: Layer.Layer<BetterAuthIssuerPortService, IssuerErr, IssuerReq>,
	sessionMiddleware: Layer.Layer<
		AuthSessionMiddleware,
		MiddlewareErr,
		MiddlewareReq
	>,
) {
	const modelLayer = AuthOnboarding.layer(AuthOnboardingHandlers).pipe(
		Layer.provide(Layer.mergeAll(Domain.InMemory, vaultPort, issuerPort)),
	);
	return Layer.mergeAll(modelLayer, sessionMiddleware);
}

export function createAuthOnboardingSqliteLayer<
	VaultErr,
	VaultReq,
	IssuerErr,
	IssuerReq,
	MiddlewareErr,
	MiddlewareReq,
>(
	driver: SqliteDriver,
	vaultPort: Layer.Layer<OwnerVaultPortService, VaultErr, VaultReq>,
	issuerPort: Layer.Layer<BetterAuthIssuerPortService, IssuerErr, IssuerReq>,
	sessionMiddleware: Layer.Layer<
		AuthSessionMiddleware,
		MiddlewareErr,
		MiddlewareReq
	>,
	options?: SqliteDomainPlatformOptions,
) {
	const modelLayer = AuthOnboarding.layer(AuthOnboardingHandlers).pipe(
		Layer.provide(
			Layer.mergeAll(
				createSqliteDomainPlatform(driver, options),
				vaultPort,
				issuerPort,
			),
		),
	);
	return Layer.mergeAll(modelLayer, sessionMiddleware);
}
