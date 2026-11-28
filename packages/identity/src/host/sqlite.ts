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

const AuthActorJsonCodec = Schema.fromJsonString(AuthActor);
const encodeAuthActorJson = Schema.encodeUnknownSync(AuthActorJsonCodec);
const decodeAuthActorJsonOption =
	Schema.decodeUnknownOption(AuthActorJsonCodec);

function computeProofMac(
	payloadB64: string,
	signingKey: Redacted.Redacted<string>,
): string {
	return createHmac("sha256", Redacted.value(signingKey))
		.update(payloadB64)
		.digest("base64url");
}

export function signAuthActorProof(
	actorValue: AuthActor,
	signingKey: Redacted.Redacted<string>,
): string {
	const encoded = Buffer.from(encodeAuthActorJson(actorValue), "utf8").toString(
		"base64url",
	);
	const mac = computeProofMac(encoded, signingKey);
	return `${encoded}.${mac}`;
}

export function verifyAuthActorProof(
	rawHeader: string,
	signingKey: Redacted.Redacted<string>,
): Option.Option<AuthActor> {
	const parts = rawHeader.split(".");
	if (parts.length !== 2) return Option.none();
	const [payloadB64, providedMac] = parts;
	if (!payloadB64 || !providedMac) return Option.none();
	const expectedMac = computeProofMac(payloadB64, signingKey);
	const left = Buffer.from(providedMac, "utf8");
	const right = Buffer.from(expectedMac, "utf8");
	if (left.length !== right.length || !timingSafeEqual(left, right)) {
		return Option.none();
	}
	const decodedJson = Buffer.from(payloadB64, "base64url").toString("utf8");
	return decodeAuthActorJsonOption(decodedJson);
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
