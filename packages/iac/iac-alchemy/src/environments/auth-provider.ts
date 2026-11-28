import {
	AuthError,
	AuthProviderLayer,
	type ConfigureField,
	type ConfigureMethod,
	type CredentialsUnavailable,
	lazyCredentials,
	NeedsReauth,
	type ProviderDetails,
} from "alchemy/Auth";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { parseOwnerCredentialLocator } from "../runners/owner-credentials.js";

// public-contract: Alchemy AuthProvider registry identifier for HoBo auth.
export const HOBO_AUTH_PROVIDER_NAME = "HoboAuth";

const SECRET_STORE_LITERALS = Schema.Literals([
	"owner-store",
	"infisical",
	"doppler",
	"1password",
	"bitwarden",
]);
export type HoboSecretStoreKind = typeof SECRET_STORE_LITERALS.Type;

const DATABASE_TARGET_LITERALS = Schema.Literals([
	"sqlite",
	"postgres",
	"d1",
	"neon",
	"memory",
]);
export type HoboBetterAuthDatabaseTarget = typeof DATABASE_TARGET_LITERALS.Type;

const NonEmptyText = Schema.NonEmptyString;
const OwnerLocatorSchema = Schema.NonEmptyString.check(
	Schema.isPattern(/^owner:\/\/[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u),
);
const IssuerOriginSchema = Schema.NonEmptyString.check(
	Schema.isPattern(/^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/u),
);
const BasePathSchema = Schema.NonEmptyString.check(
	Schema.isPattern(/^(?:\/[a-z0-9][a-z0-9._~-]*)+$/u),
);
const StageSchema = Schema.NonEmptyString.check(
	Schema.isPattern(/^[a-z0-9][-_a-z0-9]{0,63}$/u),
);
const BoxIdSchema = Schema.NonEmptyString.check(
	Schema.isPattern(/^[a-z0-9][a-z0-9._-]{1,63}$/u),
);
const DigestSchema = Schema.NonEmptyString.check(
	Schema.isPattern(/^sha256:[0-9a-f]{16,64}$/u),
);

export const BetterAuthSessionProfileConfig = Schema.Struct({
	method: Schema.Literal("better-auth-session"),
	issuerOrigin: IssuerOriginSchema,
	basePath: BasePathSchema,
	stage: StageSchema,
	boxId: BoxIdSchema,
	secretStore: SECRET_STORE_LITERALS,
	project: NonEmptyText,
	path: NonEmptyText,
	signingSecretLocator: OwnerLocatorSchema,
	databaseTarget: DATABASE_TARGET_LITERALS,
	sessionHandleDigest: Schema.optional(DigestSchema),
	expiresAtMs: Schema.optional(
		Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	),
});

export const OwnerStoreProfileConfig = Schema.Struct({
	method: Schema.Literal("owner-store"),
	stage: StageSchema,
	boxId: BoxIdSchema,
	secretStore: SECRET_STORE_LITERALS,
	project: NonEmptyText,
	path: NonEmptyText,
	signingSecretLocator: OwnerLocatorSchema,
});

export const InfisicalUniversalAuthProfileConfig = Schema.Struct({
	method: Schema.Literal("infisical-universal-auth"),
	stage: StageSchema,
	boxId: BoxIdSchema,
	project: NonEmptyText,
	path: NonEmptyText,
	signingSecretLocator: OwnerLocatorSchema,
	apiBaseUrl: Schema.optional(IssuerOriginSchema),
});

export const DopplerProjectProfileConfig = Schema.Struct({
	method: Schema.Literal("doppler-project"),
	stage: StageSchema,
	boxId: BoxIdSchema,
	project: NonEmptyText,
	configName: NonEmptyText,
	signingSecretLocator: OwnerLocatorSchema,
});

export const HoboAuthProfileConfigSchema = Schema.Union([
	BetterAuthSessionProfileConfig,
	OwnerStoreProfileConfig,
	InfisicalUniversalAuthProfileConfig,
	DopplerProjectProfileConfig,
]);

export type HoboAuthProfileConfig = typeof HoboAuthProfileConfigSchema.Type;

export interface HoboAuthResolvedCredentials {
	readonly profileName: string;
	readonly method: HoboAuthProfileConfig["method"];
	readonly stage: string;
	readonly boxId: string;
	readonly signingSecret: Redacted.Redacted<string>;
	readonly sessionToken?: Redacted.Redacted<string>;
	readonly issuerOrigin?: string;
	readonly basePath?: string;
	readonly expiresAtMs?: number;
}

export interface HoboAuthCredentialBrokerService {
	readonly resolveForProfile: (input: {
		readonly profileName: string;
		readonly config: HoboAuthProfileConfig;
	}) => Effect.Effect<
		{
			readonly credentials: HoboAuthResolvedCredentials;
			readonly updatedConfig?: HoboAuthProfileConfig;
		},
		AuthError | NeedsReauth
	>;
	readonly refreshForProfile: (input: {
		readonly profileName: string;
		readonly config: HoboAuthProfileConfig;
	}) => Effect.Effect<HoboAuthProfileConfig, AuthError>;
	readonly logoutForProfile: (input: {
		readonly profileName: string;
		readonly config: HoboAuthProfileConfig;
	}) => Effect.Effect<void, AuthError>;
}

export class HoboAuthCredentialBroker extends Context.Service<
	HoboAuthCredentialBroker,
	HoboAuthCredentialBrokerService
>()("Hobo/AlchemyAuthCredentialBroker") {}

export class HoboAuthCredentials extends Context.Service<
	HoboAuthCredentials,
	Effect.Effect<HoboAuthResolvedCredentials, CredentialsUnavailable>
>()("Hobo/AlchemyAuthCredentials") {}

const validateLocatorField = (value: string): string | undefined => {
	try {
		parseOwnerCredentialLocator(value);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : "invalid owner:// locator";
	}
};

const commonFields: ReadonlyArray<ConfigureField> = [
	{
		name: "stage",
		label: "Alchemy stage",
		defaultValue: "dev",
	},
	{
		name: "boxId",
		label: "Box identifier",
		placeholder: "devbox-local-1",
	},
	{
		name: "project",
		label: "Secret store project",
		defaultValue: "hobo",
	},
	{
		name: "signingSecretLocator",
		label: "Brokered signing secret locator",
		defaultValue: "owner://HOBO_AUTH_SECRET",
		validate: validateLocatorField,
	},
];

const betterAuthSessionFields: ReadonlyArray<ConfigureField> = [
	{
		name: "issuerOrigin",
		label: "Better Auth issuer origin",
		placeholder: "https://auth.hobo.example",
	},
	{
		name: "basePath",
		label: "Better Auth base path",
		defaultValue: "/api/auth",
	},
	{
		name: "secretStore",
		label: "Secret store provider",
		defaultValue: "infisical",
	},
	{
		name: "path",
		label: "Secret store path",
		defaultValue: "/hobo-auth",
	},
	{
		name: "databaseTarget",
		label: "Better Auth database target",
		defaultValue: "sqlite",
	},
	{
		name: "sessionHandleDigest",
		label: "Session handle sha256 digest",
		optional: true,
	},
	...commonFields,
];

const ownerStoreFields: ReadonlyArray<ConfigureField> = [
	{
		name: "secretStore",
		label: "Secret store provider",
		defaultValue: "owner-store",
	},
	{
		name: "path",
		label: "Secret store path",
		defaultValue: "/hobo-auth",
	},
	...commonFields,
];

const infisicalFields: ReadonlyArray<ConfigureField> = [
	{
		name: "path",
		label: "Infisical secret path",
		defaultValue: "/hobo-auth",
	},
	{
		name: "apiBaseUrl",
		label: "Infisical API URL",
		optional: true,
	},
	...commonFields,
];

const dopplerFields: ReadonlyArray<ConfigureField> = [
	{
		name: "configName",
		label: "Doppler config name",
		defaultValue: "dev",
	},
	...commonFields,
];

export const HOBO_AUTH_CONFIGURE_METHODS: ReadonlyArray<ConfigureMethod> = [
	{ method: "better-auth-session", fields: betterAuthSessionFields },
	{ method: "owner-store", fields: ownerStoreFields },
	{ method: "infisical-universal-auth", fields: infisicalFields },
	{ method: "doppler-project", fields: dopplerFields },
];

function redactDigest(value: string): string {
	if (value.length <= 15) return "****";
	return `${value.slice(0, 15)}****`;
}

function decodeConfiguredProfile(
	method: string,
	values: Readonly<Record<string, string>>,
) {
	const stage = values.stage ?? "dev";
	const boxId = values.boxId ?? "local-box";
	const project = values.project ?? "hobo";
	const signingSecretLocator =
		values.signingSecretLocator ?? "owner://HOBO_AUTH_SECRET";

	switch (method) {
		case "better-auth-session":
			return Schema.decodeUnknownEffect(BetterAuthSessionProfileConfig)({
				method,
				issuerOrigin: values.issuerOrigin ?? "",
				basePath: values.basePath ?? "/api/auth",
				stage,
				boxId,
				secretStore: values.secretStore ?? "infisical",
				project,
				path: values.path ?? "/hobo-auth",
				signingSecretLocator,
				databaseTarget: values.databaseTarget ?? "sqlite",
				...(values.sessionHandleDigest !== undefined &&
				values.sessionHandleDigest.length > 0
					? { sessionHandleDigest: values.sessionHandleDigest }
					: undefined),
			});
		case "owner-store":
			return Schema.decodeUnknownEffect(OwnerStoreProfileConfig)({
				method,
				stage,
				boxId,
				secretStore: values.secretStore ?? "owner-store",
				project,
				path: values.path ?? "/hobo-auth",
				signingSecretLocator,
			});
		case "infisical-universal-auth":
			return Schema.decodeEffect(InfisicalUniversalAuthProfileConfig)({
				method,
				stage,
				boxId,
				project,
				path: values.path ?? "/hobo-auth",
				signingSecretLocator,
				...(values.apiBaseUrl !== undefined && values.apiBaseUrl.length > 0
					? { apiBaseUrl: values.apiBaseUrl }
					: undefined),
			});
		case "doppler-project":
			return Schema.decodeEffect(DopplerProjectProfileConfig)({
				method,
				stage,
				boxId,
				project,
				configName: values.configName ?? stage,
				signingSecretLocator,
			});
		default:
			return Schema.decodeUnknownEffect(HoboAuthProfileConfigSchema)({
				method,
			});
	}
}

export function renderHoboAuthProfileDetails(
	profileName: string,
	config: HoboAuthProfileConfig,
): ProviderDetails {
	const lines: Array<{ readonly key: string; readonly value: string }> = [
		{ key: "profile", value: profileName },
		{ key: "method", value: config.method },
		{ key: "stage", value: config.stage },
		{ key: "boxId", value: config.boxId },
		{ key: "project", value: config.project },
		{ key: "signingSecretLocator", value: config.signingSecretLocator },
	];
	switch (config.method) {
		case "better-auth-session":
			lines.push(
				{ key: "issuerOrigin", value: config.issuerOrigin },
				{ key: "basePath", value: config.basePath },
				{ key: "secretStore", value: config.secretStore },
				{ key: "path", value: config.path },
				{ key: "databaseTarget", value: config.databaseTarget },
			);
			if (config.sessionHandleDigest !== undefined) {
				lines.push({
					key: "sessionHandle",
					value: redactDigest(config.sessionHandleDigest),
				});
			}
			if (config.expiresAtMs !== undefined) {
				lines.push({
					key: "expiresAt",
					value: new Date(config.expiresAtMs).toISOString(),
				});
			}
			break;
		case "owner-store":
			lines.push(
				{ key: "secretStore", value: config.secretStore },
				{ key: "path", value: config.path },
			);
			break;
		case "infisical-universal-auth":
			lines.push({ key: "path", value: config.path });
			if (config.apiBaseUrl !== undefined) {
				lines.push({ key: "apiBaseUrl", value: config.apiBaseUrl });
			}
			break;
		case "doppler-project":
			lines.push({ key: "configName", value: config.configName });
			break;
	}
	return { lines };
}

export const HoboAuthProviderLayer = AuthProviderLayer<
	HoboAuthProfileConfig,
	HoboAuthResolvedCredentials
>()(
	HOBO_AUTH_PROVIDER_NAME,
	Effect.gen(function* () {
		const broker = yield* HoboAuthCredentialBroker;

		return {
			configSchema: HoboAuthProfileConfigSchema,
			configureMethods: HOBO_AUTH_CONFIGURE_METHODS,
			configure: (profileName, currentConfig) =>
				currentConfig !== undefined
					? Effect.succeed(currentConfig)
					: Effect.fail(
							AuthError.make({
								message: `Configure profile '${profileName}' non-interactively via configureWith or hobo login --setup.`,
							}),
						),
			configureWith: (profileName, input) =>
				decodeConfiguredProfile(input.method, input.values).pipe(
					Effect.mapError((cause) =>
						AuthError.make({
							message: `Invalid ${HOBO_AUTH_PROVIDER_NAME} configuration for profile '${profileName}' (method '${input.method}'): ${cause.message}`,
							cause,
						}),
					),
				),
			login: (profileName, config, updateConfig) =>
				Effect.gen(function* () {
					const refreshed = yield* broker.refreshForProfile({
						profileName,
						config,
					});
					if (updateConfig !== undefined) {
						yield* updateConfig(refreshed);
						return undefined;
					}
					return refreshed;
				}),
			logout: (profileName, config) =>
				broker.logoutForProfile({ profileName, config }),
			details: (profileName, config, updateConfig) =>
				Effect.gen(function* () {
					const resolved = yield* broker.resolveForProfile({
						profileName,
						config,
					});
					const effective = resolved.updatedConfig ?? config;
					if (
						resolved.updatedConfig !== undefined &&
						updateConfig !== undefined
					) {
						yield* updateConfig(resolved.updatedConfig);
					}
					return renderHoboAuthProfileDetails(profileName, effective);
				}),
			read: (profileName, config, updateConfig) =>
				Effect.gen(function* () {
					const resolved = yield* broker.resolveForProfile({
						profileName,
						config,
					});
					if (
						resolved.updatedConfig !== undefined &&
						updateConfig !== undefined
					) {
						yield* updateConfig(resolved.updatedConfig);
					}
					return resolved.credentials;
				}),
		};
	}),
);

export const HoboAuthCredentialsFromProviderLayer = Layer.effect(
	HoboAuthCredentials,
	lazyCredentials<HoboAuthResolvedCredentials>()(
		HOBO_AUTH_PROVIDER_NAME,
		(resolved) => resolved,
		{
			expiresAt: (resolved) => resolved.expiresAtMs,
		},
	),
);

export { AuthError, NeedsReauth };
